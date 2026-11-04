import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import type { User } from "../src/domain/identity/model.js";
import type { LibraryActor } from "../src/domain/library/model.js";
import { abortUpload } from "../src/adapters/library/abort-upload.js";
import { completeUpload } from "../src/adapters/library/complete-upload.js";
import { createUpload } from "../src/adapters/library/create-upload.js";
import type { LibraryDeps } from "../src/adapters/library/deps.js";
import { uploadPart } from "../src/adapters/library/upload-part.js";
import { UPLOAD_TTL_MS } from "../src/domain/library/constants.js";
import { createApiKeyRepository } from "../src/dao/api-key-repository.js";
import { createPhotoRepository } from "../src/dao/photo-repository.js";
import { createUploadSessionRepository } from "../src/dao/upload-session-repository.js";
import { createUserRepository } from "../src/dao/user-repository.js";
import {
  createFakeObjectStorage,
  createStorageGate,
  type FakeObjectStorage,
} from "../src/gateways/storage/fake-object-storage.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";
import { ManualClock } from "./manual-clock.js";

const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
const ownerId = "11111111-1111-4111-8111-11111111111a";
const START = new Date("2030-01-01T00:00:00.000Z");
const clock = new ManualClock(START);

const logEntries: { message: string; fields: Record<string, unknown> }[] = [];
const log = {
  warn(message: string, fields: Record<string, unknown>) {
    logEntries.push({ message, fields });
  },
};

let idCounter = 0;
let storage = createFakeObjectStorage();
let deps: LibraryDeps;

function resetDeps(): void {
  idCounter = 0;
  storage = createFakeObjectStorage();
  storage.blockComplete(null);
  storage.failAbort = false;
  storage.failComplete = false;
  storage.failDelete = false;
  logEntries.length = 0;
  clock.set(START);
  deps = {
    photos: createPhotoRepository(pool),
    sessions: createUploadSessionRepository(pool),
    storage,
    ids: {
      nextId() {
        idCounter += 1;
        return `00000000-0000-4000-8000-${idCounter.toString(16).padStart(12, "0")}`;
      },
    },
    signedUrlTtlSeconds: 900,
    log,
  };
}

function actor(overrides: Partial<LibraryActor> = {}): LibraryActor {
  return {
    userId: ownerId,
    credentialKind: "password_session",
    credentialId: ownerId,
    ...overrides,
  };
}

async function seedUser(): Promise<void> {
  const users = createUserRepository(pool);
  const user: User = {
    id: ownerId,
    email: "owner@example.com",
    passwordHash: "$argon2id$dummy",
    createdAt: START,
  };
  assert.equal(await users.insert(user), "ok");
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

async function createOpenJpeg(byteSize = 4): Promise<{ actor: LibraryActor; sessionId: string; photoId: string }> {
  const created = await createUpload(deps, actor(), { contentType: "image/jpeg", byteSize }, clock.now());
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("create failed");
  return { actor: actor(), sessionId: created.body.upload.id, photoId: created.body.upload.photoId };
}

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
});

test.after(async () => {
  await pool.end();
});

serial("校验 contentType 与 byteSize", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  const gif = await createUpload(deps, actor(), { contentType: "image/gif", byteSize: 0 }, clock.now());
  assert.equal(gif.ok, false);
  if (!gif.ok) assert.equal(gif.message, "不支持的文件类型");
  assert.equal(storage.createCalls, 0);
  const zero = await createUpload(deps, actor(), { contentType: "image/jpeg", byteSize: 0 }, clock.now());
  assert.equal(zero.ok, false);
  if (!zero.ok) assert.equal(zero.message, "文件大小须为 1 字节到 32 MiB");
  const huge = await createUpload(deps, actor(), { contentType: "image/jpeg", byteSize: 33_554_433 }, clock.now());
  assert.equal(huge.ok, false);
  if (!huge.ok) assert.equal(huge.message, "文件大小须为 1 字节到 32 MiB");
  for (const contentType of [
    "image/heic",
    "image/x-canon-cr2",
    "image/x-nikon-nef",
    "image/x-sony-arw",
    "image/x-adobe-dng",
  ]) {
    const ok = await createUpload(deps, actor(), { contentType, byteSize: 10 }, clock.now());
    assert.equal(ok.ok, true, contentType);
  }
});

