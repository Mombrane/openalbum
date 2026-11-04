import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { createFakeObjectStorage, createStorageGate } from "../src/gateways/storage/fake-object-storage.js";
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

const NOT_FOUND = { error: { code: "not_found", message: "未找到" } };
const BAD_PART = { error: { code: "validation_error", message: "分片不合法" } };
const INVALID_BODY = { error: { code: "validation_error", message: "请求不合法" } };
const INVALID_SIZE = { error: { code: "validation_error", message: "文件大小须为 1 字节到 32 MiB" } };
const UNSUPPORTED_TYPE = { error: { code: "validation_error", message: "不支持的文件类型" } };
const UPLOAD_CLOSED = { error: { code: "upload_closed", message: "上传已结束" } };
const UPLOAD_COMPLETED = { error: { code: "upload_completed", message: "上传已完成" } };
const UPLOAD_COMPLETING = { error: { code: "upload_completing", message: "上传正在完成" } };
const STORAGE_ERROR = { error: { code: "storage_error", message: "对象存储不可用" } };
const PAYLOAD_TOO_LARGE = { error: { code: "payload_too_large", message: "文件超过 32 MiB" } };
const INVALID_ID = { error: { code: "validation_error", message: "标识不合法" } };

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

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 409 超时，行锁可能盖住了 completing")), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function reset(): Promise<void> {
  clock.set(START);
  restoreStorage();
  storage.completeCalls = 0;
  storage.abortCount = 0;
  storage.createCalls = 0;
  storage.deletedKeys.length = 0;
  await pool.query("TRUNCATE TABLE users CASCADE");
}

function restoreStorage(): void {
  storage.blockComplete(null);
  storage.failDelete = false;
  storage.failComplete = false;
  storage.failAbort = false;
  storage.failUploadPart = false;
}

async function registerAccess(email: string): Promise<{ accessToken: string; userId: string }> {
  const registered = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "correct-horse" },
  });
  assert.equal(registered.statusCode, 201);
  const body = registered.json();
  return { accessToken: String(body.accessToken), userId: String(body.user.id) };
}

async function createApiKeyFor(accessToken: string): Promise<{ secret: string; keyId: string }> {
  const created = await app.inject({
    method: "POST",
    url: "/api-keys",
    headers: auth(accessToken),
    payload: { name: "agent" },
  });
  assert.equal(created.statusCode, 201);
  const body = created.json();
  return { secret: String(body.secret), keyId: String(body.apiKey.id) };
}

async function createUploadHttp(token: string, contentType: string, byteSize: number) {
  const created = await app.inject({
    method: "POST",
    url: "/photos/uploads",
    headers: auth(token),
    payload: { contentType, byteSize },
  });
  return created;
}

async function uploadPartHttp(
  token: string,
  sessionId: string,
  partNumber: number,
  payload: Buffer,
  method: "PUT" | "POST" = "PUT",
) {
  return app.inject({
    method,
    url: `/photos/uploads/${sessionId}/parts/${partNumber}`,
    headers: { ...auth(token), "content-type": "application/octet-stream" },
    payload,
  });
}

async function completeHttp(token: string, sessionId: string) {
  return app.inject({
    method: "POST",
    url: `/photos/uploads/${sessionId}/complete`,
    headers: auth(token),
    payload: {},
  });
}

async function abortHttp(token: string, sessionId: string) {
  return app.inject({
    method: "POST",
    url: `/photos/uploads/${sessionId}/abort`,
    headers: auth(token),
    payload: {},
  });
}

async function uploadJpeg(token: string, byteSize = 4, partBody?: Buffer) {
  const created = await createUploadHttp(token, "image/jpeg", byteSize);
  assert.equal(created.statusCode, 201, JSON.stringify(created.json()));
  const upload = created.json().upload;
  const body = partBody ?? Buffer.alloc(byteSize, 0x61);
  const part = await uploadPartHttp(token, upload.id, 1, body);
  assert.equal(part.statusCode, 200, JSON.stringify(part.json()));
  return { sessionId: upload.id as string, photoId: upload.photoId as string, objectKey: upload.objectKey as string };
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
  await reset();
  const response = await app.inject({ method: "POST", url: "/photos/uploads", payload: { contentType: "image/jpeg", byteSize: 4 } });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: { code: "unauthorized", message: "未授权" } });
});

