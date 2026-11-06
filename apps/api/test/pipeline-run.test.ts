import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { runOnce } from "../src/adapters/pipeline/run-once.js";
import type { PipelineDeps } from "../src/adapters/pipeline/deps.js";
import type { PipelineLogFields } from "../src/domain/library/ports.js";
import { createPipelineStore } from "../src/dao/pipeline-store.js";
import { createUserRepository } from "../src/dao/user-repository.js";
import { createFakeEmbedGateway } from "../src/gateways/embed/fake-embed.js";
import { createFakeExifReader } from "../src/gateways/exif/fake-exif-reader.js";
import { createFakeObjectStorage } from "../src/gateways/storage/fake-object-storage.js";
import { createFakeThumbnailEncoder } from "../src/gateways/thumbnail/fake-encoder.js";
import { createFakeVisionGateway } from "../src/gateways/vision/fake-vision.js";
import type { User } from "../src/domain/identity/model.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";

const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
const now = new Date("2030-06-01T00:00:00.000Z");
const ownerId = "11111111-1111-4111-8111-111111111111";
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
  const users = createUserRepository(pool);
  const user: User = { id: ownerId, email: "run@example.com", passwordHash: "hash", createdAt: now };
  assert.equal(await users.insert(user), "ok");
}

async function insertPhoto(input: {
  id: string;
  description?: string | null;
  tags?: string[];
  takenAt?: Date | null;
  latitude?: number | null;
  longitude?: number | null;
  locationText?: string | null;
  status?: string;
  errorMessage?: string | null;
  thumbKey?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO photos (
       id, owner_id, object_key, thumb_key, content_type, byte_size, taken_at, location_text,
       latitude, longitude, description, tags, status, error_message, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'image/jpeg', 4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13
     )`,
    [
      input.id,
      ownerId,
      `owners/${ownerId}/photos/${input.id}/original`,
      input.thumbKey ?? null,
      input.takenAt ?? null,
      input.locationText ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
      input.description ?? null,
      input.tags ?? [],
      input.status ?? "processing",
      input.errorMessage ?? null,
      now,
    ],
  );
}

async function insertJob(input: {
  id: string;
  photoId: string;
  runAfter?: Date;
  status?: string;
  attempts?: number;
  lastError?: string | null;
  lockedAt?: Date | null;
  step?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO jobs (
       id, type, photo_id, payload, status, attempts, last_error, run_after, locked_at, created_at, updated_at
     ) VALUES ($1, 'process_photo', $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $9)`,
    [
      input.id,
      input.photoId,
      JSON.stringify({ step: input.step ?? "exif" }),
      input.status ?? "pending",
      input.attempts ?? 0,
      input.lastError ?? null,
      input.runAfter ?? now,
      input.lockedAt ?? null,
      now,
    ],
  );
}

function harness(options?: {
  vision?: ReturnType<typeof createFakeVisionGateway>;
  embed?: ReturnType<typeof createFakeEmbedGateway>;
  thumbnail?: ReturnType<typeof createFakeThumbnailEncoder>;
  exif?: ReturnType<typeof createFakeExifReader>;
}) {
  const storage = createFakeObjectStorage();
  const logs: Array<{ message: string; fields: PipelineLogFields }> = [];
  const vision = options?.vision ?? createFakeVisionGateway({ description: "海边", tags: ["海", "黄昏"] });
  const embed = options?.embed ?? createFakeEmbedGateway({ dimensions: 1536 });
  const thumbnail = options?.thumbnail ?? createFakeThumbnailEncoder();
  const exif = options?.exif ?? createFakeExifReader({ takenAt: new Date("2020-01-02T03:04:05.000Z"), latitude: 1.5, longitude: 2.5 });
  const deps: PipelineDeps = {
    store: createPipelineStore(pool),
    storage,
    exif,
    thumbnail,
    vision,
    embed,
    visionModel: "vision-test",
    embedModel: "embed-test",
    embedDimensions: 1536,
    log: {
      info(message, fields) {
        logs.push({ message, fields });
      },
      warn(message, fields) {
        logs.push({ message, fields });
      },
    },
  };
  return { deps, storage, logs, vision, embed, thumbnail };
}