serial("合法创建返回 201 且不含 s3UploadId", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  const now = clock.now();
  const created = await createUpload(deps, actor(), { contentType: "image/jpeg", byteSize: 100 }, now);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.status, 201);
  const upload = created.body.upload;
  assert.equal(upload.objectKey, `owners/${ownerId}/photos/${upload.photoId}/original`);
  assert.equal(upload.expiresAt, new Date(now.getTime() + UPLOAD_TTL_MS).toISOString());
  assert.equal("s3UploadId" in upload, false);
  const photos = await pool.query("SELECT 1 FROM photos WHERE id = $1", [upload.photoId]);
  assert.equal(photos.rowCount, 0);
  const session = await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [upload.id]);
  assert.equal(session.rows[0]?.status, "open");
});

serial("清扫失败不阻止新会话", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  storage.failAbort = true;
  const expiredId = deps.ids.nextId();
  const expiredPhoto = deps.ids.nextId();
  await deps.sessions.insert({
    id: expiredId,
    ownerId,
    photoId: expiredPhoto,
    objectKey: `owners/${ownerId}/photos/${expiredPhoto}/original`,
    contentType: "image/jpeg",
    byteSize: 10,
    s3UploadId: "old-upload",
    expiresAt: new Date(clock.now().getTime() - 1000),
    createdAt: clock.now(),
  });
  const created = await createUpload(deps, actor(), { contentType: "image/jpeg", byteSize: 10 }, clock.now());
  assert.equal(created.ok, true);
  const old = await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [expiredId]);
  assert.equal(old.rows[0]?.status, "open");
  const sweep = logEntries.find((entry) => entry.message === "清扫中止失败");
  assert.ok(sweep);
  assert.equal(Object.keys(sweep!.fields).includes("message"), false);
});

serial("上传完成写入 photos 与 source 字段", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  const { sessionId, photoId } = await createOpenJpeg(4);
  await uploadPart(deps, actor(), { sessionId, partNumber: 1, body: Buffer.from("abcd") }, clock.now());
  const before = await pool.query("SELECT 1 FROM photos WHERE id = $1", [photoId]);
  assert.equal(before.rowCount, 0);
  const done = await completeUpload(deps, actor(), sessionId, clock.now());
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.status, 201);
  assert.equal(done.body.photo.status, "processing");
  assert.equal(done.body.photo.id, photoId);
  const row = await pool.query("SELECT source_user_id, source_key_id FROM photos WHERE id = $1", [photoId]);
  assert.equal(row.rows[0]?.source_user_id, ownerId);
  assert.equal(row.rows[0]?.source_key_id, null);
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  const second = await createOpenJpeg(4);
  await uploadPart(deps, actor(), { sessionId: second.sessionId, partNumber: 1, body: Buffer.from("abcd") }, clock.now());
  const keyId = "66666666-6666-4666-8666-666666666661";
  const apiKeys = createApiKeyRepository(pool);
  await apiKeys.insert({
    id: keyId,
    userId: ownerId,
    name: "agent",
    keyPrefix: "oalb_test01",
    keyHash: "ab".repeat(32),
    revokedAt: null,
    lastUsedAt: null,
    createdAt: clock.now(),
  });
  const apiDone = await completeUpload(
    deps,
    actor({ credentialKind: "api_key", credentialId: keyId }),
    second.sessionId,
    clock.now(),
  );
  assert.equal(apiDone.ok, true);
  const apiRow = await pool.query("SELECT source_key_id FROM photos WHERE id = $1", [second.photoId]);
  assert.equal(apiRow.rows[0]?.source_key_id, keyId);
});

