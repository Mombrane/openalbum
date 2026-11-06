import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import type { User } from "../src/domain/identity/model.js";
import { createPhotoRepository } from "../src/dao/photo-repository.js";
import { createUploadSessionRepository } from "../src/dao/upload-session-repository.js";
import { createUserRepository } from "../src/dao/user-repository.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";

const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
const now = new Date("2030-01-01T00:00:00.000Z");

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

async function reset(): Promise<void> {
  await pool.query("TRUNCATE TABLE users CASCADE");
}

async function seedUser(userId: string): Promise<void> {
  const users = createUserRepository(pool);
  const user: User = {
    id: userId,
    email: `${userId}@example.com`,
    passwordHash: "$argon2id$dummy",
    createdAt: now,
  };
  assert.equal(await users.insert(user), "ok");
}

function sessionInput(input: {
  id: string;
  ownerId: string;
  photoId: string;
  byteSize?: number;
  s3UploadId?: string;
  expiresAt?: Date;
  createdAt?: Date;
}) {
  return {
    id: input.id,
    ownerId: input.ownerId,
    photoId: input.photoId,
    objectKey: `owners/${input.ownerId}/photos/${input.photoId}/original`,
    contentType: "image/jpeg",
    byteSize: input.byteSize ?? 1024,
    s3UploadId: input.s3UploadId ?? "s3-upload-1",
    expiresAt: input.expiresAt ?? new Date(now.getTime() + 86_400_000),
    createdAt: input.createdAt ?? now,
  };
}

test.before(async () => {
  await applySchema(pool);
});

test.after(async () => {
  await pool.end();
});

serial("insert 保留调用方 id，transactById 读出 number 类型 byteSize", async () => {
  await reset();
  const ownerId = "11111111-1111-4111-8111-11111111111a";
  const sessionId = "22222222-2222-4222-8222-222222222221";
  const photoId = "33333333-3333-4333-8333-333333333331";
  await seedUser(ownerId);
  const sessions = createUploadSessionRepository(pool);
  await sessions.insert(sessionInput({ id: sessionId, ownerId, photoId, byteSize: 2048, s3UploadId: "upload-abc" }));
  await sessions.transactById(sessionId, async (row) => {
    assert.ok(row);
    assert.equal(row.id, sessionId);
    assert.equal(row.photoId, photoId);
    assert.equal(typeof row.byteSize, "number");
    assert.equal(row.byteSize, 2048);
    assert.equal(row.s3UploadId, "upload-abc");
  });
});

serial("setCompleting 提交后其他连接可见 completing", async () => {
  await reset();
  const ownerId = "11111111-1111-4111-8111-11111111112a";
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const photoId = "33333333-3333-4333-8333-333333333332";
  await seedUser(ownerId);
  const sessions = createUploadSessionRepository(pool);
  await sessions.insert(sessionInput({ id: sessionId, ownerId, photoId }));
  await sessions.transactById(sessionId, async (_row, tx) => {
    await tx.setCompleting(sessionId, now);
  });
  const seen = await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [sessionId]);
  assert.equal(seen.rows[0]?.status, "completing");
});

serial("tryCompletionLock 同会话互斥，release 后可再获取", async () => {
  await reset();
  const ownerId = "11111111-1111-4111-8111-11111111113a";
  const sessionId = "22222222-2222-4222-8222-222222222223";
  const photoId = "33333333-3333-4333-8333-333333333333";
  await seedUser(ownerId);
  const sessions = createUploadSessionRepository(pool);
  await sessions.insert(sessionInput({ id: sessionId, ownerId, photoId }));
  const first = await sessions.tryCompletionLock(sessionId);
  assert.ok(first);
  assert.equal(await sessions.tryCompletionLock(sessionId), null);
  await first!.release();
  const third = await sessions.tryCompletionLock(sessionId);
  assert.ok(third);
  await third!.release();
});

