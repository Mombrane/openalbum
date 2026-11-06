import { semanticChanged } from "../../domain/library/pipeline.js";
import type { LibraryActor, MetadataPatch, Photo } from "../../domain/library/model.js";
import { isVisiblePhoto } from "../../domain/library/visibility.js";
import type { LibraryDeps } from "./deps.js";
import { errorName } from "./error-name.js";
import type { LibraryResult } from "./messages.js";
import { notFound, patchIncomplete, storageError } from "./messages.js";
import { toPhotoResponse, type PhotoResponse } from "./photo-response.js";

export async function patchPhoto(
  deps: LibraryDeps,
  actor: LibraryActor,
  photoId: string,
  patch: MetadataPatch,
  now: Date,
): Promise<LibraryResult<{ photo: PhotoResponse }>> {
  const existing = await deps.photos.findById(photoId);
  if (!existing || !isVisiblePhoto(existing, actor.userId)) return notFound();
  if (Object.keys(patch).length === 0) return respond(deps, actor.userId, existing, now);
  let saved: Photo | null = null;
  let missing = false;
  try {
    await deps.photos.transactOwned(photoId, actor.userId, async (photo, tx) => {
      if (!photo || !isVisiblePhoto(photo, actor.userId)) {
        missing = true;
        return;
      }
      const next = await tx.update(patch, now);
      if (!next) {
        missing = true;
        return;
      }
      if (semanticChanged(photo, patch)) {
        const active = await tx.activeJobs();
        const busy = active.some((job) => job.type === "process_photo" || job.type === "reembed");
        if (!busy) await tx.insertReembed({ id: deps.ids.nextId(), runAfter: now, now });
      }
      saved = next;
    });
  } catch (error) {
    deps.log.warn("修改未能完成", { userId: actor.userId, photoId, errorName: errorName(error) });
    return patchIncomplete();
  }
  if (missing || !saved) return notFound();
  return respond(deps, actor.userId, saved, now);
}

async function respond(deps: LibraryDeps, userId: string, photo: Photo, now: Date): Promise<LibraryResult<{ photo: PhotoResponse }>> {
  try {
    return { ok: true, status: 200, body: { photo: await toPhotoResponse(deps, photo, now) } };
  } catch (error) {
    deps.log.warn("对象存储失败", { userId, photoId: photo.id, objectKey: photo.objectKey, errorName: errorName(error) });
    return storageError();
  }
}
