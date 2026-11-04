import { validatePartsForComplete } from "../../domain/library/index.js";
import type { LibraryActor, UploadPartRecord, UploadSession } from "../../domain/library/model.js";
import { isVisiblePhoto } from "../../domain/library/visibility.js";
import { abortLocked } from "./abort-locked.js";
import type { LibraryDeps } from "./deps.js";
import { errorName } from "./error-name.js";
import type { LibraryResult } from "./messages.js";
import {
  badPart,
  notFound,
  storageError,
  uploadClosed,
  uploadCompleting,
  uploadIncomplete,
} from "./messages.js";
import { toPhotoResponse, type PhotoResponse } from "./photo-response.js";

export async function completeUpload(
  deps: LibraryDeps,
  actor: LibraryActor,
  sessionId: string,
  now: Date,
): Promise<LibraryResult<{ photo: PhotoResponse }>> {
  let early: LibraryResult<{ photo: PhotoResponse }> | null = null;
  let sessionSnapshot: UploadSession | undefined;
  let parts: UploadPartRecord[] = [];
  let needStorage = false;
  let skipToInsert = false;
  let expireAfter = false;

  await deps.sessions.transactById(sessionId, async (row, tx) => {
    if (!row || row.ownerId !== actor.userId) {
      early = notFound();
      return;
    }
    sessionSnapshot = row ?? undefined;
    parts = await tx.listParts(sessionId);

    if (row.status === "aborted") {
      early = uploadClosed();
      return;
    }
    if (row.status === "completed") {
      const photo = await deps.photos.findById(row.photoId);
      if (!photo || !isVisiblePhoto(photo, actor.userId)) {
        early = notFound();
        return;
      }
      early = { ok: true, status: 200, body: { photo: await toPhotoResponse(deps, photo, now) } };
      return;
    }
    if (row.objectCompletedAt !== null) {
      skipToInsert = true;
      return;
    }
    if (row.status === "open" && row.expiresAt <= now) {
      expireAfter = true;
      return;
    }
    if (row.status === "open") {
      const check = validatePartsForComplete(
        parts.map((part) => ({ partNumber: part.partNumber, byteSize: part.byteSize })),
        row.byteSize,
      );
      if (check !== "ok") {
        early = badPart();
        return;
      }
      await tx.setCompleting(sessionId, now);
      needStorage = true;
      return;
    }
    if (row.status === "completing") {
      needStorage = true;
    }
  });

  if (early) return early;

  if (expireAfter) {
    const aborted = await abortLocked(deps, actor, sessionId, now);
    if (aborted === "storage_error") return storageError();
    if (aborted === "completing") return uploadCompleting();
    return uploadClosed();
  }

  if (!sessionSnapshot) return notFound();
  const current = sessionSnapshot;

  if (needStorage && !skipToInsert) {
    const lock = await deps.sessions.tryCompletionLock(sessionId);
    if (!lock) return uploadCompleting();
    try {
      const sorted = [...parts].sort((left, right) => left.partNumber - right.partNumber);
      try {
        await deps.storage.completeMultipartUpload({
          key: current.objectKey,
          uploadId: current.s3UploadId,
          parts: sorted.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
        });
        await deps.sessions.markObjectCompleted(sessionId, now);
      } catch (error) {
        const name = errorName(error);
        if (name === "NoSuchUpload") {
          const head = await deps.storage.headObject({ key: current.objectKey });
          if (head?.byteSize === current.byteSize) {
            await deps.sessions.markObjectCompleted(sessionId, now);
          } else {
            const reopened = await deps.sessions.reopenIfNoObject(sessionId, now);
            if (reopened === "reopened") {
              deps.log.warn("对象存储失败", {
                userId: actor.userId,
                photoId: current.photoId,
                objectKey: current.objectKey,
                uploadSessionId: sessionId,
                errorName: name,
              });
              return storageError();
            }
          }
        } else {
          const reopened = await deps.sessions.reopenIfNoObject(sessionId, now);
          if (reopened === "reopened") {
            deps.log.warn("对象存储失败", {
              userId: actor.userId,
              photoId: current.photoId,
              objectKey: current.objectKey,
              uploadSessionId: sessionId,
              errorName: name,
            });
            return storageError();
          }
        }
      }
    } finally {
      await lock.release();
    }
  }

  try {
    const inserted = await deps.sessions.insertPhotoAndComplete({
      sessionId,
      photoId: current.photoId,
      ownerId: current.ownerId,
      objectKey: current.objectKey,
      contentType: current.contentType,
      byteSize: current.byteSize,
      sourceUserId: actor.userId,
      sourceKeyId: actor.credentialKind === "api_key" ? actor.credentialId : null,
      now,
    });
    const photo = await deps.photos.findById(current.photoId);
    if (!photo || !isVisiblePhoto(photo, actor.userId)) return notFound();
    let photoResponse: PhotoResponse;
    try {
      photoResponse = await toPhotoResponse(deps, photo, now);
    } catch (presignError) {
      deps.log.warn("对象存储失败", {
        userId: actor.userId,
        photoId: current.photoId,
        objectKey: current.objectKey,
        uploadSessionId: sessionId,
        errorName: errorName(presignError),
      });
      return storageError();
    }
    const body = { photo: photoResponse };
    if (inserted === "inserted") return { ok: true, status: 201, body };
    return { ok: true, status: 200, body };
  } catch (error) {
    deps.log.warn("上传未能完成", {
      userId: actor.userId,
      photoId: current.photoId,
      objectKey: current.objectKey,
      uploadSessionId: sessionId,
      errorName: errorName(error),
    });
    return uploadIncomplete();
  }
}