serial("上传并完成返回 processing 且无 s3UploadId", async () => {
  await reset();
  const owner = await registerAccess("owner@example.com");
  const created = await createUploadHttp(owner.accessToken, "image/jpeg", 4);
  assert.equal(created.statusCode, 201);
  assert.equal(JSON.stringify(created.json()).includes("s3UploadId"), false);
  const sessionId = created.json().upload.id as string;
  const part = await uploadPartHttp(owner.accessToken, sessionId, 1, Buffer.from("aaaa"));
  assert.equal(part.statusCode, 200);
  const completed = await completeHttp(owner.accessToken, sessionId);
  assert.equal(completed.statusCode, 201);
  assert.equal(completed.json().photo.status, "processing");
  assert.equal(JSON.stringify(completed.json()).includes("s3UploadId"), false);
});

serial("§10.1 JWT 上传完成与列表 URL", async () => {
  try {
    await reset();
    const owner = await registerAccess("s10-1@example.com");
    const created = await createUploadHttp(owner.accessToken, "image/jpeg", 4);
    assert.equal(created.statusCode, 201);
    const upload = created.json().upload;
    const beforePhoto = await pool.query("SELECT 1 FROM photos WHERE id = $1", [upload.photoId]);
    assert.equal(beforePhoto.rowCount, 0);
    const session = await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [upload.id]);
    assert.equal(session.rows[0]?.status, "open");

    await uploadPartHttp(owner.accessToken, upload.id, 1, Buffer.from("abcd"));
    const done = await completeHttp(owner.accessToken, upload.id);
    assert.equal(done.statusCode, 201);
    assert.equal(done.json().photo.status, "processing");
    assert.equal(done.json().photo.id, upload.photoId);

    const row = await pool.query("SELECT object_key FROM photos WHERE id = $1", [upload.photoId]);
    assert.equal(row.rows[0]?.object_key, `owners/${owner.userId}/photos/${upload.photoId}/original`);
    assert.equal(storage.completedBytes(upload.objectKey)?.length, 4);

    const listed = await app.inject({ method: "GET", url: "/photos", headers: auth(owner.accessToken) });
    assert.equal(listed.statusCode, 200);
    const item = listed.json().photos.find((photo: { id: string }) => photo.id === upload.photoId);
    assert.ok(item?.originalUrl);
    assert.ok(item?.originalUrlExpiresAt);
    assert.equal("sourceKeyId" in item, false);
    assert.equal("sourceUserId" in item, false);
  } finally {
    restoreStorage();
  }
});

serial("§10.2 API Key 全流程与 source 字段", async () => {
  try {
    await reset();
    const owner = await registerAccess("s10-2@example.com");
    const jwtCtx = await uploadJpeg(owner.accessToken, 4, Buffer.from("abcd"));
    const jwtDone = await completeHttp(owner.accessToken, jwtCtx.sessionId);
    assert.equal(jwtDone.statusCode, 201);
    const jwtRow = await pool.query("SELECT source_user_id, source_key_id FROM photos WHERE id = $1", [jwtCtx.photoId]);
    assert.equal(jwtRow.rows[0]?.source_user_id, owner.userId);
    assert.equal(jwtRow.rows[0]?.source_key_id, null);
    assert.equal(JSON.stringify(jwtDone.json()).includes("source_key_id"), false);

    const { secret, keyId } = await createApiKeyFor(owner.accessToken);
    const apiCtx = await uploadJpeg(secret, 4, Buffer.from("efgh"));
    const apiDone = await completeHttp(secret, apiCtx.sessionId);
    assert.equal(apiDone.statusCode, 201);
    const apiRow = await pool.query("SELECT source_key_id FROM photos WHERE id = $1", [apiCtx.photoId]);
    assert.equal(apiRow.rows[0]?.source_key_id, keyId);

    const list = await app.inject({ method: "GET", url: "/photos", headers: auth(secret) });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().photos.some((photo: { id: string }) => photo.id === apiCtx.photoId), true);

    const got = await app.inject({ method: "GET", url: `/photos/${apiCtx.photoId}`, headers: auth(secret) });
    assert.equal(got.statusCode, 200);

    const patched = await app.inject({
      method: "PATCH",
      url: `/photos/${apiCtx.photoId}`,
      headers: auth(secret),
      payload: { description: "via-key" },
    });
    assert.equal(patched.statusCode, 200);

    const removed = await app.inject({ method: "DELETE", url: `/photos/${apiCtx.photoId}`, headers: auth(secret) });
    assert.equal(removed.statusCode, 204);
    assert.equal(removed.body, "");
  } finally {
    restoreStorage();
  }
});

