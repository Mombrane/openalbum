import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import type { User } from "../src/domain/identity/model.js";
import type { LibraryActor } from "../src/domain/library/model.js";
import { completeUpload } from "../src/adapters/library/complete-upload.js";
import { createUpload } from "../src/adapters/library/create-upload.js";
import type { LibraryDeps } from "../src/adapters/library/deps.js";
import { deletePhoto } from "../src/adapters/library/delete-photo.js";
import { getPhoto } from "../src/adapters/library/get-photo.js";
import { listPhotos } from "../src/adapters/library/list-photos.js";
import { patchPhoto } from "../src/adapters/library/patch-photo.js";
import { uploadPart } from "../src/adapters/library/upload-part.js";
import { decodePhotoCursor } from "../src/domain/library/cursor.js";
import { createPhotoRepository } from "../src/dao/photo-repository.js";
import { createUploadSessionRepository } from "../src/dao/upload-session-repository.js";
import { createUserRepository } from "../src/dao/user-repository.js";
import { createFakeObjectStorage } from "../src/gateways/storage/fake-object-storage.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";
import { ManualClock } from "./manual-clock.js";

const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
const ownerId = "11111111-1111-4111-8111-11111111111a";
const otherId = "22222222-2222-4222-8222-222222222222";
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

function actor(userId = ownerId): LibraryActor {
  return { userId, credentialKind: "password_session", credentialId: userId };
}

async function seedUser(userId: string, email: string): Promise<void> {
  const users = createUserRepository(pool);
  const user: User = {
    id: userId,
    email,
    passwordHash: "$argon2id$dummy",
    createdAt: START,
  };
  assert.equal(await users.insert(user), "ok");
}

async function completeOnePhoto(byteSize = 4, userId = ownerId): Promise<string> {
  const created = await createUpload(deps, actor(userId), { contentType: "image/jpeg", byteSize }, clock.now());
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("create failed");
  const sessionId = created.body.upload.id;
  const photoId = created.body.upload.photoId;
  await uploadPart(deps, actor(userId), { sessionId, partNumber: 1, body: Buffer.from("a".repeat(byteSize)) }, clock.now());
  const done = await completeUpload(deps, actor(userId), sessionId, clock.now());
  assert.equal(done.ok, true);
  return photoId;
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

serial("空库 listPhotos", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser(ownerId, "owner@example.com");
  const listed = await listPhotos(deps, actor(), { limit: 50, cursor: null }, clock.now());
  assert.equal(listed.ok, true);
  if (listed.ok) {
    assert.deepEqual(listed.body.photos, []);
    assert.equal(listed.body.nextCursor, null);
  }
});

serial("键集分页与跨用户游标", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser(ownerId, "owner@example.com");
  await seedUser(otherId, "other@example.com");
  const older = await completeOnePhoto(4);
  clock.advance(60_000);
  const newer = await completeOnePhoto(4);
  const page1 = await listPhotos(deps, actor(), { limit: 1, cursor: null }, clock.now());
  assert.equal(page1.ok, true);
  if (!page1.ok) return;
  assert.equal(page1.body.photos.length, 1);
  assert.equal(page1.body.photos[0]?.id, newer);
  assert.ok(page1.body.nextCursor);
  const decoded = decodePhotoCursor(page1.body.nextCursor!);
  assert.ok(decoded);
  assert.equal(decoded!.id, newer);
  assert.equal(decoded!.createdAt.toISOString(), page1.body.photos[0]!.createdAt);
  const page2 = await listPhotos(
    deps,
    actor(),
    { limit: 1, cursor: { createdAt: decoded!.createdAt, id: decoded!.id } },
    clock.now(),
  );
  assert.equal(page2.ok, true);
  if (!page2.ok) return;
  assert.equal(page2.body.photos.length, 1);
  assert.equal(page2.body.photos[0]?.id, older);
  assert.equal(page2.body.nextCursor, null);
  const otherPhoto = await completeOnePhoto(4, otherId);
  const cross = await listPhotos(
    deps,
    actor(otherId),
    { limit: 10, cursor: { createdAt: decoded!.createdAt, id: decoded!.id } },
    clock.now(),
  );
  assert.equal(cross.ok, true);
  if (cross.ok) {
    assert.equal(cross.body.photos.every((photo) => photo.id === otherPhoto), true);
    assert.notEqual(cross.body.photos.some((photo) => photo.id === newer), true);
  }
});

