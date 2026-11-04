import type { LibraryActor } from "../../domain/library/model.js";
import type { LibraryDeps } from "./deps.js";
import { errorName } from "./error-name.js";

export async function abortLocked(
  deps: LibraryDeps,
  actor: LibraryActor,
  sessionId: string,
  now: Date,
): Promise<"aborted" | "missing" | "completing" | "completed" | "storage_error"> {
  let outcome: "aborted" | "missing" | "completing" | "completed" | "storage_error" = "missing";
  await deps.sessions.transactById(sessionId, async (row, tx) => {
    if (!row || row.ownerId !== actor.userId) {
      outcome = "missing";
      return;
    }
    if (row.status === "completing" || (row.status === "open" && row.objectCompletedAt !== null)) {
      outcome = "completing";
      return;
    }
    if (row.status === "aborted") {
      outcome = "aborted";
      return;
    }
    if (row.status === "completed") {
      outcome = "completed";
      return;
    }
    try {
      await deps.storage.abortMultipartUpload({ key: row.objectKey, uploadId: row.s3UploadId });
    } catch (error) {
      if (errorName(error) !== "NoSuchUpload") {
        deps.log.warn("对象存储失败", {
          userId: actor.userId,
          photoId: row.photoId,
          objectKey: row.objectKey,
          uploadSessionId: row.id,
          reason: row.expiresAt <= now ? "expired" : "client",
          errorName: errorName(error),
        });
        outcome = "storage_error";
        throw error;
      }
    }
    await tx.markAborted(sessionId, now);
    outcome = "aborted";
  });
  return outcome;
}