serial("§10.3 越权一律 404", async () => {
  try {
    await reset();
    const owner = await registerAccess("s10-3-owner@example.com");
    const other = await registerAccess("s10-3-other@example.com");
    const { secret: otherKey } = await createApiKeyFor(other.accessToken);
    const ctx = await uploadJpeg(owner.accessToken, 4, Buffer.from("abcd"));
    await completeHttp(owner.accessToken, ctx.sessionId);
    const open = await uploadJpeg(owner.accessToken, 4, Buffer.from("wxyz"));

    for (const token of [other.accessToken, otherKey]) {
      for (const call of [
        () => app.inject({ method: "GET", url: `/photos/${ctx.photoId}`, headers: auth(token) }),
        () =>
          app.inject({
            method: "PATCH",
            url: `/photos/${ctx.photoId}`,
            headers: auth(token),
            payload: { description: "x" },
          }),
        () => app.inject({ method: "DELETE", url: `/photos/${ctx.photoId}`, headers: auth(token) }),
        () => uploadPartHttp(token, open.sessionId, 1, Buffer.from("hack")),
        () => completeHttp(token, open.sessionId),
        () => abortHttp(token, open.sessionId),
      ]) {
        const response = await call();
        assert.equal(response.statusCode, 404);
        assert.deepEqual(response.json(), NOT_FOUND);
      }
      const listed = await app.inject({ method: "GET", url: "/photos", headers: auth(token) });
      assert.equal(listed.json().photos.every((photo: { id: string }) => photo.id !== ctx.photoId), true);
    }
  } finally {
    restoreStorage();
  }
});

serial("§10.4 PATCH 字段与非法键", async () => {
  try {
    await reset();
    const owner = await registerAccess("s10-4@example.com");
    const ctx = await uploadJpeg(owner.accessToken, 4, Buffer.from("abcd"));
    await completeHttp(owner.accessToken, ctx.sessionId);

    const steps: { payload: Record<string, unknown>; check: (row: pg.QueryResultRow) => void }[] = [
      { payload: { description: "sea" }, check: (row) => assert.equal(row.description, "sea") },
      { payload: { tags: ["a", "b"] }, check: (row) => assert.deepEqual(row.tags, ["a", "b"]) },
      {
        payload: { takenAt: "2030-06-01T12:00:00.000Z" },
        check: (row) => assert.equal(new Date(row.taken_at).toISOString(), "2030-06-01T12:00:00.000Z"),
      },
      { payload: { locationText: "beach" }, check: (row) => assert.equal(row.location_text, "beach") },
      {
        payload: { latitude: 10, longitude: 20 },
        check: (row) => {
          assert.equal(Number(row.latitude), 10);
          assert.equal(Number(row.longitude), 20);
        },
      },
      { payload: { description: null }, check: (row) => assert.equal(row.description, null) },
      { payload: { tags: [] }, check: (row) => assert.deepEqual(row.tags, []) },
      { payload: { latitude: null, longitude: null }, check: (row) => assert.equal(row.latitude, null) },
    ];

    for (const step of steps) {
      const response = await app.inject({
        method: "PATCH",
        url: `/photos/${ctx.photoId}`,
        headers: auth(owner.accessToken),
        payload: step.payload,
      });
      assert.equal(response.statusCode, 200);
      const row = (await pool.query("SELECT * FROM photos WHERE id = $1", [ctx.photoId])).rows[0];
      step.check(row);
      assert.equal(row.status, "processing");
    }

    const before = await pool.query("SELECT content_type, object_key, status FROM photos WHERE id = $1", [ctx.photoId]);
    for (const field of ["contentType", "objectKey", "status"] as const) {
      const bad = await app.inject({
        method: "PATCH",
        url: `/photos/${ctx.photoId}`,
        headers: auth(owner.accessToken),
        payload: { [field]: "x" },
      });
      assert.equal(bad.statusCode, 400);
      assert.deepEqual(bad.json(), INVALID_BODY);
    }
    const after = await pool.query("SELECT content_type, object_key, status FROM photos WHERE id = $1", [ctx.photoId]);
    assert.deepEqual(after.rows[0], before.rows[0]);
  } finally {
    restoreStorage();
  }
});

