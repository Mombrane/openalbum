import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { createFakeObjectStorage } from "../src/gateways/storage/fake-object-storage.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";
import { ManualClock } from "./manual-clock.js";

const databaseUrl = requireDatabaseUrl();
const START = new Date("2030-01-01T00:00:00.000Z");
const PEPPER = "test-pepper-at-least-32-bytes-ok";
const JWT_SECRET = "test-jwt-secret-at-least-32-bytes";
const testConfig = {
  jwtSecret: JWT_SECRET,
  pepper: PEPPER,
  accessTtlSeconds: 120,
  refreshTtlSeconds: 30 * 24 * 60 * 60,
  databaseUrl,
};
const clock = new ManualClock(START);
const pool = new pg.Pool({ connectionString: databaseUrl });
const storage = createFakeObjectStorage();
let app: Awaited<ReturnType<typeof buildApp>>;

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

serial("未授权 POST /photos/uploads", async () => {
  await pool.query("TRUNCATE TABLE users CASCADE");
  const response = await app.inject({ method: "POST", url: "/photos/uploads", payload: { contentType: "image/jpeg", byteSize: 4 } });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: { code: "unauthorized", message: "未授权" } });
});

serial("上传并完成返回 processing 且无 s3UploadId", async () => {
  await pool.query("TRUNCATE TABLE users CASCADE");
  const registered = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "owner@example.com", password: "correct-horse" },
  });
  assert.equal(registered.statusCode, 201);
  const accessToken = registered.json().accessToken as string;

  const created = await app.inject({
    method: "POST",
    url: "/photos/uploads",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { contentType: "image/jpeg", byteSize: 4 },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(JSON.stringify(created.json()).includes("s3UploadId"), false);
  const sessionId = created.json().upload.id as string;

  const part = await app.inject({
    method: "PUT",
    url: `/photos/uploads/${sessionId}/parts/1`,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/octet-stream",
    },
    payload: Buffer.from("aaaa"),
  });
  assert.equal(part.statusCode, 200);

  const completed = await app.inject({
    method: "POST",
    url: `/photos/uploads/${sessionId}/complete`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
  assert.equal(completed.statusCode, 201);
  assert.equal(completed.json().photo.status, "processing");
  assert.equal(JSON.stringify(completed.json()).includes("s3UploadId"), false);
});

test("未注入 storage 时 health 仍可用", async () => {
  const saved = process.env.S3_SECRET_ACCESS_KEY;
  delete process.env.S3_SECRET_ACCESS_KEY;
  try {
    const local = await buildApp({
      logger: false,
      config: testConfig,
      clock,
      pool,
    });
    const health = await local.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    await local.close();
  } finally {
    if (saved === undefined) delete process.env.S3_SECRET_ACCESS_KEY;
    else process.env.S3_SECRET_ACCESS_KEY = saved;
  }
});
