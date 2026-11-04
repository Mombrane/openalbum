import { MAX_PHOTO_BYTES, normalizeContentType, photoObjectKey, UPLOAD_TTL_MS } from "../../domain/library/index.js";
import type { LibraryActor } from "../../domain/library/model.js";
import { abortLocked } from "./abort-locked.js";
import type { LibraryDeps } from "./deps.js";
import { errorName } from "./error-name.js";
import type { LibraryResult } from "./messages.js";
import { invalidSize, storageError, unsupportedType } from "./messages.js";

export type UploadSessionResponse = {
  id: string;
  photoId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  expiresAt: string;
  status: "open";
};

export async function createUpload(
  deps: LibraryDeps,
  actor: LibraryActor,
  input: { contentType: string; byteSize: number },
  now: Date,
): Promise<LibraryResult<{ upload: UploadSessionResponse }>> {
  const contentType = normalizeContentType(input.contentType);
  if (!contentType) return unsupportedType();
  if (!Number.isInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MAX_PHOTO_BYTES) {
    return invalidSize();
  }

  const expired = await deps.sessions.listExpiredOpen(actor.userId, now);
  for (const session of expired) {
    try {
      await abortLocked(deps, actor, session.id, now);
    } catch {
      deps.log.warn("清扫中止失败", {
        userId: actor.userId,
        photoId: session.photoId,
        objectKey: session.objectKey,
        uploadSessionId: session.id,
        reason: "expired",
      });
    }
  }

  const photoId = deps.ids.nextId();
  const sessionId = deps.ids.nextId();
  const objectKey = photoObjectKey(actor.userId, photoId);
  let uploadId: string;
  try {
    const created = await deps.storage.createMultipartUpload({ key: objectKey, contentType });
    uploadId = created.uploadId;
  } catch (error) {
    deps.log.warn("对象存储失败", {
      userId: actor.userId,
      photoId,
      objectKey,
      uploadSessionId: sessionId,
      errorName: errorName(error),
    });
    return storageError();
  }

  const expiresAt = new Date(now.getTime() + UPLOAD_TTL_MS);
  try {
    await deps.sessions.insert({
      id: sessionId,
      ownerId: actor.userId,
      photoId,
      objectKey,
      contentType,
      byteSize: input.byteSize,
      s3UploadId: uploadId,
      expiresAt,
      createdAt: now,
    });
  } catch (error) {
    try {
      await deps.storage.abortMultipartUpload({ key: objectKey, uploadId });
    } catch (abortError) {
      deps.log.warn("对象存储失败", {
        userId: actor.userId,
        photoId,
        objectKey,
        uploadSessionId: sessionId,
        errorName: errorName(abortError),
      });
    }
    deps.log.warn("对象存储失败", {
      userId: actor.userId,
      photoId,
      objectKey,
      uploadSessionId: sessionId,
      errorName: errorName(error),
    });
    return storageError();
  }

  return {
    ok: true,
    status: 201,
    body: {
      upload: {
        id: sessionId,
        photoId,
        objectKey,
        contentType,
        byteSize: input.byteSize,
        expiresAt: expiresAt.toISOString(),
        status: "open",
      },
    },
  };
}