serial("§10.5 删除与 failDelete 日志", async () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const loggedApp = await buildApp({
    logger: { level: "warn", stream },
    config: testConfig,
    clock,
    pool,
    storage,
    signedUrlTtlSeconds: 900,
  });
  const logSecret = "DELETE-TEST-SECRET-SENTINEL";
  process.env.S3_SECRET_ACCESS_KEY = logSecret;
  try {
    await reset();
    const owner = await registerAccess("s10-5@example.com");
    const first = await uploadJpeg(owner.accessToken, 4, Buffer.from("abcd"));
    await completeHttp(owner.accessToken, first.sessionId);
    storage.deletedKeys.length = 0;
    const removed = await loggedApp.inject({
      method: "DELETE",
      url: `/photos/${first.photoId}`,
      headers: auth(owner.accessToken),
    });
    assert.equal(removed.statusCode, 204);
    assert.equal(removed.body, "");
    assert.equal((await pool.query("SELECT 1 FROM photos WHERE id = $1", [first.photoId])).rowCount, 0);
    assert.equal(storage.deletedKeys.includes(first.objectKey), true);

    storage.failDelete = true;
    const second = await uploadJpeg(owner.accessToken, 4, Buffer.from("efgh"));
    await completeHttp(owner.accessToken, second.sessionId);
    lines.length = 0;
    const still = await loggedApp.inject({
      method: "DELETE",
      url: `/photos/${second.photoId}`,
      headers: auth(owner.accessToken),
    });
    assert.equal(still.statusCode, 204);
    assert.equal((await pool.query("SELECT 1 FROM photos WHERE id = $1", [second.photoId])).rowCount, 0);
    const logs = lines.join("\n");
    assert.match(logs, /删除对象失败/);
    assert.equal(logs.includes(logSecret), false);
    assert.equal(logs.includes(owner.accessToken), false);
    assert.equal(/originalUrl|storage\.invalid\/get\?key=/.test(logs), false);
  } finally {
    restoreStorage();
    await loggedApp.close();
  }
});

serial("§10.6 创建校验与 RAW 白名单", async () => {
  try {
    await reset();
    const owner = await registerAccess("s10-6@example.com");
    for (const byteSize of [0, 33_554_433]) {
      const response = await createUploadHttp(owner.accessToken, "image/jpeg", byteSize);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), INVALID_SIZE);
    }
    const gif = await createUploadHttp(owner.accessToken, "image/gif", 4);
    assert.equal(gif.statusCode, 400);
    assert.deepEqual(gif.json(), UNSUPPORTED_TYPE);

    const extra = await app.inject({
      method: "POST",
      url: "/photos/uploads",
      headers: auth(owner.accessToken),
      payload: { contentType: "image/jpeg", byteSize: 4, extra: true },
    });
    assert.equal(extra.statusCode, 400);
    assert.deepEqual(extra.json(), INVALID_BODY);
    assert.equal(storage.createCalls, 0);

    const badType = await app.inject({
      method: "POST",
      url: "/photos/uploads",
      headers: auth(owner.accessToken),
      payload: { contentType: 123, byteSize: 4 },
    });
    assert.equal(badType.statusCode, 400);
    assert.deepEqual(badType.json(), INVALID_BODY);

    for (const contentType of [
      "image/heic",
      "image/x-canon-cr2",
      "image/x-nikon-nef",
      "image/x-sony-arw",
      "image/x-adobe-dng",
    ]) {
      const ok = await createUploadHttp(owner.accessToken, contentType, 10);
      assert.equal(ok.statusCode, 201, contentType);
    }
  } finally {
    restoreStorage();
  }
});

