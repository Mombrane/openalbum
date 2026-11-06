import pg from "pg";
import type { Photo } from "../domain/library/model.js";
import { parsePhotoStatus } from "../domain/library/pipeline.js";
import type { PhotoRepository } from "../domain/library/ports.js";

const PHOTO_COLUMNS = `id, owner_id, object_key, thumb_key, content_type, byte_size,
taken_at, location_text, latitude, longitude, description, tags,
status, source_user_id, source_key_id, error_message, created_at, updated_at`;

const LIST_SQL = `SELECT ${PHOTO_COLUMNS}
FROM photos
WHERE owner_id = $1
  AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
ORDER BY created_at DESC, id DESC
LIMIT $4`;

const FIND_SQL = `SELECT ${PHOTO_COLUMNS}
FROM photos
WHERE id = $1`;

export function createPhotoRepository(pool: pg.Pool): PhotoRepository {
  return {
    async findById(id) {
      const result = await pool.query(FIND_SQL, [id]);
      return mapPhoto(result.rows[0]);
    },
    async listOwned(input) {
      const result = await pool.query(LIST_SQL, [
        input.ownerId,
        input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null,
        input.limit,
      ]);
      return result.rows.map((row) => mapPhoto(row)!);
    },
    async updateOwned(id, ownerId, patch, updatedAt) {
      const sets: string[] = [];
      const values: unknown[] = [id, ownerId];
      let index = 3;
      if ("description" in patch) {
        sets.push(`description = $${index++}`);
        values.push(patch.description);
      }
      if ("tags" in patch) {
        sets.push(`tags = $${index++}`);
        values.push(patch.tags);
      }
      if ("takenAt" in patch) {
        sets.push(`taken_at = $${index++}`);
        values.push(patch.takenAt);
      }
      if ("locationText" in patch) {
        sets.push(`location_text = $${index++}`);
        values.push(patch.locationText);
      }
      if ("latitude" in patch) {
        sets.push(`latitude = $${index++}`);
        values.push(patch.latitude);
      }
      if ("longitude" in patch) {
        sets.push(`longitude = $${index++}`);
        values.push(patch.longitude);
      }
      sets.push(`updated_at = $${index++}`);
      values.push(updatedAt);
      const result = await pool.query(
        `UPDATE photos SET ${sets.join(", ")} WHERE id = $1 AND owner_id = $2
         RETURNING ${PHOTO_COLUMNS}`,
        values,
      );
      return mapPhoto(result.rows[0]);
    },
    async deleteOwned(id, ownerId) {
      const result = await pool.query(
        `DELETE FROM photos
         WHERE id = $1 AND owner_id = $2
         RETURNING object_key, thumb_key`,
        [id, ownerId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return { objectKey: row.object_key as string, thumbKey: (row.thumb_key as string | null) ?? null };
    },
  };
}

function mapPhoto(row: Record<string, unknown> | undefined): Photo | null {
  if (!row) return null;
  const byteSize = toSafeInteger(row.byte_size, "byte_size");
  const tags = row.tags;
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    objectKey: String(row.object_key),
    thumbKey: row.thumb_key == null ? null : String(row.thumb_key),
    contentType: String(row.content_type ?? ""),
    byteSize,
    takenAt: (row.taken_at as Date | null) ?? null,
    locationText: row.location_text == null ? null : String(row.location_text),
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    description: row.description == null ? null : String(row.description),
    tags: Array.isArray(tags) ? tags.map(String) : [],
    status: parsePhotoStatus(String(row.status)),
    sourceUserId: row.source_user_id == null ? null : String(row.source_user_id),
    sourceKeyId: row.source_key_id == null ? null : String(row.source_key_id),
    errorCode: row.error_message == null ? null : String(row.error_message),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function toSafeInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${field} 超出安全整数范围`);
  }
  return number;
}
