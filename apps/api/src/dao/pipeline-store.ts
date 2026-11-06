import pg from "pg";
import { PIPELINE_LEASE_MS, parseJobStep, type JobType } from "../domain/library/pipeline.js";
import type {
  ClaimedJob,
  EmbeddingPlan,
  JobRecord,
  PipelineStore,
  ReclaimedJob,
} from "../domain/library/ports.js";
import { mapPhotoRow } from "./photo-repository.js";
import { formatVectorLiteral } from "./vector-literal.js";

const PHOTO_COLUMNS = `id, owner_id, object_key, thumb_key, content_type, byte_size,
  taken_at, location_text, latitude, longitude, description, tags,
  status, source_user_id, source_key_id, error_message, created_at, updated_at`;

class LostLock extends Error {
  constructor() {
    super("lost");
    this.name = "LostLock";
  }
}

export function createPipelineStore(pool: pg.Pool): PipelineStore {
  return {
    async reclaimExpired(now) {
      return transaction(pool, async (client) => {
        const cutoff = new Date(now.getTime() - PIPELINE_LEASE_MS);
        const updated = await client.query(
          `UPDATE jobs
           SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
               run_after = CASE WHEN attempts >= 5 THEN run_after ELSE $2 END,
               locked_at = NULL,
               updated_at = $2
           WHERE status = 'running'
             AND locked_at IS NOT NULL
             AND locked_at <= $1
           RETURNING id, type, photo_id, attempts, last_error, status`,
          [cutoff, now],
        );
        const reclaimed: ReclaimedJob[] = [];
        for (const row of updated.rows) {
          if (row.status === "failed" && row.type === "process_photo") {
            await client.query(
              `UPDATE photos
               SET status = 'failed', updated_at = $2
               WHERE id = $1 AND status = 'processing'`,
              [row.photo_id, now],
            );
          }
          reclaimed.push({
            id: String(row.id),
            type: row.type as JobType,
            photoId: String(row.photo_id),
            attempts: Number(row.attempts),
            lastError: row.last_error == null ? null : String(row.last_error),
          });
        }
        return reclaimed;
      });
    },

    async claim(now, limit) {
      return transaction(pool, async (client) => {
        const result = await client.query(
          `UPDATE jobs
           SET status = 'running',
               attempts = attempts + 1,
               locked_at = $1,
               updated_at = $1
           WHERE id IN (
             SELECT id FROM jobs
             WHERE status = 'pending' AND run_after <= $1
             ORDER BY run_after, created_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT $2
           )
           RETURNING id, type, photo_id, payload, attempts, locked_at`,
          [now, limit],
        );
        return result.rows.map((row) => ({
          id: String(row.id),
          type: row.type as ClaimedJob["type"],
          photoId: String(row.photo_id),
          step: parseJobStep(row.payload),
          attempts: Number(row.attempts),
          lockedAt: row.locked_at as Date,
        }));
      });
    },

    async readPhoto(photoId) {
      const result = await pool.query(`SELECT ${PHOTO_COLUMNS} FROM photos WHERE id = $1`, [photoId]);
      return mapPhotoRow(result.rows[0]);
    },

    async listForPhoto(photoId) {
      const result = await pool.query(
        `SELECT id, type, photo_id, payload, status, attempts, last_error, run_after, locked_at
         FROM jobs WHERE photo_id = $1 ORDER BY created_at, id`,
        [photoId],
      );
      return result.rows.map(mapJob);
    },

    async applyExif(input) {
      return step(pool, async (client) => {
        await client.query(
          `UPDATE photos
           SET taken_at = CASE
                 WHEN taken_at IS NULL AND $2::timestamptz IS NOT NULL THEN $2::timestamptz
                 ELSE taken_at
               END,
               latitude = CASE
                 WHEN latitude IS NULL AND longitude IS NULL
                  AND $3::float8 IS NOT NULL AND $4::float8 IS NOT NULL THEN $3::float8
                 ELSE latitude
               END,
               longitude = CASE
                 WHEN latitude IS NULL AND longitude IS NULL
                  AND $3::float8 IS NOT NULL AND $4::float8 IS NOT NULL THEN $4::float8
                 ELSE longitude
               END,
               updated_at = $5
           WHERE id = $1`,
          [input.photoId, input.fill.takenAt ?? null, input.fill.latitude ?? null, input.fill.longitude ?? null, input.now],
        );
        await advance(client, input.jobId, input.lockedAt, "thumbnail", input.now);
      });
    },

    async noteThumbPresent(input) {
      return step(pool, async (client) => {
        await advance(client, input.jobId, input.lockedAt, "vision", input.now);
      });
    },

    async commitThumb(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const updated = await client.query(
          `UPDATE photos
           SET thumb_key = $2, updated_at = $3
           WHERE id = $1 AND (thumb_key IS NULL OR thumb_key = $2)`,
          [input.photoId, input.thumbKey, input.now],
        );
        if (updated.rowCount !== 1) {
          const exists = await client.query(`SELECT 1 FROM photos WHERE id = $1`, [input.photoId]);
          await client.query("ROLLBACK");
          return exists.rowCount === 1 ? "conflict" : "missing";
        }
        const job = await client.query(
          `UPDATE jobs
           SET payload = '{"step":"vision"}'::jsonb, updated_at = $3
           WHERE id = $1 AND status = 'running' AND locked_at = $2`,
          [input.jobId, input.lockedAt, input.now],
        );
        if (job.rowCount !== 1) {
          await client.query("ROLLBACK");
          return "lost";
        }
        await client.query("COMMIT");
        return "ok";
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async skipVision(input) {
      return step(pool, async (client) => {
        await advance(client, input.jobId, input.lockedAt, "embed", input.now);
      });
    },

    async applyVision(input) {
      return step(pool, async (client) => {
        await client.query(
          `UPDATE photos
           SET description = CASE
                 WHEN description IS NULL AND $2::text IS NOT NULL THEN $2
                 ELSE description
               END,
               tags = CASE
                 WHEN tags = '{}'::text[] AND cardinality($3::text[]) > 0 THEN $3
                 ELSE tags
               END,
               updated_at = $4
           WHERE id = $1`,
          [input.photoId, input.description, input.tags, input.now],
        );
        await advance(client, input.jobId, input.lockedAt, "embed", input.now);
      });
    },

    async commitEmbedding(input, plan) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query(`SELECT ${PHOTO_COLUMNS} FROM photos WHERE id = $1 FOR UPDATE`, [input.photoId]);
        const photo = mapPhotoRow(found.rows[0]);
        if (!photo) {
          await client.query("ROLLBACK");
          return "missing";
        }
        const decision: EmbeddingPlan = plan(photo);
        if (decision !== "write") {
          await client.query("ROLLBACK");
          return decision;
        }
        const literal = formatVectorLiteral(input.values, input.dimensions);
        await client.query(
          `INSERT INTO photo_embeddings (photo_id, embedding, model, updated_at)
           VALUES ($1, $2::vector, $3, $4)
           ON CONFLICT (photo_id) DO UPDATE
           SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, updated_at = EXCLUDED.updated_at`,
          [input.photoId, literal, input.model, input.now],
        );
        if (input.jobType === "process_photo") {
          await client.query(
            `UPDATE photos SET status = 'ready', error_message = NULL, updated_at = $2 WHERE id = $1`,
            [input.photoId, input.now],
          );
        } else {
          await client.query(
            `UPDATE photos
             SET status = CASE WHEN thumb_key IS NOT NULL THEN 'ready' ELSE status END,
                 error_message = CASE WHEN thumb_key IS NOT NULL THEN NULL ELSE error_message END,
                 updated_at = $2
             WHERE id = $1`,
            [input.photoId, input.now],
          );
        }
        const job = await client.query(
          `UPDATE jobs
           SET status = 'done', payload = '{"step":"done"}'::jsonb, locked_at = NULL, last_error = NULL, updated_at = $3
           WHERE id = $1 AND status = 'running' AND locked_at = $2`,
          [input.jobId, input.lockedAt, input.now],
        );
        if (job.rowCount !== 1) {
          await client.query("ROLLBACK");
          return "lost";
        }
        await client.query("COMMIT");
        return "written";
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async rewindToThumbnail(input) {
      return step(pool, async (client) => {
        await advance(client, input.jobId, input.lockedAt, "thumbnail", input.now);
      });
    },

    async retryJob(input) {
      return step(pool, async (client) => {
        const job = await client.query(
          `UPDATE jobs
           SET status = 'pending', run_after = $4, locked_at = NULL, last_error = $3, updated_at = $5
           WHERE id = $1 AND status = 'running' AND locked_at = $2`,
          [input.jobId, input.lockedAt, input.code, input.runAfter, input.now],
        );
        if (job.rowCount !== 1) throw new LostLock();
        if (input.jobType === "process_photo") {
          await client.query(
            `UPDATE photos SET error_message = $2, updated_at = $3 WHERE id = $1 AND status = 'processing'`,
            [input.photoId, input.code, input.now],
          );
        }
      });
    },

    async failJob(input) {
      return step(pool, async (client) => {
        const job = await client.query(
          `UPDATE jobs
           SET status = 'failed', locked_at = NULL, last_error = $3, updated_at = $4
           WHERE id = $1 AND status = 'running' AND locked_at = $2`,
          [input.jobId, input.lockedAt, input.code, input.now],
        );
        if (job.rowCount !== 1) throw new LostLock();
        if (input.jobType === "process_photo") {
          await client.query(
            `UPDATE photos
             SET status = 'failed', error_message = $2, updated_at = $3
             WHERE id = $1 AND status = 'processing'`,
            [input.photoId, input.code, input.now],
          );
        }
      });
    },

    async releaseRunning(input) {
      return step(pool, async (client) => {
        const job = await client.query(
          `UPDATE jobs
           SET status = 'pending', run_after = $3, locked_at = NULL,
               attempts = GREATEST(attempts - 1, 0), updated_at = $3
           WHERE id = $1 AND status = 'running' AND locked_at = $2`,
          [input.jobId, input.lockedAt, input.now],
        );
        if (job.rowCount !== 1) throw new LostLock();
      });
    },
  };
}

function mapJob(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    type: row.type as JobRecord["type"],
    photoId: String(row.photo_id),
    step: parseJobStep(row.payload),
    status: row.status as JobRecord["status"],
    attempts: Number(row.attempts),
    lastError: row.last_error == null ? null : String(row.last_error),
    runAfter: row.run_after as Date,
    lockedAt: (row.locked_at as Date | null) ?? null,
  };
}

async function advance(client: pg.PoolClient, jobId: string, lockedAt: Date, stepName: string, now: Date): Promise<void> {
  const job = await client.query(
    `UPDATE jobs SET payload = $4::jsonb, updated_at = $3
     WHERE id = $1 AND status = 'running' AND locked_at = $2`,
    [jobId, lockedAt, now, JSON.stringify({ step: stepName })],
  );
  if (job.rowCount !== 1) throw new LostLock();
}

async function step(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<void>): Promise<"ok" | "lost"> {
  try {
    await transaction(pool, fn);
    return "ok";
  } catch (error) {
    if (error instanceof LostLock) return "lost";
    throw error;
  }
}

async function transaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