serial("§10.7 分片完成规则", async () => {
  try {
    await reset();
    const owner = await registerAccess("s10-7@example.com");
    const declared = 5_242_880 + 10;
    const twoPart = await createUploadHttp(owner.accessToken, "image/jpeg", declared);
    assert.equal(twoPart.statusCode, 201);
    const twoId = twoPart.json().upload.id as string;
    const twoKey = twoPart.json().upload.objectKey as string;
    assert.equal((await uploadPartHttp(owner.accessToken, twoId, 1, Buffer.alloc(5_242_880, 1))).statusCode, 200);
    assert.equal((await uploadPartHttp(owner.accessToken, twoId, 2, Buffer.alloc(10, 2))).statusCode, 200);
    assert.equal((await completeHttp(owner.accessToken, twoId)).statusCode, 201);
    assert.equal(storage.completedBytes(twoKey)?.length, declared);

    const single = await createUploadHttp(owner.accessToken, "image/jpeg", 10);
    const singleId = single.json().upload.id as string;
    await uploadPartHttp(owner.accessToken, singleId, 1, Buffer.alloc(10, 3));
    assert.equal((await completeHttp(owner.accessToken, singleId)).statusCode, 201);

    async function expectBadComplete(sessionId: string, photoId: string) {
      const response = await completeHttp(owner.accessToken, sessionId);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), BAD_PART);
      assert.equal((await pool.query("SELECT 1 FROM photos WHERE id = $1", [photoId])).rowCount, 0);
      const status = await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [sessionId]);
      assert.equal(status.rows[0]?.status, "open");
    }

    const badSizes = await createUploadHttp(owner.accessToken, "image/jpeg", 100);
    const badSizesId = badSizes.json().upload.id as string;
    const badPhotoId = badSizes.json().upload.photoId as string;
    await uploadPartHttp(owner.accessToken, badSizesId, 1, Buffer.alloc(40));
    await uploadPartHttp(owner.accessToken, badSizesId, 2, Buffer.alloc(60));
    await expectBadComplete(badSizesId, badPhotoId);

    const shortSum = await createUploadHttp(owner.accessToken, "image/jpeg", 11);
    const shortId = shortSum.json().upload.id as string;
    await uploadPartHttp(owner.accessToken, shortId, 1, Buffer.alloc(10));
    await expectBadComplete(shortId, shortSum.json().upload.photoId);

    const gap = await createUploadHttp(owner.accessToken, "image/jpeg", 100);
    const gapId = gap.json().upload.id as string;
    await uploadPartHttp(owner.accessToken, gapId, 1, Buffer.alloc(50));
    await uploadPartHttp(owner.accessToken, gapId, 3, Buffer.alloc(50));
    await expectBadComplete(gapId, gap.json().upload.photoId);
  } finally {
    restoreStorage();
  }
});

serial("§10.8 覆盖分片字节", async () => {
  try {
    await reset();
    const owner = await registerAccess("s10-8@example.com");
    const created = await createUploadHttp(owner.accessToken, "image/jpeg", 3);
    const sessionId = created.json().upload.id as string;
    const objectKey = created.json().upload.objectKey as string;
    await uploadPartHttp(owner.accessToken, sessionId, 1, Buffer.from("old"));
    await uploadPartHttp(owner.accessToken, sessionId, 1, Buffer.from("new"));
    await completeHttp(owner.accessToken, sessionId);
    assert.equal(storage.completedBytes(objectKey)?.toString(), "new");
  } finally {
    restoreStorage();
  }
});

