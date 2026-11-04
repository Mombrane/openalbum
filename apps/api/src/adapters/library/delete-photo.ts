import type { LibraryActor } from "../../domain/library/model.js";
import type { LibraryDeps } from "./deps.js";
import { errorName } from "./error-name.js";
import type { LibraryResult } from "./messages.js";
import { deleteIncomplete, notFound } from "./messages.js";

export async function deletePhoto(
  deps: LibraryDeps,
  actor: LibraryActor,
  photoId: string,
): Promise<LibraryResult<undefined>> {
  let deleted: { objectKey: string; thumbKey: string | null } | null;
  try {
    deleted = await deps.photos.deleteOwned(photoId, actor.userId);
  } catch (error) {
    deps.log.warn("删除未能完成", {
      userId: actor.userId,
      photoId,
      errorName: errorName(error),
    });
    return deleteIncomplete();
  }
  if (!deleted) return notFound();
  try {
    await deps.storage.deleteObject({ key: deleted.objectKey });
  } catch (error) {
    deps.log.warn("删除对象失败", {
      userId: actor.userId,
      photoId,
      objectKey: deleted.objectKey,
      errorName: errorName(error),
    });
  }
  if (deleted.thumbKey) {
    try {
      await deps.storage.deleteObject({ key: deleted.thumbKey });
    } catch (error) {
      deps.log.warn("删除对象失败", {
        userId: actor.userId,
        photoId,
        objectKey: deleted.thumbKey,
        errorName: errorName(error),
      });
    }
  }
  return { ok: true, status: 204, body: undefined };
}
