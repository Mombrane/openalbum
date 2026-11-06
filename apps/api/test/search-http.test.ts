import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { createFakeObjectStorage } from "../src/gateways/storage/fake-object-storage.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";
import { ManualClock } from "./manual-clock.js";

const databaseUrl = requireDatabaseUrl();
const clock = new ManualClock(new Date("2030-01-01T00:00:00.000Z"));
const pool = new pg.Pool({ connectionString: databaseUrl });
const storage = createFakeObjectStorage();
let app: Awaited<ReturnType<typeof buildApp>>;

const testConfig = {
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
    config: testConfig,
    clock,
    pool,
    storage,
    signedUrlTtlSeconds: 900,
  });
});

test.after(async () => {
  await app.close();
  await pool.end();
});

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function register(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "correct-horse" },
  });
  assert.equal(response.statusCode, 201);
  return String(response.json().accessToken);
}

serial("未授权时不返回正文错误，授权后才校验正文和查询字符串", async () => {
  await pool.query("TRUNCATE TABLE users CASCADE");
  const unauthenticated = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: { "content-type": "application/json" },
    payload: "{",
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.deepEqual(unauthenticated.json(), { error: { code: "unauthorized", message: "未授权" } });
  const token = await register("search-http@example.com");
  const query = await app.inject({
    method: "POST",
    url: "/photos/search?limit=1",
    headers: auth(token),
    payload: { mode: "keyword", q: "海" },
  });
  assert.equal(query.statusCode, 400);
  assert.deepEqual(query.json(), { error: { code: "validation_error", message: "请求不合法" } });
  const arrayBody = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: auth(token),
    payload: [],
  });
  assert.equal(arrayBody.statusCode, 400);
  assert.deepEqual(arrayBody.json(), { error: { code: "validation_error", message: "请求不合法" } });
  const broken = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: { ...auth(token), "content-type": "application/json" },
    payload: "{",
  });
  assert.equal(broken.statusCode, 400);
  assert.deepEqual(broken.json(), { error: { code: "validation_error", message: "请求不合法" } });
  const missing = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: auth(token),
    payload: { mode: "keyword" },
  });
  assert.deepEqual(missing.json(), { error: { code: "validation_error", message: "请求不合法" } });
  const empty = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: auth(token),
    payload: { mode: "keyword", q: "   " },
  });
  assert.equal(empty.statusCode, 400);
  assert.deepEqual(empty.json(), { error: { code: "empty_query", message: "查询为空" } });
  const get = await app.inject({ method: "GET", url: "/photos/search", headers: auth(token) });
  assert.equal(get.statusCode, 400);
  assert.deepEqual(get.json(), { error: { code: "validation_error", message: "标识不合法" } });
});

serial("未注入嵌入时关键词仍可返回空页，语义为 503", async () => {
  await pool.query("TRUNCATE TABLE users CASCADE");
  const token = await register("search-empty@example.com");
  const keyword = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: auth(token),
    payload: { mode: "keyword", q: "海边" },
  });
  assert.equal(keyword.statusCode, 200);
  assert.deepEqual(keyword.json(), { photos: [], nextCursor: null });
  const semantic = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: auth(token),
    payload: { mode: "semantic", q: "海边" },
  });
  assert.equal(semantic.statusCode, 503);
  assert.deepEqual(semantic.json(), { error: { code: "embed_unavailable", message: "嵌入暂不可用" } });
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
});
