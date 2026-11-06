import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { runOnce } from "../src/adapters/pipeline/run-once.js";
import type { PipelineDeps } from "../src/adapters/pipeline/deps.js";
import { createPipelineStore } from "../src/dao/pipeline-store.js";
import { createUserRepository } from "../src/dao/user-repository.js";
import type { User } from "../src/domain/identity/model.js";
import { createFakeEmbedGateway } from "../src/gateways/embed/fake-embed.js";
import { createFakeExifReader } from "../src/gateways/exif/fake-exif-reader.js";
import { createFakeObjectStorage } from "../src/gateways/storage/fake-object-storage.js";
import { createFakeThumbnailEncoder } from "../src/gateways/thumbnail/fake-encoder.js";
import { createFakeVisionGateway } from "../src/gateways/vision/fake-vision.js";
import { createPipelineLogger } from "../src/wire-pipeline.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";

const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
const now = new Date("2030-06-01T00:00:00.000Z");
const ownerId = "11111111-1111-4111-8111-111111111111";
const photoId = "33333333-3333-4333-8333-333333333333";
const jobId = "55555555-5555-4555-8555-555555555555";

test.before(async () => {
  await applySchema(pool);
});

test.after(async () => {
  await pool.end();
});

test("redact 保留身份路径并增加缩略图、base64 和向量", async () => {
  const source = await readFile(new URL("../src/interfaces/http/auth-logger.ts", import.meta.url), "utf8");
  for (const path of [
    "req.body",
    "req.headers.authorization",
    "body",
    "password",
    "refreshToken",
    "secret",
    "accessToken",
    "originalUrl",
    "photo.originalUrl",
    "photos[*].originalUrl",
    "thumbUrl",
    "photo.thumbUrl",
    "photos[*].thumbUrl",
    "dataBase64",
    "embedding",
  ]) {
    assert.equal(source.includes(`"${path}"`), true, path);
  }
});

test("视觉异常的 message 不进入流水线日志", async () => {
  await pool.query("TRUNCATE TABLE users CASCADE");
  const users = createUserRepository(pool);
  const user: User = { id: ownerId, email: "log@example.com", passwordHash: "hash", createdAt: now };
  assert.equal(await users.insert(user), "ok");
  await pool.query(
    `INSERT INTO photos (
       id, owner_id, object_key, content_type, byte_size, tags, status, created_at, updated_at
     ) VALUES ($1, $2, $3, 'image/jpeg', 4, '{}', 'processing', $4, $4)`,
    [photoId, ownerId, `owners/${ownerId}/photos/${photoId}/original`, now],
  );
  await pool.query(
    `INSERT INTO jobs (id, type, photo_id, payload, status, run_after, created_at, updated_at)
     VALUES ($1, 'process_photo', $2, '{"step":"vision"}'::jsonb, 'pending', $3, $3, $3)`,
    [jobId, photoId, now],
  );
  const storage = createFakeObjectStorage();
  await storage.putObject({
    key: `owners/${ownerId}/photos/${photoId}/original`,
    contentType: "image/jpeg",
    body: Buffer.from("orig"),
  });
  const lines: string[] = [];
  const deps: PipelineDeps = {
    store: createPipelineStore(pool),
    storage,
    exif: createFakeExifReader(),
    thumbnail: createFakeThumbnailEncoder(),
    vision: createFakeVisionGateway({
      throwOnCall: Object.assign(new Error("SECRET-KEY X-Amz-Signature dataBase64"), { name: "VisionBoom" }),
    }),
    embed: createFakeEmbedGateway(),
    log: createPipelineLogger((line) => lines.push(line)),
    visionModel: "vision-test",
    embedModel: "embed-test",
    embedDimensions: 1536,
  };
  await runOnce(deps, now, 1);
  const text = lines.join("\n");
  assert.equal(text.includes("视觉调用失败"), true);
  assert.equal(text.includes("VisionBoom"), true);
  assert.equal(text.includes("SECRET-KEY"), false);
  assert.equal(text.includes("X-Amz-Signature"), false);
  assert.equal(text.includes("dataBase64"), false);
});
