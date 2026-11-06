import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { runOnce } from "../src/adapters/pipeline/run-once.js";
import type { PipelineDeps } from "../src/adapters/pipeline/deps.js";
import { buildApp } from "../src/app.js";
import { createPipelineStore } from "../src/dao/pipeline-store.js";
import { createFakeEmbedGateway } from "../src/gateways/embed/fake-embed.js";
import { createFakeExifReader } from "../src/gateways/exif/fake-exif-reader.js";
import { createFakeObjectStorage } from "../src/gateways/storage/fake-object-storage.js";
import { createFakeThumbnailEncoder } from "../src/gateways/thumbnail/fake-encoder.js";
import { createFakeVisionGateway } from "../src/gateways/vision/fake-vision.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";
import { ManualClock } from "./manual-clock.js";

const databaseUrl = requireDatabaseUrl();
const START = new Date("2030-07-01T00:00:00.000Z");
const clock = new ManualClock(START);
const pool = new pg.Pool({ connectionString: databaseUrl });
const storage = createFakeObjectStorage();
const vision = createFakeVisionGateway({ description: "海边", tags: ["海", "黄昏"] });
const embed = createFakeEmbedGateway({ dimensions: 1536 });
const exif = createFakeExifReader({ takenAt: new Date("2020-01-02T03:04:05.000Z"), latitude: 1.5, longitude: 2.5 });
const thumbnail = createFakeThumbnailEncoder();
const appConfig = {
  jwtSecret: "test-jwt-secret-at-least-32-bytes",
  pepper: "test-pepper-at-least-32-bytes-ok",
  accessTtlSeconds: 120,
  refreshTtlSeconds: 30 * 24 * 60 * 60,
  databaseUrl,
};
let app: Awaited<ReturnType<typeof buildApp>>;

let tail: Promise<unknown> = Promise.resolve();
function serial(name: string, fn: () => Promise<void>): void {
  test(name, () => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  });
}

function pipeline(): PipelineDeps {
  return {
    store: createPipelineStore(pool),
    storage,
    exif,
    thumbnail,
    vision,
    embed,
    log: { info() {}, warn() {} },
    visionModel: "vision-test",
    embedModel: "embed-test",
    embedDimensions: 1536,
  };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function reset(): Promise<void> {
  clock.set(START);
  storage.putObjectCalls = 0;
  storage.deletedKeys.length = 0;
  await pool.query("TRUNCATE TABLE users CASCADE");
}

async function register(email: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "correct-horse" } });
  assert.equal(response.statusCode, 201);
  return String(response.json().accessToken);
}

async function uploadAndComplete(token: string): Promise<{ sessionId: string; photoId: string }> {
  const created = await app.inject({
    method: "POST",
    url: "/photos/uploads",
    headers: auth(token),
    payload: { contentType: "image/jpeg", byteSize: 4 },
  });
  assert.equal(created.statusCode, 201);
  const body = created.json().upload;
  const part = await app.inject({
    method: "PUT",
    url: `/photos/uploads/${body.id}/parts/1`,
    headers: { ...auth(token), "content-type": "application/octet-stream" },
    payload: Buffer.from("abcd"),
  });
  assert.equal(part.statusCode, 200);
  const completed = await app.inject({
    method: "POST",
    url: `/photos/uploads/${body.id}/complete`,
    headers: auth(token),
    payload: {},
  });
  assert.equal(completed.statusCode, 201);
  return { sessionId: String(body.id), photoId: String(body.photoId) };
}

test.before(async () => {
  await applySchema(pool);
  app = await buildApp({ logger: false, config: appConfig, clock, pool, storage, signedUrlTtlSeconds: 900 });
});

test.after(async () => {
  await app.close();
  await pool.end();
});

serial("上传后 runOnce 变为 ready，详情带缩略图 URL", async () => {
  await reset();
  const token = await register("ready@example.com");
  const uploaded = await uploadAndComplete(token);
  await runOnce(pipeline(), clock.now(), 2);
  const detail = await app.inject({ method: "GET", url: `/photos/${uploaded.photoId}`, headers: auth(token) });
  assert.equal(detail.statusCode, 200);
  const photo = detail.json().photo;
  assert.equal(photo.status, "ready");
  assert.equal(photo.errorCode, null);
  assert.equal(photo.description, "海边");
  assert.deepEqual(photo.tags, ["海", "黄昏"]);
  assert.equal(typeof photo.thumbUrl, "string");
  assert.equal(typeof photo.thumbUrlExpiresAt, "string");
  assert.equal(typeof photo.originalUrl, "string");
  const row = await pool.query(`SELECT thumb_key, owner_id FROM photos WHERE id = $1`, [uploaded.photoId]);
  assert.equal(row.rows[0].thumb_key, `owners/${row.rows[0].owner_id}/photos/${uploaded.photoId}/thumb`);
  const thumb = await storage.getObject({ key: row.rows[0].thumb_key });
  assert.ok((thumb?.byteSize ?? 0) >= 1);
  const embedding = await pool.query(`SELECT model, vector_dims(embedding) AS dims FROM photo_embeddings WHERE photo_id = $1`, [uploaded.photoId]);
  assert.equal(embedding.rows[0].model, "embed-test");
  assert.equal(embedding.rows[0].dims, 1536);
});

