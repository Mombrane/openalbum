import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";

const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

test.before(async () => {
  await applySchema(pool);
});

test.after(async () => {
  await pool.end();
});

test("jobs 有 photo_id 级联、locked_at、检查约束与一条未结束任务", async () => {
  const columns = await pool.query(
    `SELECT column_name, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'jobs' AND column_name IN ('photo_id', 'locked_at', 'payload', 'attempts')
     ORDER BY column_name`,
  );
  assert.deepEqual(
    columns.rows.map((row) => `${row.column_name}:${row.is_nullable}`),
    ["attempts:NO", "locked_at:YES", "payload:NO", "photo_id:NO"],
  );

  const constraints = await pool.query(
    `SELECT conname FROM pg_constraint
     WHERE conname IN ('jobs_type', 'jobs_status', 'jobs_attempts', 'jobs_photo_id_fkey')
     ORDER BY conname`,
  );
  assert.deepEqual(constraints.rows.map((row) => row.conname), [
    "jobs_attempts",
    "jobs_photo_id_fkey",
    "jobs_status",
    "jobs_type",
  ]);

  const indexes = await pool.query(
    `SELECT indexname FROM pg_indexes
     WHERE indexname IN ('idx_jobs_poll', 'idx_jobs_photo', 'idx_jobs_one_active')
     ORDER BY indexname`,
  );
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    "idx_jobs_one_active",
    "idx_jobs_photo",
    "idx_jobs_poll",
  ]);

  const uniqueDef = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_jobs_one_active'`,
  );
  assert.match(String(uniqueDef.rows[0].indexdef), /UNIQUE/);
  assert.match(String(uniqueDef.rows[0].indexdef), /pending/);
  assert.match(String(uniqueDef.rows[0].indexdef), /running/);

  const embedding = await pool.query(
    `SELECT atttypmod FROM pg_attribute
     WHERE attrelid = 'photo_embeddings'::regclass AND attname = 'embedding'`,
  );
  assert.equal(embedding.rows[0].atttypmod, 1536);
});

test("env 示例声明超时、1536 维与轮询默认值", async () => {
  const example = await readFile(new URL("../../../deploy/env.example", import.meta.url), "utf8");
  assert.match(example, /^VISION_API_BASE_URL=https:\/\/YOUR_VISION_API_BASE$/m);
  assert.match(example, /^VISION_API_KEY=YOUR_VISION_API_KEY$/m);
  assert.match(example, /^VISION_MODEL=YOUR_VISION_MODEL$/m);
  assert.match(example, /^EMBED_API_BASE_URL=https:\/\/YOUR_EMBED_API_BASE$/m);
  assert.match(example, /^EMBED_API_KEY=YOUR_EMBED_API_KEY$/m);
  assert.match(example, /^EMBED_MODEL=YOUR_EMBED_MODEL$/m);
  assert.match(example, /^S3_BUCKET=YOUR_BUCKET_NAME$/m);
  assert.match(example, /^S3_ACCESS_KEY_ID=YOUR_ACCESS_KEY$/m);
  assert.match(example, /^S3_SECRET_ACCESS_KEY=YOUR_SECRET_KEY$/m);
  assert.match(example, /^VISION_TIMEOUT_MS=60000$/m);
  assert.match(example, /^EMBED_TIMEOUT_MS=30000$/m);
  assert.match(example, /^EMBED_DIMENSIONS=1536$/m);
  assert.match(example, /^PIPELINE_POLL_MS=2000$/m);
  assert.match(example, /^PIPELINE_CONCURRENCY=2$/m);
  const readme = await readFile(new URL("../../../deploy/README.md", import.meta.url), "utf8");
  assert.match(readme, /EMBED_DIMENSIONS/);
  assert.match(readme, /对象存储配置仍是占位符/);
  assert.match(readme, /不读取 `S3_PUBLIC_BASE_URL`/);
});

test("阶段 3 已开工且验收仍未勾选", async () => {
  const phase = await readFile(new URL("../../../specs/phases/03-processing-pipeline.md", import.meta.url), "utf8");
  assert.match(phase, /\*\*状态：\*\* in_progress/);
  assert.equal(phase.includes("- [x]"), false);
  const spec = await readFile(new URL("../../../specs/SPEC.md", import.meta.url), "utf8");
  assert.match(spec, /\| 3 \|.*\| in_progress \|/);
});