serial("markObjectCompleted 保持 completing；reopenIfNoObject kept 与 reopened", async () => {
  await reset();
  const ownerId = "11111111-1111-4111-8111-11111111114a";
  const keptSessionId = "22222222-2222-4222-8222-222222222224";
  const reopenSessionId = "22222222-2222-4222-8222-222222222225";
  const photoIdA = "33333333-3333-4333-8333-333333333334";
  const photoIdB = "33333333-3333-4333-8333-333333333335";
  await seedUser(ownerId);
  const sessions = createUploadSessionRepository(pool);
  await sessions.insert(sessionInput({ id: keptSessionId, ownerId, photoId: photoIdA }));
  await sessions.insert(sessionInput({ id: reopenSessionId, ownerId, photoId: photoIdB }));
  await sessions.transactById(keptSessionId, async (_row, tx) => {
    await tx.setCompleting(keptSessionId, now);
  });
  await sessions.transactById(reopenSessionId, async (_row, tx) => {
    await tx.setCompleting(reopenSessionId, now);
  });
  await sessions.markObjectCompleted(keptSessionId, now);
  const keptRow = await pool.query(
    "SELECT status, object_completed_at IS NOT NULL AS done FROM upload_sessions WHERE id = $1",
    [keptSessionId],
  );
  assert.equal(keptRow.rows[0]?.status, "completing");
  assert.equal(keptRow.rows[0]?.done, true);
  assert.equal(await sessions.reopenIfNoObject(keptSessionId, now), "kept");
  assert.equal(await sessions.reopenIfNoObject(reopenSessionId, now), "reopened");
  const reopened = await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [reopenSessionId]);
  assert.equal(reopened.rows[0]?.status, "open");
});

serial("insertPhotoAndComplete 写入 processing 并完成会话，重复返回 exists", async () => {
  await reset();
  const ownerId = "11111111-1111-4111-8111-11111111115a";
  const sessionId = "22222222-2222-4222-8222-222222222226";
  const photoId = "33333333-3333-4333-8333-333333333336";
  await seedUser(ownerId);
  const sessions = createUploadSessionRepository(pool);
  const objectKey = `owners/${ownerId}/photos/${photoId}/original`;
  await sessions.insert(sessionInput({ id: sessionId, ownerId, photoId, byteSize: 4096 }));
  await sessions.transactById(sessionId, async (_row, tx) => {
    await tx.setCompleting(sessionId, now);
  });
  await sessions.markObjectCompleted(sessionId, now);
  assert.equal(
    await sessions.insertPhotoAndComplete({
      sessionId,
      photoId,
      ownerId,
      objectKey,
      contentType: "image/jpeg",
      byteSize: 4096,
      sourceUserId: ownerId,
      sourceKeyId: null,
      now,
      jobId: "55555555-5555-4555-8555-555555555551",
    }),
    "inserted",
  );
  const queued = await pool.query(
    `SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1 AND type = 'process_photo'`,
    [photoId],
  );
  assert.equal(queued.rows[0]?.n, 1);
  const photo = await pool.query(
    `SELECT status, tags, thumb_key, error_message, source_user_id, source_key_id
     FROM photos WHERE id = $1`,
    [photoId],
  );
  assert.equal(photo.rows[0]?.status, "processing");
  assert.deepEqual(photo.rows[0]?.tags, []);
  assert.equal(photo.rows[0]?.thumb_key, null);
  assert.equal(photo.rows[0]?.error_message, null);
  assert.equal(photo.rows[0]?.source_user_id, ownerId);
  assert.equal(photo.rows[0]?.source_key_id, null);
  const session = await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [sessionId]);
  assert.equal(session.rows[0]?.status, "completed");
  assert.equal(
    await sessions.insertPhotoAndComplete({
      sessionId,
      photoId,
      ownerId,
      objectKey,
      contentType: "image/jpeg",
      byteSize: 4096,
      sourceUserId: ownerId,
      sourceKeyId: null,
      now,
      jobId: "55555555-5555-4555-8555-555555555552",
    }),
    "exists",
  );
  const count = await pool.query("SELECT count(*)::int AS n FROM photos WHERE id = $1", [photoId]);
  assert.equal(count.rows[0]?.n, 1);
});