serial("用户先写的时间和坐标留下来，空照片才补 EXIF", async () => {
  await reset();
  const token = await register("exif@example.com");
  const kept = await app.inject({
    method: "POST",
    url: "/photos/uploads",
    headers: auth(token),
    payload: { contentType: "image/jpeg", byteSize: 4 },
  });
  const keptUpload = kept.json().upload;
  await app.inject({
    method: "PUT",
    url: `/photos/uploads/${keptUpload.id}/parts/1`,
    headers: { ...auth(token), "content-type": "application/octet-stream" },
    payload: Buffer.from("abcd"),
  });
  const keptDone = await app.inject({ method: "POST", url: `/photos/uploads/${keptUpload.id}/complete`, headers: auth(token), payload: {} });
  assert.equal(keptDone.statusCode, 201);
  const patched = await app.inject({
    method: "PATCH",
    url: `/photos/${keptUpload.photoId}`,
    headers: auth(token),
    payload: { takenAt: "2019-05-01T00:00:00.000Z", latitude: 9, longitude: 8, locationText: "用户地点" },
  });
  assert.equal(patched.statusCode, 200);
  const empty = await uploadAndComplete(token);
  await runOnce(pipeline(), clock.now(), 2);
  const keptRow = await pool.query(`SELECT taken_at, latitude, longitude, location_text FROM photos WHERE id = $1`, [keptUpload.photoId]);
  assert.equal(new Date(keptRow.rows[0].taken_at).toISOString(), "2019-05-01T00:00:00.000Z");
  assert.equal(Number(keptRow.rows[0].latitude), 9);
  assert.equal(Number(keptRow.rows[0].longitude), 8);
  assert.equal(keptRow.rows[0].location_text, "用户地点");
  const emptyRow = await pool.query(`SELECT taken_at, latitude, longitude, location_text FROM photos WHERE id = $1`, [empty.photoId]);
  assert.equal(new Date(emptyRow.rows[0].taken_at).toISOString(), "2020-01-02T03:04:05.000Z");
  assert.equal(Number(emptyRow.rows[0].latitude), 1.5);
  assert.equal(Number(emptyRow.rows[0].longitude), 2.5);
  assert.equal(emptyRow.rows[0].location_text, null);
});

serial("只写标签时视觉可以填描述，两个都写了则不调用视觉", async () => {
  await reset();
  const token = await register("tags@example.com");
  const tagged = await app.inject({
    method: "POST",
    url: "/photos/uploads",
    headers: auth(token),
    payload: { contentType: "image/jpeg", byteSize: 4 },
  });
  const taggedBody = tagged.json().upload;
  await app.inject({
    method: "PUT",
    url: `/photos/uploads/${taggedBody.id}/parts/1`,
    headers: { ...auth(token), "content-type": "application/octet-stream" },
    payload: Buffer.from("abcd"),
  });
  const taggedDone = await app.inject({ method: "POST", url: `/photos/uploads/${taggedBody.id}/complete`, headers: auth(token), payload: {} });
  assert.equal(taggedDone.statusCode, 201);
  const tagPatch = await app.inject({
    method: "PATCH",
    url: `/photos/${taggedBody.photoId}`,
    headers: auth(token),
    payload: { tags: ["用户标签"] },
  });
  assert.equal(tagPatch.statusCode, 200);
  const both = await uploadAndComplete(token);
  const bothPatch = await app.inject({
    method: "PATCH",
    url: `/photos/${both.photoId}`,
    headers: auth(token),
    payload: { description: "用户描述", tags: ["自己的"] },
  });
  assert.equal(bothPatch.statusCode, 200);
  const callsBefore = vision.calls;
  await runOnce(pipeline(), clock.now(), 2);
  const taggedRow = await pool.query(`SELECT description, tags FROM photos WHERE id = $1`, [taggedBody.photoId]);
  assert.equal(taggedRow.rows[0].description, "海边");
  assert.deepEqual(taggedRow.rows[0].tags, ["用户标签"]);
  const bothRow = await pool.query(`SELECT description, tags FROM photos WHERE id = $1`, [both.photoId]);
  assert.equal(bothRow.rows[0].description, "用户描述");
  assert.deepEqual(bothRow.rows[0].tags, ["自己的"]);
  assert.equal(vision.calls, callsBefore + 1);
});