serial("签名 URL 字段与 TTL", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser(ownerId, "owner@example.com");
  const photoId = await completeOnePhoto(4);
  const now = clock.now();
  const got = await getPhoto(deps, actor(), photoId, now);
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.body.photo.originalUrlExpiresAt, new Date(now.getTime() + 900_000).toISOString());
  assert.equal("objectKey" in got.body.photo, false);
  assert.equal("sourceKeyId" in got.body.photo, false);
  assert.equal("sourceUserId" in got.body.photo, false);
});

serial("PATCH 空补丁与 description", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser(ownerId, "owner@example.com");
  const photoId = await completeOnePhoto(4);
  const before = await pool.query("SELECT updated_at, content_type FROM photos WHERE id = $1", [photoId]);
  const empty = await patchPhoto(deps, actor(), photoId, {}, clock.now());
  assert.equal(empty.ok, true);
  const afterEmpty = await pool.query("SELECT updated_at, content_type FROM photos WHERE id = $1", [photoId]);
  assert.equal(afterEmpty.rows[0]?.updated_at.toISOString(), before.rows[0]?.updated_at.toISOString());
  assert.equal(afterEmpty.rows[0]?.content_type, before.rows[0]?.content_type);
  const patchAt = new Date("2030-06-01T00:00:00.000Z");
  const patched = await patchPhoto(deps, actor(), photoId, { description: "sea" }, patchAt);
  assert.equal(patched.ok, true);
  const afterPatch = await pool.query("SELECT updated_at, content_type, description FROM photos WHERE id = $1", [photoId]);
  assert.equal(afterPatch.rows[0]?.updated_at.toISOString(), patchAt.toISOString());
  assert.equal(afterPatch.rows[0]?.content_type, "image/jpeg");
  assert.equal(afterPatch.rows[0]?.description, "sea");
});

serial("deletePhoto 删行与对象", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser(ownerId, "owner@example.com");
  const keepId = await completeOnePhoto(4);
  const deleteId = await completeOnePhoto(4);
  const objectKey = (
    await pool.query("SELECT object_key, thumb_key FROM photos WHERE id = $1", [deleteId])
  ).rows[0]?.object_key as string;
  await pool.query("UPDATE photos SET thumb_key = $2 WHERE id = $1", [keepId, "owners/thumb.jpg"]);
  storage.deletedKeys.length = 0;
  const removed = await deletePhoto(deps, actor(), deleteId);
  assert.equal(removed.ok, true);
  if (removed.ok) assert.equal(removed.status, 204);
  assert.equal((await pool.query("SELECT 1 FROM photos WHERE id = $1", [deleteId])).rowCount, 0);
  assert.equal(storage.deletedKeys.includes(objectKey), true);
  storage.deletedKeys.length = 0;
  const removedKeep = await deletePhoto(deps, actor(), keepId);
  assert.equal(removedKeep.ok, true);
  assert.deepEqual(storage.deletedKeys.sort(), [`owners/${ownerId}/photos/${keepId}/original`, "owners/thumb.jpg"].sort());
  storage.failDelete = true;
  const victim = await completeOnePhoto(4);
  const victimKey = (await pool.query("SELECT object_key FROM photos WHERE id = $1", [victim])).rows[0]?.object_key;
  logEntries.length = 0;
  const still = await deletePhoto(deps, actor(), victim);
  assert.equal(still.ok, true);
  assert.equal((await pool.query("SELECT 1 FROM photos WHERE id = $1", [victim])).rowCount, 0);
  const failLog = logEntries.find((entry) => entry.message === "删除对象失败");
  assert.ok(failLog);
  assert.equal(JSON.stringify(failLog!.fields).includes("hidden"), false);
  assert.equal(storage.deletedKeys.includes(victimKey), true);
});

serial("非主人 404", async () => {
  resetDeps();
  await pool.query("TRUNCATE TABLE users CASCADE");
  await seedUser(ownerId, "owner@example.com");
  await seedUser(otherId, "other@example.com");
  const photoId = await completeOnePhoto(4);
  storage.deletedKeys.length = 0;
  for (const result of [
    await getPhoto(deps, actor(otherId), photoId, clock.now()),
    await patchPhoto(deps, actor(otherId), photoId, { description: "x" }, clock.now()),
    await deletePhoto(deps, actor(otherId), photoId),
  ]) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 404);
      assert.equal(result.message, "未找到");
    }
  }
  assert.equal(storage.deletedKeys.length, 0);
  assert.equal((await pool.query("SELECT 1 FROM photos WHERE id = $1", [photoId])).rowCount, 1);
});
