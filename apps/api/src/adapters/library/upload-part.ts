import { MAX_PHOTO_BYTES } from "../../domain/library/index.js";
import type { LibraryActor } from "../../domain/library/model.js";
import { abortLocked } from "./abort-locked.js";
import type { LibraryDeps } from "./deps.js";
import { errorName } from "./error-name.js";
import type { LibraryResult } from "./messages.js";
import { badPart, notFound, storageError, uploadClosed, uploadCompleted, uploadCompleting } from "./messages.js";

export async function uploadPart(
  deps: LibraryDeps,
  actor: LibraryActor,
  input: { sessionId: string; partNumber: number; body: Buffer },
  now: Date,
): Promise<LibraryResult<{ part: { partNumber: number; etag: string; byteSize: number } }>> {
  let early: LibraryResult<{ part: { partNumber: number; etag: string; byteSize: number } }> | null = null;
  let expireAfter = false;

  await deps.sessions.transactById(input.sessionId, async (row, tx) => {
    if (!row || row.ownerId !== actor.userId) {
      early = notFound();
      return;
    }
    if (row.status === "completing" || (row.status === "open" && row.objectCompletedAt !== null)) {
      early = uploadCompleting();
      return;
    }
    if (row.status === "aborted") {
      early = uploadClosed();
      return;
    }
    if (row.status === "completed") {
      early = uploadCompleted();
      return;
    }
    if (row.status === "open" && row.expiresAt <= now) {
      expireAfter = true;
      return;
    }

    const parts = await tx.listParts(input.sessionId);
    const sizes = new Map(parts.map((part) => [part.partNumber, part.byteSize]));
    sizes.set(input.partNumber, input.body.length);
    let sum = 0;
    for (const size of sizes.values()) sum += size;
    if (
      input.body.length < 1 ||
      input.body.length > MAX_PHOTO_BYTES ||
      sum > row.byteSize ||
      sum > MAX_PHOTO_BYTES
    ) {
      early = badPart();
      return;
    }

    try {
      const uploaded = await deps.storage.uploadPart({
        key: row.objectKey,
        uploadId: row.s3UploadId,
        partNumber: input.partNumber,
        body: input.body,
      });
      await tx.upsertPart(input.sessionId, {
        partNumber: input.partNumber,
        etag: uploaded.etag,
        byteSize: uploaded.byteSize,
      });
      early = {
        ok: true,
        status: 200,
        body: { part: { partNumber: input.partNumber, etag: uploaded.etag, byteSize: uploaded.byteSize } },
      };
    } catch (error) {
      deps.log.warn("对象存储失败", {
        userId: actor.userId,
        photoId: row.photoId,
        objectKey: row.objectKey,
        uploadSessionId: row.id,
        partNumber: input.partNumber,
        byteSize: input.body.length,
        errorName: errorName(error),
      });
      throw error;
    }
  });

  if (expireAfter) {
    const aborted = await abortLocked(deps, actor, input.sessionId, now);
    if (aborted === "storage_error") return storageError();
    if (aborted === "completing") return uploadCompleting();
    return uploadClosed();
  }

  if (early) return early;
  return storageError();
}
