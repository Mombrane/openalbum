import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { createFakeObjectStorage, createStorageGate } from "../src/gateways/storage/fake-object-storage.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";
import { ManualClock } from "./manual-clock.js";

const databaseUrl = requireDatabaseUrl();
const START = new Date("2030-06-01T00:00:00.000Z");
const clock = new ManualClock(START);
const pool = new pg.Pool({ connectionString: databaseUrl });
const storage = createFakeObjectStorage();
const testConfig = {
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

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function reset(): Promise<void> {
  clock.set(START);
  storage.blockComplete(null);
  await pool.query("TRUNCATE TABLE users CASCADE");
}

async function register(email: string): Promise<{ accessToken: string; userId: string }> {
  const response = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "correct-horse" } });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  return { accessToken: String(body.accessToken), userId: String(body.user.id) };
}

async function upload(token: string): Promise<{ sessionId: string; photoId: string }> {
  const created = await app.inject({
    method: "POST",
    url: "/photos/uploads",
    headers: auth(token),
    payload: { contentType: "image/jpeg", byteSize: 4 },
  });
  assert.equal(created.statusCode, 201);
  const uploadBody = created.json().upload;
  const part = await app.inject({
    method: "PUT",
    url: `/photos/uploads/${uploadBody.id}/parts/1`,
    headers: { ...auth(token), "content-type": "application/octet-stream" },
    payload: Buffer.from("abcd"),
  });
  assert.equal(part.statusCode, 200);
  return { sessionId: String(uploadBody.id), photoId: String(uploadBody.photoId) };
}

test.before(async () => {
  await applySchema(pool);
  app = await buildApp({ logger: false, config: testConfig, clock, pool, storage, signedUrlTtlSeconds: 900 });
});

test.after(async () => {
  await app.close();
  await pool.end();
});