serial("completing 提交先于 completeMultipartUpload，期间分片与中止得到 409", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  const now = clock.now();
  const { actor: owner, sessionId, photoId } = await createOpenJpeg(4);
  await uploadPart(deps, owner, { sessionId, partNumber: 1, body: Buffer.from("abcd") }, now);
  const before = await pool.query("select etag, byte_size from upload_parts where upload_session_id = $1", [sessionId]);
  const gate = createStorageGate();
  storage.blockComplete(gate);
  const pending = completeUpload(deps, owner, sessionId, now);
  await gate.entered;
  const status = await pool.query("select status from upload_sessions where id = $1", [sessionId]);
  assert.equal(status.rows[0].status, "completing");
  const part = await withTimeout(
    uploadPart(deps, owner, { sessionId, partNumber: 1, body: Buffer.from("zzzz") }, now),
    2000,
  );
  const aborted = await withTimeout(abortUpload(deps, owner, sessionId, now), 2000);
  const again = await withTimeout(completeUpload(deps, owner, sessionId, now), 2000);
  for (const result of [part, aborted, again]) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 409);
      assert.equal(result.code, "upload_completing");
      assert.equal(result.message, "上传正在完成");
    }
  }
  const during = await pool.query("select etag, byte_size from upload_parts where upload_session_id = $1", [sessionId]);
  assert.deepEqual(during.rows, before.rows);
  assert.equal(storage.completeCalls, 1);
  gate.release();
  const done = await pending;
  assert.equal(done.ok, true);
  if (done.ok) assert.equal(done.status, 201);
  const photos = await pool.query("select id from photos where id = $1", [photoId]);
  assert.equal(photos.rowCount, 1);
});

serial("failComplete 回退 open 且无 photos", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  storage.failComplete = true;
  const { sessionId, photoId } = await createOpenJpeg(4);
  await uploadPart(deps, actor(), { sessionId, partNumber: 1, body: Buffer.from("abcd") }, clock.now());
  const done = await completeUpload(deps, actor(), sessionId, clock.now());
  assert.equal(done.ok, false);
  if (!done.ok) {
    assert.equal(done.status, 500);
    assert.equal(done.code, "storage_error");
    assert.equal(done.message, "对象存储不可用");
  }
  const photos = await pool.query("SELECT 1 FROM photos WHERE id = $1", [photoId]);
  assert.equal(photos.rowCount, 0);
  const session = await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [sessionId]);
  assert.equal(session.rows[0]?.status, "open");
});

serial("分片规则失败保持 open", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  const { sessionId } = await createOpenJpeg(100);
  await uploadPart(deps, actor(), { sessionId, partNumber: 1, body: Buffer.from("a".repeat(40)) }, clock.now());
  await uploadPart(deps, actor(), { sessionId, partNumber: 2, body: Buffer.from("b".repeat(60)) }, clock.now());
  const done = await completeUpload(deps, actor(), sessionId, clock.now());
  assert.equal(done.ok, false);
  if (!done.ok) assert.equal(done.message, "分片不合法");
  assert.equal(storage.completeCalls, 0);
  const session = await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [sessionId]);
  assert.equal(session.rows[0]?.status, "open");
});

serial("覆盖分片后完成", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  const { sessionId, photoId } = await createOpenJpeg(6);
  await uploadPart(deps, actor(), { sessionId, partNumber: 1, body: Buffer.from("aa") }, clock.now());
  await uploadPart(deps, actor(), { sessionId, partNumber: 1, body: Buffer.from("bbbbbb") }, clock.now());
  await completeUpload(deps, actor(), sessionId, clock.now());
  assert.equal(
    storage.completedBytes(`owners/${ownerId}/photos/${photoId}/original`)?.toString(),
    "bbbbbb",
  );
});

