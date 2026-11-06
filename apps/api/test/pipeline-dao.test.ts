import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import type { User } from "../src/domain/identity/model.js";
import { createPhotoRepository } from "../src/dao/photo-repository.js";
import { createPipelineStore } from "../src/dao/pipeline-store.js";
import { createUploadSessionRepository } from "../src/dao/upload-session-repository.js";
import { createUserRepository } from "../src/dao/user-repository.js";
import { formatVectorLiteral } from "../src/dao/vector-literal.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";

const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
const now = new Date("2030-06-01T00:00:00.000Z");
const ownerId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const photoId = "33333333-3333-4333-8333-333333333333";
const jobId = "55555555-5555-4555-8555-555555555555";

let tail: Promise<unknown> = Promise.resolve();
function serial(name: string, fn: () => Promise<void>): void {
  test(name, () => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  });
}

test.before(async () => {
  await applySchema(pool);
});

test.after(async () => {
  await pool.end();
});

async function reset(): Promise<void> {
  await pool.query("TRUNCATE TABLE users CASCADE");
}

async function seedPhoto(): Promise<void> {
  await reset();
  const users = createUserRepository(pool);
  const user: User = { id: ownerId, email: "pipe@example.com", passwordHash: "hash", createdAt: now };
  assert.equal(await users.insert(user), "ok");
  const sessions = createUploadSessionRepository(pool);
  await sessions.insert({
    id: sessionId,
    ownerId,
    photoId,
    objectKey: `owners/${ownerId}/photos/${photoId}/original`,
    contentType: "image/jpeg",
    byteSize: 4,
    s3UploadId: "upload-1",
    expiresAt: new Date(now.getTime() + 86_400_000),
    createdAt: now,
  });
  await sessions.transactById(sessionId, async (_row, tx) => {
    await tx.setCompleting(sessionId, now);
  });
  await sessions.markObjectCompleted(sessionId, now);
  assert.equal(
    await sessions.insertPhotoAndComplete({
      sessionId,
      photoId,
      ownerId,
      objectKey: `owners/${ownerId}/photos/${photoId}/original`,
      contentType: "image/jpeg",
      byteSize: 4,
      sourceUserId: ownerId,
      sourceKeyId: null,
      now,
      jobId,
    }),
    "inserted",
  );
}

function vector(length: number, first = 0.01): number[] {
  return Array.from({ length }, (_item, index) => (index === 0 ? first : 0));
}

serial("首次完成同一事务插入 process_photo，重复完成不新增", async () => {
  await seedPhoto();
  const jobs = await pool.query(
    `SELECT type, payload->>'step' AS step, status, attempts FROM jobs WHERE photo_id = $1`,
    [photoId],
  );
  assert.equal(jobs.rowCount, 1);
  assert.equal(jobs.rows[0].type, "process_photo");
  assert.equal(jobs.rows[0].step, "exif");
  assert.equal(jobs.rows[0].status, "pending");
  assert.equal(jobs.rows[0].attempts, 0);
  const sessions = createUploadSessionRepository(pool);
  assert.equal(
    await sessions.insertPhotoAndComplete({
      sessionId,
      photoId,
      ownerId,
      objectKey: `owners/${ownerId}/photos/${photoId}/original`,
      contentType: "image/jpeg",
      byteSize: 4,
      sourceUserId: ownerId,
      sourceKeyId: null,
      now,
      jobId: "55555555-5555-4555-8555-555555555556",
    }),
    "exists",
  );
  const again = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1`, [photoId]);
  assert.equal(again.rows[0].n, 1);
});

serial("领取加一 attempts，第二张到期任务要等下一次", async () => {
  await seedPhoto();
  const store = createPipelineStore(pool);
  const otherPhoto = "33333333-3333-4333-8333-333333333334";
  const otherJob = "55555555-5555-4555-8555-555555555557";
  await pool.query(
    `INSERT INTO photos (
       id, owner_id, object_key, content_type, byte_size, tags, status, created_at, updated_at
     ) VALUES ($1, $2, $3, 'image/jpeg', 4, '{}', 'processing', $4, $4)`,
    [otherPhoto, ownerId, `owners/${ownerId}/photos/${otherPhoto}/original`, now],
  );
  await pool.query(
    `INSERT INTO jobs (id, type, photo_id, payload, status, run_after, created_at, updated_at)
     VALUES ($1, 'process_photo', $2, '{"step":"exif"}'::jsonb, 'pending', $3, $3, $3)`,
    [otherJob, otherPhoto, new Date(now.getTime() + 60_000)],
  );
  const claimed = await store.claim(now, 2);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, jobId);
  assert.equal(claimed[0].attempts, 1);
  assert.equal(claimed[0].step, "exif");
  assert.equal(claimed[0].lockedAt.toISOString(), now.toISOString());
  const pending = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [otherJob]);
  assert.equal(pending.rows[0].status, "pending");
});

serial("租约回收不把 vision_unavailable 改成 interrupted", async () => {
  await seedPhoto();
  const lockedAt = new Date(now.getTime() - 600_000);
  await pool.query(
    `UPDATE jobs
     SET status = 'running', attempts = 5, last_error = 'vision_unavailable', locked_at = $2, updated_at = $2
     WHERE id = $1`,
    [jobId, lockedAt],
  );
  await pool.query(
    `UPDATE photos SET error_message = 'vision_unavailable', updated_at = $2 WHERE id = $1`,
    [photoId, lockedAt],
  );
  const store = createPipelineStore(pool);
  const reclaimed = await store.reclaimExpired(now);
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].attempts, 5);
  assert.equal(reclaimed[0].lastError, "vision_unavailable");
  const job = await pool.query(`SELECT status, last_error, locked_at FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(job.rows[0].status, "failed");
  assert.equal(job.rows[0].last_error, "vision_unavailable");
  assert.equal(job.rows[0].locked_at, null);
  const photo = await pool.query(`SELECT status, error_message FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].status, "failed");
  assert.equal(photo.rows[0].error_message, "vision_unavailable");
  const interrupted = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM jobs WHERE last_error = 'interrupted') +
       (SELECT count(*)::int FROM photos WHERE error_message = 'interrupted') AS n`,
  );
  assert.equal(interrupted.rows[0].n, 0);
});