serial("假网关把照片做成 ready", async () => {
  await reset();
  await insertPhoto({ id: photoId });
  await insertJob({ id: jobId, photoId });
  const { deps, storage } = harness();
  await deps.storage.putObject({ key: `owners/${ownerId}/photos/${photoId}/original`, contentType: "image/jpeg", body: Buffer.from("orig") });
  storage.putObjectCalls = 0;
  await runOnce(deps, now, 2);
  const photo = await pool.query(`SELECT status, error_message, thumb_key, taken_at, latitude, longitude, description, tags FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].status, "ready");
  assert.equal(photo.rows[0].error_message, null);
  assert.equal(photo.rows[0].thumb_key, `owners/${ownerId}/photos/${photoId}/thumb`);
  assert.equal(photo.rows[0].description, "海边");
  assert.deepEqual(photo.rows[0].tags, ["海", "黄昏"]);
  const thumb = await storage.getObject({ key: photo.rows[0].thumb_key });
  assert.ok((thumb?.byteSize ?? 0) >= 1);
  const embedding = await pool.query(`SELECT model, vector_dims(embedding) AS dims FROM photo_embeddings WHERE photo_id = $1`, [photoId]);
  assert.equal(embedding.rows[0].model, "embed-test");
  assert.equal(embedding.rows[0].dims, 1536);
});

serial("已有拍摄时间和坐标不被 EXIF 覆盖", async () => {
  await reset();
  const taken = new Date("2019-01-01T00:00:00.000Z");
  await insertPhoto({ id: photoId, takenAt: taken, latitude: 9, longitude: 8, locationText: "用户地点" });
  await insertJob({ id: jobId, photoId });
  const { deps } = harness();
  await deps.storage.putObject({ key: `owners/${ownerId}/photos/${photoId}/original`, contentType: "image/jpeg", body: Buffer.from("orig") });
  await runOnce(deps, now, 2);
  const photo = await pool.query(`SELECT taken_at, latitude, longitude, location_text FROM photos WHERE id = $1`, [photoId]);
  assert.equal(new Date(photo.rows[0].taken_at).toISOString(), taken.toISOString());
  assert.equal(Number(photo.rows[0].latitude), 9);
  assert.equal(Number(photo.rows[0].longitude), 8);
  assert.equal(photo.rows[0].location_text, "用户地点");
});

serial("已有描述和标签时不调用视觉", async () => {
  await reset();
  await insertPhoto({ id: photoId, description: "用户", tags: ["自己的"] });
  await insertJob({ id: jobId, photoId });
  const vision = createFakeVisionGateway({ description: "模型", tags: ["模型"] });
  const { deps } = harness({ vision });
  await deps.storage.putObject({ key: `owners/${ownerId}/photos/${photoId}/original`, contentType: "image/jpeg", body: Buffer.from("orig") });
  await runOnce(deps, now, 2);
  assert.equal(vision.calls, 0);
  const photo = await pool.query(`SELECT description, tags FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].description, "用户");
  assert.deepEqual(photo.rows[0].tags, ["自己的"]);
});

