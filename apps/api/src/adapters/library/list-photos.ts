import { encodePhotoCursor } from "../../domain/library/cursor.js";
import type { LibraryActor } from "../../domain/library/model.js";
import type { LibraryDeps } from "./deps.js";
import { errorName } from "./error-name.js";
import type { LibraryResult } from "./messages.js";
import { storageError } from "./messages.js";
import { toPhotoResponse, type PhotoResponse } from "./photo-response.js";

export async function listPhotos(
  deps: LibraryDeps,
  actor: LibraryActor,
  query: { limit: number; cursor: { createdAt: Date; id: string } | null },
  now: Date,
): Promise<LibraryResult<{ photos: PhotoResponse[]; nextCursor: string | null }>> {
  const rows = await deps.photos.listOwned({
    ownerId: actor.userId,
    limit: query.limit + 1,
    cursor: query.cursor,
  });
  const page = rows.slice(0, query.limit);
  const hasMore = rows.length > query.limit;
  const photos: PhotoResponse[] = [];
  for (const photo of page) {
    try {
      photos.push(await toPhotoResponse(deps, photo, now));
    } catch (error) {
      deps.log.warn("对象存储失败", {
        userId: actor.userId,
        photoId: photo.id,
        objectKey: photo.objectKey,
        errorName: errorName(error),
      });
      return storageError();
    }
  }
  const last = page.at(-1);
  const nextCursor = hasMore && last ? encodePhotoCursor(last.createdAt, last.id) : null;
  return { ok: true, status: 200, body: { photos, nextCursor } };
}
