import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { encodeKeywordCursor } from "../src/domain/search/index.js";
import { createFakeEmbedGateway } from "../src/gateways/embed/fake-embed.js";
import { createFakeObjectStorage } from "../src/gateways/storage/fake-object-storage.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";
import { ManualClock } from "./manual-clock.js";
import { bearer, createApiKey, insertSearchPhoto, registerUser } from "./search-fixtures.js";

const databaseUrl = requireDatabaseUrl();
const START = new Date("2030-03-01T00:00:00.000Z");
const clock = new ManualClock(START);
const pool = new pg.Pool({ connectionString: databaseUrl });
const storage = createFakeObjectStorage();
const embed = createFakeEmbedGateway({ dimensions: 1536 });
let app: Awaited<ReturnType<typeof buildApp>>;

const appConfig = {
  jwtSecret: "test-jwt-secret-at-least-32-bytes",
  pepper: "test-pepper-at-least-32-bytes-ok",
  accessTtlSeconds: 120,
  refreshTtlSeconds: 30 * 24 * 60 * 60,
  databaseUrl,
};

let tail: Promise<unknown> = Promise.resolve();
function serial(name: string, fn: () => Promise<void>): void {
  test(name, () => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  });
}

test.before(async () => {
  await applySchema(pool);
  app = await buildApp({
    logger: false,
    config: appConfig,
    clock,
    pool,
    storage,
    signedUrlTtlSeconds: 900,
    embed,
    embedModel: "fake",
  });
});

test.after(async () => {
  await app.close();
  await pool.end();
});

async function reset(): Promise<void> {
  clock.set(START);
  await pool.query("TRUNCATE TABLE users CASCADE");
}

serial("关键词命中描述或标签，不命中只有地点文本的照片", async () => {
  await reset();
  const owner = await registerUser(app, "keyword-a@example.com");
  const boat = "77777777-7777-4777-8777-777777777771";
  const tagOnly = "77777777-7777-4777-8777-777777777772";
  const place = "77777777-7777-4777-8777-777777777773";
  await insertSearchPhoto(pool, {
    id: boat,
    ownerId: owner.userId,
    description: "Red Boat",
    tags: ["Seaside"],
    createdAt: new Date("2030-03-03T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: tagOnly,
    ownerId: owner.userId,
    description: null,
    tags: ["Seaside"],
    createdAt: new Date("2030-03-02T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: place,
    ownerId: owner.userId,
    description: "湖",
    tags: [],
    locationText: "red harbor",
    createdAt: new Date("2030-03-01T00:00:00.000Z"),
  });
  const red = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "red" },
  });
  assert.equal(red.statusCode, 200);
  assert.deepEqual(red.json().photos.map((photo: { id: string }) => photo.id), [boat]);
  assert.equal(red.json().photos[0].score, null);
  assert.equal(red.json().photos[0].status, "ready");
  const folded = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "Red" },
  });
  assert.deepEqual(folded.json().photos.map((photo: { id: string }) => photo.id), [boat]);
  const side = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "side" },
  });
  assert.deepEqual(side.json().photos.map((photo: { id: string }) => photo.id), [boat, tagOnly]);
});

serial("字面量通配符与不分词", async () => {
  await reset();
  const owner = await registerUser(app, "literal@example.com");
  const literal = "88888888-8888-4888-8888-888888888881";
  const other = "88888888-8888-4888-8888-888888888882";
  const phrase = "88888888-8888-4888-8888-888888888883";
  const split = "88888888-8888-4888-8888-888888888884";
  await insertSearchPhoto(pool, { id: literal, ownerId: owner.userId, description: "100%_ok", createdAt: START });
  await insertSearchPhoto(pool, { id: other, ownerId: owner.userId, description: "plain", createdAt: START });
  await insertSearchPhoto(pool, { id: phrase, ownerId: owner.userId, description: "红 船", createdAt: START });
  await insertSearchPhoto(pool, { id: split, ownerId: owner.userId, description: "红", tags: ["船"], createdAt: START });
  const exact = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "100%_ok" },
  });
  assert.deepEqual(exact.json().photos.map((photo: { id: string }) => photo.id), [literal]);
  const percent = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "%" },
  });
  assert.deepEqual(percent.json().photos.map((photo: { id: string }) => photo.id), [literal]);
  const spaced = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "红 船" },
  });
  assert.deepEqual(spaced.json().photos.map((photo: { id: string }) => photo.id), [phrase]);
});

