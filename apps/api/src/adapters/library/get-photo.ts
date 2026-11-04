import type { LibraryActor } from "../../domain/library/model.js";
import { isVisiblePhoto } from "../../domain/library/visibility.js";
import type { LibraryDeps } from "./deps.js";
import type { LibraryResult } from "./messages.js";
import { notFound } from "./messages.js";
import { toPhotoResponse, type PhotoResponse } from "./photo-response.js";

export async function getPhoto(
  deps: LibraryDeps,
  actor: LibraryActor,
  photoId: string,
  now: Date,
): Promise<LibraryResult<{ photo: PhotoResponse }>> {
  const photo = await deps.photos.findById(photoId);
  if (!photo || !isVisiblePhoto(photo, actor.userId)) return notFound();
  const body = { photo: await toPhotoResponse(deps, photo, now) };
  return { ok: true, status: 200, body };
}
