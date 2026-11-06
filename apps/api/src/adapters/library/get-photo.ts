import type { LibraryActor } from "../../domain/library/model.js";
import { isVisiblePhoto } from "../../domain/library/visibility.js";
import type { LibraryDeps } from "./deps.js";
import { errorName } from "./error-name.js";
import type { LibraryResult } from "./messages.js";
import { notFound, storageError } from "./messages.js";
import { toPhotoResponse, type PhotoResponse } from "./photo-response.js";

export async function getPhoto(
  deps: LibraryDeps,
  actor: LibraryActor,
  photoId: string,
  now: Date,
): Promise<LibraryResult<{ photo: PhotoResponse }>> {
  const photo = await deps.photos.findById(photoId);
  if (!photo || !isVisiblePhoto(photo, actor.userId)) return notFound();
  try {
    return { ok: true, status: 200, body: { photo: await toPhotoResponse(deps, photo, now) } };
  } catch (error) {
    deps.log.warn("对象存储失败", { userId: actor.userId, photoId, objectKey: photo.objectKey, errorName: errorName(error) });
    return storageError();
  }
}