serial("完成响应带空缩略图字段并入队一条 process_photo", async () => {
  await reset();
  const owner = await register("enqueue@example.com");
  const uploaded = await upload(owner.accessToken);
  const completed = await app.inject({
    method: "POST",
    url: `/photos/uploads/${uploaded.sessionId}/complete`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  assert.equal(completed.statusCode, 201);
  const photo = completed.json().photo;
  assert.equal(photo.status, "processing");
  assert.equal(photo.errorCode, null);
  assert.equal(photo.thumbUrl, null);
  assert.equal(photo.thumbUrlExpiresAt, null);
  assert.equal(Object.hasOwn(photo, "errorCode"), true);
  assert.equal(Object.hasOwn(photo, "thumbUrl"), true);
  assert.equal(Object.hasOwn(photo, "thumbUrlExpiresAt"), true);
  const jobs = await pool.query(
    `SELECT type, payload->>'step' AS step FROM jobs WHERE photo_id = $1`,
    [uploaded.photoId],
  );
  assert.equal(jobs.rowCount, 1);
  assert.equal(jobs.rows[0].type, "process_photo");
  assert.equal(jobs.rows[0].step, "exif");
});

serial("completing 期间不入队，再次完成不增加任务", async () => {
  await reset();
  const owner = await register("completing@example.com");
  const uploaded = await upload(owner.accessToken);
  const gate = createStorageGate();
  storage.blockComplete(gate);
  const pending = app.inject({
    method: "POST",
    url: `/photos/uploads/${uploaded.sessionId}/complete`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  await gate.entered;
  const session = await pool.query(`SELECT status FROM upload_sessions WHERE id = $1`, [uploaded.sessionId]);
  assert.equal(session.rows[0].status, "completing");
  const during = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1`, [uploaded.photoId]);
  assert.equal(during.rows[0].n, 0);
  gate.release();
  const completed = await pending;
  assert.equal(completed.statusCode, 201);
  const again = await app.inject({
    method: "POST",
    url: `/photos/uploads/${uploaded.sessionId}/complete`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  assert.equal(again.statusCode, 200);
  const jobs = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1 AND type = 'process_photo'`, [uploaded.photoId]);
  assert.equal(jobs.rows[0].n, 1);
});

serial("failed 且已有历史任务时再次完成不入队", async () => {
  await reset();
  const owner = await register("failed-complete@example.com");
  const uploaded = await upload(owner.accessToken);
  const completed = await app.inject({
    method: "POST",
    url: `/photos/uploads/${uploaded.sessionId}/complete`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  assert.equal(completed.statusCode, 201);
  await pool.query(`UPDATE photos SET status = 'failed', error_message = 'vision_rejected' WHERE id = $1`, [uploaded.photoId]);
  const again = await app.inject({
    method: "POST",
    url: `/photos/uploads/${uploaded.sessionId}/complete`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().photo.status, "failed");
  const jobs = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1 AND type = 'process_photo'`, [uploaded.photoId]);
  assert.equal(jobs.rows[0].n, 1);
});

serial("PATCH 只有描述变化才入队 reembed，重试只接受 failed", async () => {
  await reset();
  const owner = await register("patch@example.com");
  const other = await register("other@example.com");
  const uploaded = await upload(owner.accessToken);
  await app.inject({
    method: "POST",
    url: `/photos/uploads/${uploaded.sessionId}/complete`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  await pool.query(`UPDATE photos SET status = 'ready', description = '旧描述' WHERE id = $1`, [uploaded.photoId]);
  await pool.query(`UPDATE jobs SET status = 'done', payload = '{"step":"done"}'::jsonb WHERE photo_id = $1`, [uploaded.photoId]);
  const changed = await app.inject({
    method: "PATCH",
    url: `/photos/${uploaded.photoId}`,
    headers: auth(owner.accessToken),
    payload: { description: "新描述" },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().photo.status, "ready");
  const reembed = await pool.query(
    `SELECT status FROM jobs WHERE photo_id = $1 AND type = 'reembed' AND status = 'pending'`,
    [uploaded.photoId],
  );
  assert.equal(reembed.rowCount, 1);
  const beforeTaken = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1`, [uploaded.photoId]);
  const taken = await app.inject({
    method: "PATCH",
    url: `/photos/${uploaded.photoId}`,
    headers: auth(owner.accessToken),
    payload: { takenAt: "2020-01-02T03:04:05.000Z" },
  });
  assert.equal(taken.statusCode, 200);
  const same = await app.inject({
    method: "PATCH",
    url: `/photos/${uploaded.photoId}`,
    headers: auth(owner.accessToken),
    payload: { description: "新描述" },
  });
  assert.equal(same.statusCode, 200);
  const after = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1`, [uploaded.photoId]);
  assert.equal(after.rows[0].n, beforeTaken.rows[0].n);

  await pool.query(`UPDATE photos SET status = 'failed', error_message = 'embed_rejected' WHERE id = $1`, [uploaded.photoId]);
  const retried = await app.inject({
    method: "POST",
    url: `/photos/${uploaded.photoId}/retry`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.json().photo.status, "processing");
  assert.equal(retried.json().photo.errorCode, null);
  const processRows = await pool.query(
    `SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1 AND type = 'process_photo' AND status = 'pending'`,
    [uploaded.photoId],
  );
  assert.equal(processRows.rows[0].n, 1);

  await pool.query(`UPDATE photos SET status = 'ready', error_message = NULL WHERE id = $1`, [uploaded.photoId]);
  const blocked = await app.inject({
    method: "POST",
    url: `/photos/${uploaded.photoId}/retry`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  assert.equal(blocked.statusCode, 409);
  assert.deepEqual(blocked.json(), { error: { code: "not_failed", message: "照片不在失败状态" } });
  const foreign = await app.inject({
    method: "POST",
    url: `/photos/${uploaded.photoId}/retry`,
    headers: auth(other.accessToken),
    payload: {},
  });
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().error.message, "未找到");
  const extra = await app.inject({
    method: "POST",
    url: `/photos/${uploaded.photoId}/retry`,
    headers: auth(owner.accessToken),
    payload: { extra: true },
  });
  assert.equal(extra.statusCode, 400);
  assert.equal(extra.json().error.message, "请求不合法");
});