serial("向量字面量拒绝科学计数法、坏维度和 NaN", () => {
  assert.equal(formatVectorLiteral([0.01, -0.02], 2), "[0.01,-0.02]");
  assert.equal(/[eE]/.test(formatVectorLiteral([1e-7], 1)), false);
  assert.equal(formatVectorLiteral([1e-7], 1), "[0.0000001]");
  assert.throws(() => formatVectorLiteral([1], 2), (error: unknown) => (error as { name?: string }).name === "DimensionMismatch");
  assert.throws(() => formatVectorLiteral([Number.NaN], 1), (error: unknown) => (error as { name?: string }).name === "InvalidEmbedding");
  assert.throws(() => formatVectorLiteral([1e21], 1), (error: unknown) => (error as { name?: string }).name === "InvalidEmbedding");
  assert.throws(() => formatVectorLiteral([-1e21], 1), (error: unknown) => (error as { name?: string }).name === "InvalidEmbedding");
});

serial("嵌入提交写入 1536 维并在文本变化时回滚", async () => {
  await seedPhoto();
  const store = createPipelineStore(pool);
  const claimed = await store.claim(now, 1);
  const values = vector(1536);
  const written = await store.commitEmbedding(
    {
      jobId: claimed[0].id,
      lockedAt: claimed[0].lockedAt,
      photoId,
      jobType: "process_photo",
      values,
      dimensions: 1536,
      model: "embed-test",
      now,
    },
    () => "need_thumbnail",
  );
  assert.equal(written, "need_thumbnail");
  const none = await pool.query(`SELECT count(*)::int AS n FROM photo_embeddings WHERE photo_id = $1`, [photoId]);
  assert.equal(none.rows[0].n, 0);
  const stillRunning = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(stillRunning.rows[0].status, "running");

  await pool.query(`UPDATE photos SET thumb_key = $2 WHERE id = $1`, [photoId, `owners/${ownerId}/photos/${photoId}/thumb`]);
  const done = await store.commitEmbedding(
    {
      jobId: claimed[0].id,
      lockedAt: claimed[0].lockedAt,
      photoId,
      jobType: "process_photo",
      values,
      dimensions: 1536,
      model: "embed-test",
      now,
    },
    () => "write",
  );
  assert.equal(done, "written");
  const embedding = await pool.query(`SELECT model, vector_dims(embedding) AS dims FROM photo_embeddings WHERE photo_id = $1`, [photoId]);
  assert.equal(embedding.rows[0].model, "embed-test");
  assert.equal(embedding.rows[0].dims, 1536);
  const job = await pool.query(`SELECT status, payload->>'step' AS step, last_error FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(job.rows[0].status, "done");
  assert.equal(job.rows[0].step, "done");
  assert.equal(job.rows[0].last_error, null);
  const photo = await pool.query(`SELECT status, error_message FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].status, "ready");
  assert.equal(photo.rows[0].error_message, null);
});