serial("§10.9 中止与完成状态机", async () => {
  try {
    await reset();
    const owner = await registerAccess("s10-9@example.com");
    const abortedCtx = await uploadJpeg(owner.accessToken, 4, Buffer.from("abcd"));
    await abortHttp(owner.accessToken, abortedCtx.sessionId);
    const afterAbortPart = await uploadPartHttp(owner.accessToken, abortedCtx.sessionId, 1, Buffer.from("zzzz"));
    assert.equal(afterAbortPart.statusCode, 409);
    assert.deepEqual(afterAbortPart.json(), UPLOAD_CLOSED);

    const doneCtx = await uploadJpeg(owner.accessToken, 4, Buffer.from("abcd"));
    const firstDone = await completeHttp(owner.accessToken, doneCtx.sessionId);
    assert.equal(firstDone.statusCode, 201);
    const secondDone = await completeHttp(owner.accessToken, doneCtx.sessionId);
    assert.equal(secondDone.statusCode, 200);
    assert.equal(secondDone.json().photo.id, doneCtx.photoId);

    const abortAfter = await abortHttp(owner.accessToken, doneCtx.sessionId);
    assert.equal(abortAfter.statusCode, 409);
    assert.deepEqual(abortAfter.json(), UPLOAD_COMPLETED);
    assert.equal((await pool.query("SELECT 1 FROM photos WHERE id = $1", [doneCtx.photoId])).rowCount, 1);

    storage.failComplete = true;
    const failCtx = await uploadJpeg(owner.accessToken, 4, Buffer.from("abcd"));
    const failed = await completeHttp(owner.accessToken, failCtx.sessionId);
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(failed.json(), STORAGE_ERROR);
    assert.equal((await pool.query("SELECT 1 FROM photos WHERE id = $1", [failCtx.photoId])).rowCount, 0);
    const reopened = await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [failCtx.sessionId]);
    assert.equal(reopened.rows[0]?.status, "open");
    storage.failComplete = false;
  } finally {
    restoreStorage();
  }
});

serial("§10.10 过期分片触发中止", async () => {
  try {
    await reset();
    const owner = await registerAccess("s10-10@example.com");
    const created = await createUploadHttp(owner.accessToken, "image/jpeg", 4);
    const sessionId = created.json().upload.id as string;
    const expiresAt = created.json().upload.expiresAt as string;
    storage.abortCount = 0;
    clock.set(new Date(new Date(expiresAt).getTime() + 1));
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "s10-10@example.com", password: "correct-horse" },
    });
    assert.equal(login.statusCode, 200);
    const accessToken = String(login.json().accessToken);
    const part = await uploadPartHttp(accessToken, sessionId, 1, Buffer.from("abcd"));
    assert.equal(part.statusCode, 409);
    assert.deepEqual(part.json(), UPLOAD_CLOSED);
    assert.equal(storage.abortCount >= 1, true);
    const status = await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [sessionId]);
    assert.equal(status.rows[0]?.status, "aborted");
  } finally {
    restoreStorage();
  }
});

serial("§10.11 列表 originalUrlExpiresAt TTL", async () => {
  try {
    await reset();
    clock.set(new Date("2031-03-15T10:00:00.000Z"));
    const owner = await registerAccess("s10-11@example.com");
    const ctx = await uploadJpeg(owner.accessToken, 4, Buffer.from("abcd"));
    await completeHttp(owner.accessToken, ctx.sessionId);
    const expected = new Date(clock.now().getTime() + 900_000).toISOString();
    const listed = await app.inject({ method: "GET", url: "/photos", headers: auth(owner.accessToken) });
    const item = listed.json().photos.find((photo: { id: string }) => photo.id === ctx.photoId);
    assert.equal(item.originalUrlExpiresAt, expected);
  } finally {
    restoreStorage();
  }
});

