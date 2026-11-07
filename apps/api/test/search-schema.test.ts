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

test("schema 只改嵌入索引注释，不创建 hnsw 或 ivfflat", async () => {
  const schema = await readFile(new URL("../../../deploy/db/schema.sql", import.meta.url), "utf8");
  assert.equal(schema.includes("数据量上来之后再加 IVFFlat / HNSW（Phase 4）。"), false);
  assert.match(schema, /本阶段不建 ANN 索引/);
  assert.match(schema, /100000/);
  assert.match(schema, /200 毫秒/);
  assert.match(schema, /10000/);
  assert.match(schema, /m = 16/);
  assert.match(schema, /ef_construction = 64/);
  assert.match(schema, /2026-11-06-openalbum-phase4-search-design\.md/);
  assert.equal(/using\s+hnsw/i.test(schema), false);
  assert.equal(/ivfflat/i.test(schema), false);

  const indexes = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'photo_embeddings'`,
  );
  const joined = indexes.rows.map((row) => String(row.indexdef)).join("\n");
  assert.equal(/hnsw/i.test(joined), false);
  assert.equal(/ivfflat/i.test(joined), false);

  const embedding = await pool.query(
    `SELECT atttypmod FROM pg_attribute
     WHERE attrelid = 'photo_embeddings'::regclass AND attname = 'embedding'`,
  );
  assert.equal(embedding.rows[0].atttypmod, 1536);
});

test("env 示例不新增变量，并写明 API 也读取 EMBED", async () => {
  const example = await readFile(new URL("../../../deploy/env.example", import.meta.url), "utf8");
  assert.match(example, /^EMBED_PROVIDER=http$/m);
  assert.match(example, /^EMBED_API_BASE_URL=https:\/\/YOUR_EMBED_API_BASE$/m);
  assert.match(example, /^EMBED_API_KEY=YOUR_EMBED_API_KEY$/m);
  assert.match(example, /^EMBED_MODEL=YOUR_EMBED_MODEL$/m);
  assert.match(example, /^EMBED_TIMEOUT_MS=30000$/m);
  assert.match(example, /^EMBED_DIMENSIONS=1536$/m);
  assert.match(example, /API 进程也读取 EMBED_PROVIDER/);
  assert.match(example, /语义检索返回 503/);
  assert.match(example, /嵌入配置仍是占位符/);
  assert.equal(example.includes("SEARCH_"), false);
  assert.equal(example.includes("HNSW_"), false);
});

test("阶段 4 验收完成且状态为 done", async () => {
  const phase = await readFile(new URL("../../../specs/phases/04-search.md", import.meta.url), "utf8");
  assert.match(phase, /\*\*状态：\*\* done/);
  const checked = phase.match(/- \[x\]/g) ?? [];
  assert.ok(checked.length >= 5, "阶段 4 验收项应全部勾选");
  const spec = await readFile(new URL("../../../specs/SPEC.md", import.meta.url), "utf8");
  assert.match(spec, /\| 4 \|.*\| done \|/);
  const design = await readFile(
    new URL("../../../docs/superpowers/specs/2026-11-06-openalbum-phase4-search-design.md", import.meta.url),
    "utf8",
  );
  assert.match(design, /状态：已定稿（待实现）/);
});