serial("标签与时间过滤，非 ready 不返回", async () => {
  await reset();
  const owner = await registerUser(app, "filter@example.com");
  const both = "99999999-9999-4999-8999-999999999991";
  const lower = "99999999-9999-4999-8999-999999999992";
  const outside = "99999999-9999-4999-8999-999999999993";
  const undated = "99999999-9999-4999-8999-999999999994";
  const processing = "99999999-9999-4999-8999-999999999995";
  const failed = "99999999-9999-4999-8999-999999999996";
  await insertSearchPhoto(pool, {
    id: both,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside", "Trip"],
    takenAt: new Date("2026-06-01T00:00:00.000Z"),
    createdAt: new Date("2030-03-04T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: lower,
    ownerId: owner.userId,
    description: "boat",
    tags: ["seaside"],
    takenAt: new Date("2026-06-01T00:00:00.000Z"),
    createdAt: new Date("2030-03-03T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: outside,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside"],
    takenAt: new Date("2025-01-01T00:00:00.000Z"),
    createdAt: new Date("2030-03-02T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: undated,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside"],
    takenAt: null,
    createdAt: new Date("2030-03-01T00:00:00.000Z"),
  });
  const leftover = Array.from({ length: 1536 }, () => 0.1);
  await insertSearchPhoto(pool, {
    id: processing,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside"],
    status: "processing",
    createdAt: START,
    embedding: leftover,
  });
  await insertSearchPhoto(pool, {
    id: failed,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside"],
    status: "failed",
    createdAt: START,
    embedding: leftover,
  });
  const filtered = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: {
      mode: "keyword",
      q: "boat",
      tags: ["Seaside"],
      takenFrom: "2026-01-01T00:00:00.000Z",
      takenTo: "2026-12-31T23:59:59.999Z",
      status: "ready",
    },
  });
  assert.deepEqual(filtered.json().photos.map((photo: { id: string }) => photo.id), [both]);
  const openEnded = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "boat", tags: ["Seaside"] },
  });
  const openIds = openEnded.json().photos.map((photo: { id: string }) => photo.id);
  assert.equal(openIds.includes(undated), true);
  assert.equal(openIds.includes(processing), false);
  assert.equal(openIds.includes(failed), false);
  assert.equal(openIds.includes(outside), true);
  const explicitReady = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "boat", tags: ["Seaside"], status: "ready" },
  });
  assert.deepEqual(explicitReady.json().photos.map((photo: { id: string }) => photo.id), openIds);
  const badStatus = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "boat", status: "failed" },
  });
  assert.equal(badStatus.statusCode, 400);
  assert.deepEqual(badStatus.json(), { error: { code: "validation_error", message: "请求不合法" } });
  const inverted = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: {
      mode: "keyword",
      q: "boat",
      takenFrom: "2026-12-31T00:00:00.000Z",
      takenTo: "2026-01-01T00:00:00.000Z",
    },
  });
  assert.equal(inverted.statusCode, 400);
  assert.deepEqual(inverted.json(), { error: { code: "validation_error", message: "时间范围不合法" } });
});

serial("JWT 与 API Key 顺序一致，游标不会读出别人的照片", async () => {
  await reset();
  const owner = await registerUser(app, "owner-a@example.com");
  const other = await registerUser(app, "owner-b@example.com");
  const key = await createApiKey(app, owner.accessToken);
  const otherKey = await createApiKey(app, other.accessToken);
  const ownId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const otherId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const ownCreated = new Date("2030-03-02T00:00:00.000Z");
  const otherCreated = new Date("2030-03-03T00:00:00.000Z");
  await insertSearchPhoto(pool, { id: ownId, ownerId: owner.userId, description: "Red Boat", createdAt: ownCreated });
  await insertSearchPhoto(pool, { id: otherId, ownerId: other.userId, description: "Red Boat", createdAt: otherCreated });
  const byJwt = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "red" },
  });
  const byKey = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(key),
    payload: { mode: "keyword", q: "red" },
  });
  assert.deepEqual(
    byJwt.json().photos.map((photo: { id: string; score: null }) => [photo.id, photo.score]),
    byKey.json().photos.map((photo: { id: string; score: null }) => [photo.id, photo.score]),
  );
  assert.deepEqual(byJwt.json().photos.map((photo: { id: string }) => photo.id), [ownId]);
  const otherView = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(other.accessToken),
    payload: { mode: "keyword", q: "red" },
  });
  const otherByKey = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(otherKey),
    payload: { mode: "keyword", q: "red" },
  });
  assert.deepEqual(otherView.json().photos.map((photo: { id: string }) => photo.id), [otherId]);
  assert.deepEqual(otherByKey.json().photos.map((photo: { id: string }) => photo.id), [otherId]);
  const stolen = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "red", cursor: encodeKeywordCursor(otherCreated, otherId) },
  });
  assert.equal(stolen.statusCode, 200);
  assert.equal(
    stolen.json().photos.some((photo: { id: string }) => photo.id === otherId),
    false,
  );
});

serial("关键词结果带签名 URL，列表元素没有 score", async () => {
  await reset();
  const owner = await registerUser(app, "signed@example.com");
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  await insertSearchPhoto(pool, {
    id,
    ownerId: owner.userId,
    description: "海边",
    createdAt: START,
  });
  const found = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "海边" },
  });
  const photo = found.json().photos[0];
  assert.equal(photo.status, "ready");
  assert.equal(typeof photo.originalUrl, "string");
  assert.equal(typeof photo.thumbUrl, "string");
  assert.equal(photo.originalUrlExpiresAt, new Date(START.getTime() + 900 * 1000).toISOString());
  assert.equal(photo.thumbUrlExpiresAt, new Date(START.getTime() + 900 * 1000).toISOString());
  assert.equal(Object.hasOwn(photo, "objectKey"), false);
  assert.equal(Object.hasOwn(photo, "thumbKey"), false);
  const listed = await app.inject({ method: "GET", url: "/photos", headers: bearer(owner.accessToken) });
  assert.equal(listed.statusCode, 200);
  assert.equal(Object.hasOwn(listed.json().photos[0], "score"), false);
});