serial("ready 后修改描述会重嵌入，失败且没有缩略图时不升为 ready", async () => {
  await reset();
  const token = await register("reembed@example.com");
  const uploaded = await uploadAndComplete(token);
  await runOnce(pipeline(), clock.now(), 2);
  const before = await pool.query(`SELECT embedding::text AS embedding FROM photo_embeddings WHERE photo_id = $1`, [uploaded.photoId]);
  const calls = vision.calls;
  const changed = await app.inject({
    method: "PATCH",
    url: `/photos/${uploaded.photoId}`,
    headers: auth(token),
    payload: { description: "改过的描述" },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().photo.status, "ready");
  await runOnce(pipeline(), clock.now(), 2);
  const after = await pool.query(`SELECT embedding::text AS embedding FROM photo_embeddings WHERE photo_id = $1`, [uploaded.photoId]);
  assert.notEqual(after.rows[0].embedding, before.rows[0].embedding);
  assert.equal(vision.calls, calls);

  await pool.query(`UPDATE photos SET status = 'failed', error_message = 'thumbnail_failed', thumb_key = NULL WHERE id = $1`, [uploaded.photoId]);
  await pool.query(`UPDATE jobs SET status = 'done' WHERE photo_id = $1`, [uploaded.photoId]);
  await app.inject({
    method: "PATCH",
    url: `/photos/${uploaded.photoId}`,
    headers: auth(token),
    payload: { description: "失败后的描述" },
  });
  await runOnce(pipeline(), clock.now(), 2);
  const stayed = await pool.query(`SELECT status FROM photos WHERE id = $1`, [uploaded.photoId]);
  assert.equal(stayed.rows[0].status, "failed");
});

serial("有缩略图的失败照片在重嵌入成功后变为 ready，删除会级联任务和向量", async () => {
  await reset();
  const token = await register("delete@example.com");
  const uploaded = await uploadAndComplete(token);
  await runOnce(pipeline(), clock.now(), 2);
  await pool.query(`UPDATE photos SET status = 'failed', error_message = 'embed_rejected' WHERE id = $1`, [uploaded.photoId]);
  await pool.query(`UPDATE jobs SET status = 'done' WHERE photo_id = $1`, [uploaded.photoId]);
  await app.inject({
    method: "PATCH",
    url: `/photos/${uploaded.photoId}`,
    headers: auth(token),
    payload: { description: "补嵌入" },
  });
  await runOnce(pipeline(), clock.now(), 2);
  const ready = await pool.query(`SELECT status, error_message FROM photos WHERE id = $1`, [uploaded.photoId]);
  assert.equal(ready.rows[0].status, "ready");
  assert.equal(ready.rows[0].error_message, null);
  const removed = await app.inject({ method: "DELETE", url: `/photos/${uploaded.photoId}`, headers: auth(token) });
  assert.equal(removed.statusCode, 204);
  const embeddings = await pool.query(`SELECT count(*)::int AS n FROM photo_embeddings WHERE photo_id = $1`, [uploaded.photoId]);
  const jobs = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1`, [uploaded.photoId]);
  assert.equal(embeddings.rows[0].n, 0);
  assert.equal(jobs.rows[0].n, 0);
  const owner = await pool.query(`SELECT owner_id FROM photos WHERE id = $1`, [uploaded.photoId]);
  assert.equal(owner.rowCount, 0);
  assert.equal(storage.deletedKeys.some((key) => key.endsWith("/original")), true);
  assert.equal(storage.deletedKeys.some((key) => key.endsWith("/thumb")), true);
});

serial("不设置视觉和嵌入变量时仍能完成 Phase 2 上传", async () => {
  await reset();
  const source = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  assert.equal(source.includes("VISION_"), false);
  assert.equal(source.includes("EMBED_"), false);
  assert.equal(source.includes("PIPELINE_"), false);
  const token = await register("novision@example.com");
  const uploaded = await uploadAndComplete(token);
  assert.equal(typeof uploaded.photoId, "string");
});