serial("附加 HTTP 边角", async () => {
  try {
    await reset();
    const owner = await registerAccess("s10-edge@example.com");
    const ctx = await uploadJpeg(owner.accessToken, 4, Buffer.from("abcd"));

    const huge = await app.inject({
      method: "PUT",
      url: `/photos/uploads/${ctx.sessionId}/parts/1`,
      headers: { ...auth(owner.accessToken), "content-type": "application/octet-stream" },
      payload: Buffer.alloc(33_554_433),
    });
    assert.equal(huge.statusCode, 413);
    assert.deepEqual(huge.json(), PAYLOAD_TOO_LARGE);

    const wrongType = await app.inject({
      method: "PUT",
      url: `/photos/uploads/${ctx.sessionId}/parts/1`,
      headers: { ...auth(owner.accessToken), "content-type": "text/plain" },
      payload: Buffer.from("abcd"),
    });
    assert.equal(wrongType.statusCode, 400);
    assert.deepEqual(wrongType.json(), BAD_PART);

    const putOk = await uploadPartHttp(owner.accessToken, ctx.sessionId, 1, Buffer.from("put1"), "PUT");
    assert.equal(putOk.statusCode, 200);
    const postOk = await uploadPartHttp(owner.accessToken, ctx.sessionId, 1, Buffer.from("post"), "POST");
    assert.equal(postOk.statusCode, 200);

    const badPath = await app.inject({ method: "GET", url: "/photos/uploads", headers: auth(owner.accessToken) });
    assert.equal(badPath.statusCode, 400);
    assert.deepEqual(badPath.json(), INVALID_ID);

    const badLimit = await app.inject({ method: "GET", url: "/photos?limit=01", headers: auth(owner.accessToken) });
    assert.equal(badLimit.statusCode, 400);
    assert.deepEqual(badLimit.json(), INVALID_BODY);

    const extraQuery = await app.inject({
      method: "GET",
      url: "/photos?unknown=1",
      headers: auth(owner.accessToken),
    });
    assert.equal(extraQuery.statusCode, 400);
    assert.deepEqual(extraQuery.json(), INVALID_BODY);
  } finally {
    restoreStorage();
  }
});

serial("§10.13 完成进行中分片与中止得到 409", async () => {
  const gate = createStorageGate();
  try {
    await reset();
    const owner = await registerAccess("owner13@example.com");
    const { sessionId, photoId } = await uploadJpeg(owner.accessToken, 4, Buffer.from("abcd"));
    const before = await pool.query(
      "select etag, byte_size from upload_parts where upload_session_id = $1 order by part_number",
      [sessionId],
    );
    storage.blockComplete(gate);
    const pending = app.inject({
      method: "POST",
      url: `/photos/uploads/${sessionId}/complete`,
      headers: auth(owner.accessToken),
    });
    await gate.entered;
    const status = await pool.query("select status from upload_sessions where id = $1", [sessionId]);
    assert.equal(status.rows[0].status, "completing");
    const part = await withTimeout(
      app.inject({
        method: "PUT",
        url: `/photos/uploads/${sessionId}/parts/1`,
        headers: { ...auth(owner.accessToken), "content-type": "application/octet-stream" },
        payload: Buffer.from("zzzz"),
      }),
      2000,
    );
    const aborted = await withTimeout(
      app.inject({
        method: "POST",
        url: `/photos/uploads/${sessionId}/abort`,
        headers: auth(owner.accessToken),
      }),
      2000,
    );
    const again = await withTimeout(
      app.inject({
        method: "POST",
        url: `/photos/uploads/${sessionId}/complete`,
        headers: auth(owner.accessToken),
      }),
      2000,
    );
    for (const response of [part, aborted, again]) {
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), UPLOAD_COMPLETING);
    }
    const during = await pool.query(
      "select etag, byte_size from upload_parts where upload_session_id = $1 order by part_number",
      [sessionId],
    );
    assert.deepEqual(during.rows, before.rows);
    assert.equal(storage.completeCalls, 1);
    gate.release();
    const done = await pending;
    assert.equal(done.statusCode, 201);
    assert.equal(done.json().photo.id, photoId);
    assert.equal(done.json().photo.status, "processing");
    const photos = await pool.query("select id, status from photos where id = $1", [photoId]);
    assert.equal(photos.rowCount, 1);
  } finally {
    gate.release();
    restoreStorage();
  }
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
