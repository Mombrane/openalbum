import pg from "pg";
import type { UploadPartRecord, UploadSession } from "../domain/library/model.js";
import type {
  CompletionLock,
  NewUploadSession,
  UploadSessionRepository,
  UploadSessionTx,
} from "../domain/library/ports.js";

const SESSION_COLUMNS = `id, owner_id, photo_id, object_key, content_type, byte_size, s3_upload_id,
       status, object_completed_at, expires_at, created_at, updated_at`;

export function completionLockKeys(sessionId: string): [number, number] {
  const hex = sessionId.replaceAll("-", "");
  const hi = Number.parseInt(hex.slice(0, 8), 16) | 0;
  const lo = Number.parseInt(hex.slice(8, 16), 16) | 0;
  return [hi, lo];
}

export function createUploadSessionRepository(pool: pg.Pool): UploadSessionRepository {
  return {
    async insert(session) {
      await pool.query(
        `INSERT INTO upload_sessions (
           id, owner_id, photo_id, object_key, content_type, byte_size, s3_upload_id,
           status, object_completed_at, expires_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', NULL, $8, $9, $9)`,
        insertParams(session),
      );
    },
    async listExpiredOpen(ownerId, at) {
      const result = await pool.query(
        `SELECT ${SESSION_COLUMNS}
         FROM upload_sessions
         WHERE owner_id = $1
           AND status = 'open'
           AND object_completed_at IS NULL
           AND expires_at <= $2`,
        [ownerId, at],
      );
      return result.rows.map((row) => mapSession(row)!);
    },
    async transactById(id, mutate) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query(
          `SELECT ${SESSION_COLUMNS}
           FROM upload_sessions
           WHERE id = $1
           FOR UPDATE`,
          [id],
        );
        const row = found.rows[0] ? mapSession(found.rows[0]) : null;
        const tx = createUploadSessionTx(client);
        await mutate(row, tx);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async tryCompletionLock(sessionId) {
      const [hi, lo] = completionLockKeys(sessionId);
      const client = await pool.connect();
      try {
        const locked = await client.query("SELECT pg_try_advisory_lock($1::int4, $2::int4) AS locked", [hi, lo]);
        if (locked.rows[0]?.locked !== true) {
          client.release();
          return null;
        }
        const lock: CompletionLock = {
          release: async () => {
            try {
              await client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", [hi, lo]);
            } finally {
              client.release();
            }
          },
        };
        return lock;
      } catch (error) {
        client.release();
        throw error;
      }
    },
    async markObjectCompleted(id, at) {
      await pool.query(
        `UPDATE upload_sessions
         SET object_completed_at = $2, updated_at = $2
         WHERE id = $1 AND object_completed_at IS NULL`,
        [id, at],
      );
    },
    async reopenIfNoObject(id, at) {
      const result = await pool.query(
        `UPDATE upload_sessions
         SET status = 'open', updated_at = $2
         WHERE id = $1 AND status = 'completing' AND object_completed_at IS NULL`,
        [id, at],
      );
      return result.rowCount === 1 ? "reopened" : "kept";
    },
    async insertPhotoAndComplete(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        try {
          await client.query(
            `INSERT INTO photos (
               id, owner_id, object_key, thumb_key, content_type, byte_size,
               taken_at, location_text, latitude, longitude, description, tags,
               status, source_user_id, source_key_id, error_message, created_at, updated_at
             ) VALUES (
               $1, $2, $3, NULL, $4, $5,
               NULL, NULL, NULL, NULL, NULL, '{}',
               'processing', $6, $7, NULL, $8, $8
             )`,
            [
              input.photoId,
              input.ownerId,
              input.objectKey,
              input.contentType,
              input.byteSize,
              input.sourceUserId,
              input.sourceKeyId,
              input.now,
            ],
          );
        } catch (error) {
          if (isUniqueViolation(error)) {
            await client.query("ROLLBACK");
            return "exists";
          }
          throw error;
        }
        await client.query(
          `INSERT INTO jobs (
             id, type, photo_id, payload, status, attempts, last_error, run_after, locked_at, created_at, updated_at
           ) VALUES (
             $1, 'process_photo', $2, '{"step":"exif"}'::jsonb, 'pending', 0, NULL, $3, NULL, $3, $3
           )`,
          [input.jobId, input.photoId, input.now],
        );
        const updated = await client.query(
          `UPDATE upload_sessions
           SET status = 'completed', updated_at = $2
           WHERE id = $1
             AND status = 'completing'
             AND object_completed_at IS NOT NULL`,
          [input.sessionId, input.now],
        );
        if (updated.rowCount !== 1) {
          throw new Error("upload session 未能完成");
        }
        await client.query("COMMIT");
        return "inserted";
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function createUploadSessionTx(client: pg.PoolClient): UploadSessionTx {
  return {
    async listParts(sessionId) {
      const result = await client.query(
        `SELECT part_number, etag, byte_size
         FROM upload_parts
         WHERE upload_session_id = $1
         ORDER BY part_number ASC`,
        [sessionId],
      );
      return result.rows.map(
        (row): UploadPartRecord => ({
          partNumber: Number(row.part_number),
          etag: String(row.etag),
          byteSize: toSafeInteger(row.byte_size, "byte_size"),
        }),
      );
    },
    async upsertPart(sessionId, part) {
      await client.query(
        `INSERT INTO upload_parts (upload_session_id, part_number, etag, byte_size, created_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (upload_session_id, part_number) DO UPDATE
         SET etag = EXCLUDED.etag, byte_size = EXCLUDED.byte_size, created_at = now()`,
        [sessionId, part.partNumber, part.etag, part.byteSize],
      );
    },
    async setCompleting(sessionId, at) {
      const result = await client.query(
        `UPDATE upload_sessions
         SET status = 'completing', updated_at = $2
         WHERE id = $1 AND status = 'open'`,
        [sessionId, at],
      );
      if (result.rowCount !== 1) {
        throw new Error("upload session 未能进入 completing");
      }
    },
    async markAborted(sessionId, at) {
      const result = await client.query(
        `UPDATE upload_sessions
         SET status = 'aborted', updated_at = $2
         WHERE id = $1 AND status = 'open' AND object_completed_at IS NULL`,
        [sessionId, at],
      );
      if (result.rowCount !== 1) {
        throw new Error("upload session 未能中止");
      }
    },
  };
}

function insertParams(session: NewUploadSession): unknown[] {
  return [
    session.id,
    session.ownerId,
    session.photoId,
    session.objectKey,
    session.contentType,
    session.byteSize,
    session.s3UploadId,
    session.expiresAt,
    session.createdAt,
  ];
}

function mapSession(row: Record<string, unknown>): UploadSession | null {
  if (!row) return null;
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    photoId: String(row.photo_id),
    objectKey: String(row.object_key),
    contentType: String(row.content_type),
    byteSize: toSafeInteger(row.byte_size, "byte_size"),
    s3UploadId: String(row.s3_upload_id),
    status: row.status as UploadSession["status"],
    objectCompletedAt: (row.object_completed_at as Date | null) ?? null,
    expiresAt: row.expires_at as Date,
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

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