serial("listOwned 按 owner 过滤并键集分页", async () => {
  await reset();
  const ownerId = "11111111-1111-4111-8111-11111111116a";
  const otherId = "11111111-1111-4111-8111-11111111116b";
  await seedUser(ownerId);
  await seedUser(otherId);
  const photos = createPhotoRepository(pool);
  const ids = [
    "44444444-4444-4444-8444-444444444441",
    "44444444-4444-4444-8444-444444444442",
    "44444444-4444-4444-8444-444444444443",
  ];
  const times = [
    new Date("2030-01-03T00:00:00.000Z"),
    new Date("2030-01-02T00:00:00.000Z"),
    new Date("2030-01-01T12:00:00.000Z"),
  ];
  for (let index = 0; index < ids.length; index += 1) {
    await pool.query(
      `INSERT INTO photos (id, owner_id, object_key, content_type, byte_size, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'image/jpeg', 100, 'processing', $4, $4)`,
      [ids[index], ownerId, `owners/${ownerId}/photos/${ids[index]}/original`, times[index]],
    );
  }
  await pool.query(
    `INSERT INTO photos (id, owner_id, object_key, content_type, byte_size, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'image/jpeg', 100, 'processing', $4, $4)`,
    ["44444444-4444-4444-8444-444444444499", otherId, `owners/${otherId}/photos/x/original`, now],
  );
  const firstPage = await photos.listOwned({ ownerId, limit: 2, cursor: null });
  assert.equal(firstPage.length, 2);
  assert.equal(firstPage[0]?.id, ids[0]);
  assert.equal(firstPage[1]?.id, ids[1]);
  const secondPage = await photos.listOwned({
    ownerId,
    limit: 2,
    cursor: { createdAt: firstPage[1]!.createdAt, id: firstPage[1]!.id },
  });
  assert.equal(secondPage.length, 1);
  assert.equal(secondPage[0]?.id, ids[2]);
  assert.ok(
    secondPage[0]!.createdAt < firstPage[1]!.createdAt ||
      (secondPage[0]!.createdAt.getTime() === firstPage[1]!.createdAt.getTime() &&
        secondPage[0]!.id < firstPage[1]!.id),
  );
});

serial("updateOwned 局部更新，deleteOwned 校验归属", async () => {
  await reset();
  const ownerId = "11111111-1111-4111-8111-11111111117a";
  const otherId = "11111111-1111-4111-8111-11111111117b";
  const photoId = "55555555-5555-4555-8555-555555555551";
  await seedUser(ownerId);
  await seedUser(otherId);
  const photos = createPhotoRepository(pool);
  const objectKey = `owners/${ownerId}/photos/${photoId}/original`;
  await pool.query(
    `INSERT INTO photos (id, owner_id, object_key, content_type, byte_size, description, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'image/jpeg', 100, 'old', 'processing', $4, $4)`,
    [photoId, ownerId, objectKey, now],
  );
  const updated = await photos.updateOwned(photoId, ownerId, { description: "new" }, new Date("2030-02-01T00:00:00.000Z"));
  assert.equal(updated?.description, "new");
  const row = await pool.query("SELECT location_text FROM photos WHERE id = $1", [photoId]);
  assert.equal(row.rows[0]?.location_text, null);
  assert.equal(await photos.deleteOwned(photoId, otherId), null);
  assert.equal((await pool.query("SELECT 1 FROM photos WHERE id = $1", [photoId])).rowCount, 1);
  const deleted = await photos.deleteOwned(photoId, ownerId);
  assert.deepEqual(deleted, { objectKey, thumbKey: null });
  assert.equal((await pool.query("SELECT 1 FROM photos WHERE id = $1", [photoId])).rowCount, 0);
});