serial("视觉两次不可用后第三次成功，退避不睡眠", async () => {
  await reset();
  await insertPhoto({ id: photoId });
  await insertJob({ id: jobId, photoId });
  const vision = createFakeVisionGateway({ failuresBeforeSuccess: 2, description: "海边", tags: ["海"] });
  const { deps } = harness({ vision });
  await deps.storage.putObject({ key: `owners/${ownerId}/photos/${photoId}/original`, contentType: "image/jpeg", body: Buffer.from("orig") });
  await runOnce(deps, now, 2);
  const first = await pool.query(`SELECT status, attempts, run_after FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(first.rows[0].status, "pending");
  assert.equal(first.rows[0].attempts, 1);
  assert.equal(new Date(first.rows[0].run_after).toISOString(), new Date(now.getTime() + 30_000).toISOString());
  const processing = await pool.query(`SELECT status, error_message FROM photos WHERE id = $1`, [photoId]);
  assert.equal(processing.rows[0].status, "processing");
  assert.equal(processing.rows[0].error_message, "vision_unavailable");
  const secondNow = new Date(now.getTime() + 30_000);
  await runOnce(deps, secondNow, 2);
  const second = await pool.query(`SELECT status, attempts FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(second.rows[0].attempts, 2);
  assert.notEqual(second.rows[0].status, "done");
  await runOnce(deps, new Date(secondNow.getTime() + 60_000), 2);
  const photo = await pool.query(`SELECT status FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].status, "ready");
});

serial("错误维度与 NaN 不写向量", async () => {
  await reset();
  await insertPhoto({ id: photoId });
  await insertJob({ id: jobId, photoId });
  const embed = createFakeEmbedGateway({ values: [1, 2, 3] });
  const { deps, storage } = harness({ embed });
  const key = `owners/${ownerId}/photos/${photoId}/original`;
  await storage.putObject({ key, contentType: "image/jpeg", body: Buffer.from("orig") });
  await runOnce(deps, now, 2);
  const rows = await pool.query(`SELECT count(*)::int AS n FROM photo_embeddings WHERE photo_id = $1`, [photoId]);
  assert.equal(rows.rows[0].n, 0);
  const job = await pool.query(`SELECT status, last_error FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(job.rows[0].status, "failed");
  assert.equal(job.rows[0].last_error, "dimension_mismatch");
  const photo = await pool.query(`SELECT status, error_message FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].status, "failed");
  assert.equal(photo.rows[0].error_message, "dimension_mismatch");
  assert.equal((await storage.getObject({ key }))?.body.toString(), "orig");

  await reset();
  await insertPhoto({ id: photoId });
  await insertJob({ id: jobId, photoId });
  const nan = createFakeEmbedGateway({ nan: true });
  const again = harness({ embed: nan });
  await again.storage.putObject({ key, contentType: "image/jpeg", body: Buffer.from("orig") });
  await runOnce(again.deps, now, 2);
  const nanJob = await pool.query(`SELECT last_error FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(nanJob.rows[0].last_error, "invalid_embedding");
  const nanRows = await pool.query(`SELECT count(*)::int AS n FROM photo_embeddings WHERE photo_id = $1`, [photoId]);
  assert.equal(nanRows.rows[0].n, 0);
});

serial("缩略图解码失败立即终态", async () => {
  await reset();
  await insertPhoto({ id: photoId });
  await insertJob({ id: jobId, photoId });
  const thumbnail = createFakeThumbnailEncoder({ fail: true });
  const { deps } = harness({ thumbnail });
  await deps.storage.putObject({ key: `owners/${ownerId}/photos/${photoId}/original`, contentType: "image/jpeg", body: Buffer.from("orig") });
  await runOnce(deps, now, 2);
  const job = await pool.query(`SELECT status, attempts FROM jobs WHERE photo_id = $1`, [photoId]);
  assert.equal(job.rowCount, 1);
  assert.equal(job.rows[0].status, "failed");
  assert.equal(job.rows[0].attempts, 1);
  const photo = await pool.query(`SELECT status, error_message FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].status, "failed");
  assert.equal(photo.rows[0].error_message, "thumbnail_failed");
});

serial("租约回收保留 vision_unavailable，日志才出现 interrupted", async () => {
  await reset();
  await insertPhoto({ id: photoId, errorMessage: "vision_unavailable" });
  const lockedAt = new Date(now.getTime() - 600_000);
  await insertJob({ id: jobId, photoId, status: "running", attempts: 5, lastError: "vision_unavailable", lockedAt });
  const { deps, logs } = harness();
  await runOnce(deps, now, 2);
  const job = await pool.query(`SELECT status, last_error FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(job.rows[0].status, "failed");
  assert.equal(job.rows[0].last_error, "vision_unavailable");
  const photo = await pool.query(`SELECT status, error_message FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].status, "failed");
  assert.equal(photo.rows[0].error_message, "vision_unavailable");
  assert.equal(logs.some((entry) => entry.message === "任务租约回收" && entry.fields.errorCode === "interrupted"), true);
  const stored = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM jobs WHERE last_error = 'interrupted') +
       (SELECT count(*)::int FROM photos WHERE error_message = 'interrupted') AS n`,
  );
  assert.equal(stored.rows[0].n, 0);
});

serial("并发 2 领走两条到期任务，未来任务保持 pending", async () => {
  await reset();
  const ids = ["33333333-3333-4333-8333-333333333331", "33333333-3333-4333-8333-333333333332", "33333333-3333-4333-8333-333333333334"];
  const jobs = ["55555555-5555-4555-8555-555555555551", "55555555-5555-4555-8555-555555555552", "55555555-5555-4555-8555-555555555553"];
  const { deps } = harness();
  for (let index = 0; index < ids.length; index += 1) {
    await insertPhoto({ id: ids[index] as string });
    await insertJob({
      id: jobs[index] as string,
      photoId: ids[index] as string,
      runAfter: index === 2 ? new Date(now.getTime() + 60_000) : now,
    });
    await deps.storage.putObject({
      key: `owners/${ownerId}/photos/${ids[index]}/original`,
      contentType: "image/jpeg",
      body: Buffer.from("orig"),
    });
  }
  await runOnce(deps, now, 2);
  const done = await pool.query(`SELECT status FROM jobs WHERE id = ANY($1::uuid[]) ORDER BY id`, [jobs.slice(0, 2)]);
  assert.deepEqual(done.rows.map((row) => row.status), ["done", "done"]);
  const later = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [jobs[2]]);
  assert.equal(later.rows[0].status, "pending");
});

serial("已经 ready 的照片不会再次调用视觉、嵌入和 putObject", async () => {
  await reset();
  await insertPhoto({ id: photoId, status: "ready", thumbKey: `owners/${ownerId}/photos/${photoId}/thumb` });
  await insertJob({ id: jobId, photoId, status: "done", step: "done" });
  const { deps, storage, vision, embed } = harness();
  storage.putObjectCalls = 0;
  await runOnce(deps, now, 2);
  assert.equal(vision.calls, 0);
  assert.equal(embed.calls, 0);
  assert.equal(storage.putObjectCalls, 0);
});
