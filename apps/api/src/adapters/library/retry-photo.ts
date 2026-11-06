import type { LibraryActor, Photo } from "../../domain/library/model.js";
import { isVisiblePhoto } from "../../domain/library/visibility.js";
import type { LibraryDeps } from "./deps.js";
import { errorName } from "./error-name.js";
import type { LibraryResult } from "./messages.js";
import { notFailed, notFound, patchIncomplete, storageError } from "./messages.js";
import { toPhotoResponse, type PhotoResponse } from "./photo-response.js";

export async function retryPhoto(
  deps: LibraryDeps,
  actor: LibraryActor,
  photoId: string,
  now: Date,
): Promise<LibraryResult<{ photo: PhotoResponse }>> {
  const state: { outcome: "missing" | "not_failed" | "ok"; saved: Photo | null } = {
    outcome: "missing",
    saved: null,
  };
  try {
    await deps.photos.transactOwned(photoId, actor.userId, async (photo, tx) => {
      if (!photo || !isVisiblePhoto(photo, actor.userId)) return;
      if (photo.status !== "failed") {
        state.outcome = "not_failed";
        return;
      }
      const reset = await tx.resetForRetry(now);
      if (!reset) return;
      await tx.deletePendingReembed();
      const active = await tx.activeJobs();
      if (!active.some((job) => job.type === "process_photo")) {
        await tx.insertProcessPhoto({ id: deps.ids.nextId(), runAfter: now, now });
      }
      state.saved = reset;
      state.outcome = "ok";
    });
  } catch (error) {
    deps.log.warn("修改未能完成", { userId: actor.userId, photoId, errorName: errorName(error) });
    return patchIncomplete();
  }
  if (state.outcome === "not_failed") return notFailed();
  if (state.outcome !== "ok" || !state.saved) return notFound();
  const saved = state.saved;
  try {
    return { ok: true, status: 200, body: { photo: await toPhotoResponse(deps, saved, now) } };
  } catch (error) {
    deps.log.warn("对象存储失败", { userId: actor.userId, photoId, objectKey: saved.objectKey, errorName: errorName(error) });
    return storageError();
  }
}