serial("重复完成与中止状态码", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  const { sessionId, photoId } = await createOpenJpeg(4);
  await uploadPart(deps, actor(), { sessionId, partNumber: 1, body: Buffer.from("abcd") }, clock.now());
  const first = await completeUpload(deps, actor(), sessionId, clock.now());
  assert.equal(first.ok, true);
  const callsAfterFirst = storage.completeCalls;
  const second = await completeUpload(deps, actor(), sessionId, clock.now());
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.status, 200);
    assert.equal(second.body.photo.id, photoId);
  }
  assert.equal(storage.completeCalls, callsAfterFirst);
  const abortAfterDone = await abortUpload(deps, actor(), sessionId, clock.now());
  assert.equal(abortAfterDone.ok, false);
  if (!abortAfterDone.ok) assert.equal(abortAfterDone.code, "upload_completed");
  const fresh = await createOpenJpeg(4);
  const aborted = await abortUpload(deps, actor(), fresh.sessionId, clock.now());
  assert.equal(aborted.ok, true);
  const partAfterAbort = await uploadPart(
    deps,
    actor(),
    { sessionId: fresh.sessionId, partNumber: 1, body: Buffer.from("x") },
    clock.now(),
  );
  assert.equal(partAfterAbort.ok, false);
  if (!partAfterAbort.ok) assert.equal(partAfterAbort.code, "upload_closed");
});

serial("过期 uploadPart 触发中止", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  const { sessionId } = await createOpenJpeg(4);
  clock.advance(UPLOAD_TTL_MS + 1);
  const part = await uploadPart(deps, actor(), { sessionId, partNumber: 1, body: Buffer.from("abcd") }, clock.now());
  assert.equal(part.ok, false);
  if (!part.ok) assert.equal(part.code, "upload_closed");
  assert.equal(storage.abortCount >= 1, true);
  const session = await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [sessionId]);
  assert.equal(session.rows[0]?.status, "aborted");
  const keyRow = await pool.query("SELECT object_key FROM upload_sessions WHERE id = $1", [sessionId]);
  assert.equal(storage.completedBytes(keyRow.rows[0].object_key), null);
});

serial("uploadPart 存储失败返回 storage_error 而非抛错", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  const { sessionId } = await createOpenJpeg(4);
  storage.failUploadPart = true;
  const part = await uploadPart(deps, actor(), { sessionId, partNumber: 1, body: Buffer.from("abcd") }, clock.now());
  assert.equal(part.ok, false);
  if (!part.ok) {
    assert.equal(part.status, 500);
    assert.equal(part.code, "storage_error");
  }
  const rows = await pool.query("SELECT 1 FROM upload_parts WHERE upload_session_id = $1", [sessionId]);
  assert.equal(rows.rowCount, 0);
});

serial("abortUpload 存储中止失败返回 storage_error", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  const { sessionId } = await createOpenJpeg(4);
  storage.failAbort = true;
  const result = await abortUpload(deps, actor(), sessionId, clock.now());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "storage_error");
  const session = await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [sessionId]);
  assert.equal(session.rows[0]?.status, "open");
});

serial("NoSuchUpload 后 headObject 抛错走失败分支", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  const { sessionId } = await createOpenJpeg(4);
  await uploadPart(deps, actor(), { sessionId, partNumber: 1, body: Buffer.from("abcd") }, clock.now());
  storage.completeAsNoSuchUpload = true;
  storage.failHeadObject = true;
  const done = await completeUpload(deps, actor(), sessionId, clock.now());
  assert.equal(done.ok, false);
  if (!done.ok) assert.equal(done.code, "storage_error");
  const session = await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [sessionId]);
  assert.equal(session.rows[0]?.status, "open");
});

serial("listExpiredOpen 失败仍创建新会话", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser();
  const realSessions = createUploadSessionRepository(pool);
  deps.sessions = {
    ...realSessions,
    async listExpiredOpen() {
      throw new Error("list down");
    },
  };
  const created = await createUpload(deps, actor(), { contentType: "image/jpeg", byteSize: 10 }, clock.now());
  assert.equal(created.ok, true);
  assert.ok(logEntries.some((entry) => entry.message === "清扫中止失败"));
});
