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

test("个人库上传表带 completing 状态与 32 MiB 约束", async () => {
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name IN ('upload_sessions', 'upload_parts')
     ORDER BY table_name`,
  );
  assert.deepEqual(tables.rows.map((row) => row.table_name), ["upload_parts", "upload_sessions"]);

  const constraints = await pool.query(
    `SELECT conname FROM pg_constraint
     WHERE conname IN (
       'upload_sessions_status',
       'upload_sessions_byte_size',
       'upload_parts_part_number',
       'upload_parts_byte_size'
     )
     ORDER BY conname`,
  );
  assert.deepEqual(constraints.rows.map((row) => row.conname), [
    "upload_parts_byte_size",
    "upload_parts_part_number",
    "upload_sessions_byte_size",
    "upload_sessions_status",
  ]);

  const status = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def
     FROM pg_constraint WHERE conname = 'upload_sessions_status'`,
  );
  assert.match(String(status.rows[0].def), /completing/);

  const index = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_upload_sessions_owner_status'`,
  );
  assert.equal(index.rowCount, 1);

  const photoColumns = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'photos' AND column_name IN ('thumb_key', 'error_message', 'object_key')
     ORDER BY column_name`,
  );
  assert.deepEqual(photoColumns.rows.map((row) => row.column_name), ["error_message", "object_key", "thumb_key"]);
});

test("env 示例声明签名 TTL 的默认值与 7 天上限", async () => {
  const example = await readFile(new URL("../../../deploy/env.example", import.meta.url), "utf8");
  assert.match(example, /^S3_SIGNED_URL_TTL=15m$/m);
  assert.match(example, /省略或空白时为 15m/);
  assert.match(example, /大于 7 天（604800 秒）/);
  const readme = await readFile(new URL("../../../deploy/README.md", import.meta.url), "utf8");
  assert.match(readme, /S3_SIGNED_URL_TTL/);
  assert.match(readme, /不读取 `S3_PUBLIC_BASE_URL`/);
});
