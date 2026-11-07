import pg from "pg";
import type { Photo } from "../domain/library/model.js";
import { parsePhotoStatus } from "../domain/library/pipeline.js";
import type { ActiveJob, PhotoMutation, PhotoRepository } from "../domain/library/ports.js";

export const PHOTO_COLUMNS = `id, owner_id, object_key, thumb_key, content_type, byte_size,
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
      return mapPhotoRow(result.rows[0]);
    },
    async listOwned(input) {
      const result = await pool.query(LIST_SQL, [
        input.ownerId,
        input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null,
        input.limit,
      ]);
      return result.rows.map((row) => mapPhotoRow(row)!);
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
      return mapPhotoRow(result.rows[0]);
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
    async ensureProcessPhoto(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const photo = await client.query(`SELECT status FROM photos WHERE id = $1 FOR UPDATE`, [input.photoId]);
        if (photo.rows[0]?.status !== "processing") {
          await client.query("COMMIT");
          return "skipped";
        }
        const existing = await client.query(
          `SELECT 1 FROM jobs WHERE photo_id = $1 AND type = 'process_photo' LIMIT 1`,
          [input.photoId],
        );
        if ((existing.rowCount ?? 0) > 0) {
          await client.query("COMMIT");
          return "skipped";
        }
        const inserted = await client.query(
          `INSERT INTO jobs (
             id, type, photo_id, payload, status, attempts, last_error, run_after, locked_at, created_at, updated_at
           ) VALUES (
             $1, 'process_photo', $2, '{"step":"exif"}'::jsonb, 'pending', 0, NULL, $3, NULL, $3, $3
           )
           ON CONFLICT (photo_id, type) WHERE status IN ('pending', 'running') DO NOTHING`,
          [input.jobId, input.photoId, input.now],
        );
        await client.query("COMMIT");
        return inserted.rowCount === 1 ? "inserted" : "skipped";
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async transactOwned(photoId, ownerId, mutate) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query(
          `SELECT ${PHOTO_COLUMNS} FROM photos WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
          [photoId, ownerId],
        );
        const tx = createPhotoMutation(client, photoId, ownerId);
        await mutate(mapPhotoRow(found.rows[0]), tx);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function createPhotoMutation(client: pg.PoolClient, photoId: string, ownerId: string): PhotoMutation {
  return {
    async update(patch, updatedAt) {
      const sets: string[] = [];
      const values: unknown[] = [photoId, ownerId];
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
      const result = await client.query(
        `UPDATE photos SET ${sets.join(", ")} WHERE id = $1 AND owner_id = $2 RETURNING ${PHOTO_COLUMNS}`,
        values,
      );
      return mapPhotoRow(result.rows[0]);
    },
    async activeJobs() {
      const result = await client.query(
        `SELECT type, status FROM jobs WHERE photo_id = $1 AND status IN ('pending', 'running')`,
        [photoId],
      );
      return result.rows.map((row) => ({
        type: row.type as ActiveJob["type"],
        status: row.status as ActiveJob["status"],
      }));
    },
    async insertReembed(job) {
      return insertJob(client, photoId, job, "reembed", "embed");
    },
    async insertProcessPhoto(job) {
      return insertJob(client, photoId, job, "process_photo", "exif");
    },
    async deletePendingReembed() {
      await client.query(
        `DELETE FROM jobs WHERE photo_id = $1 AND type = 'reembed' AND status = 'pending'`,
        [photoId],
      );
    },
    async resetForRetry(updatedAt) {
      const result = await client.query(
        `UPDATE photos
         SET status = 'processing', error_message = NULL, updated_at = $3
         WHERE id = $1 AND owner_id = $2 AND status = 'failed'
         RETURNING ${PHOTO_COLUMNS}`,
        [photoId, ownerId, updatedAt],
      );
      return mapPhotoRow(result.rows[0]);
    },
  };
}

async function insertJob(
  client: pg.PoolClient,
  photoId: string,
  job: { id: string; runAfter: Date; now: Date },
  type: "reembed" | "process_photo",
  step: "embed" | "exif",
): Promise<"inserted" | "conflict"> {
  const result = await client.query(
    `INSERT INTO jobs (
       id, type, photo_id, payload, status, attempts, last_error, run_after, locked_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4::jsonb, 'pending', 0, NULL, $5, NULL, $6, $6
     )
     ON CONFLICT (photo_id, type) WHERE status IN ('pending', 'running') DO NOTHING`,
    [job.id, type, photoId, JSON.stringify({ step }), job.runAfter, job.now],
  );
  return result.rowCount === 1 ? "inserted" : "conflict";
}

export function mapPhotoRow(row: Record<string, unknown> | undefined): Photo | null {
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
