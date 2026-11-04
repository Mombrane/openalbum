import type { LibraryActor, MetadataPatch } from "../../domain/library/model.js";
import { isVisiblePhoto } from "../../domain/library/visibility.js";
import type { LibraryDeps } from "./deps.js";
import type { LibraryResult } from "./messages.js";
import { notFound } from "./messages.js";
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
  if (Object.keys(patch).length === 0) {
    return { ok: true, status: 200, body: { photo: await toPhotoResponse(deps, existing, now) } };
  }
  const updated = await deps.photos.updateOwned(photoId, actor.userId, patch, now);
  if (!updated) return notFound();
  return { ok: true, status: 200, body: { photo: await toPhotoResponse(deps, updated, now) } };
}
