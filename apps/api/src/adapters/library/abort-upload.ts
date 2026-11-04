import type { LibraryActor } from "../../domain/library/model.js";
import { abortLocked } from "./abort-locked.js";
import type { LibraryDeps } from "./deps.js";
import type { LibraryResult } from "./messages.js";
import { notFound, storageError, uploadCompleted, uploadCompleting } from "./messages.js";

export async function abortUpload(
  deps: LibraryDeps,
  actor: LibraryActor,
  sessionId: string,
  now: Date,
): Promise<LibraryResult<undefined>> {
  const outcome = await abortLocked(deps, actor, sessionId, now);
  if (outcome === "missing") return notFound();
  if (outcome === "completing") return uploadCompleting();
  if (outcome === "completed") return uploadCompleted();
  if (outcome === "storage_error") return storageError();
  return { ok: true, status: 204, body: undefined };
}
