import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { createSearchRepository } from "../src/dao/index.js";
import { formatVectorLiteral } from "../src/dao/vector-literal.js";
import type { User } from "../src/domain/identity/model.js";
import { keywordPattern } from "../src/domain/search/index.js";
import { createUserRepository } from "../src/dao/user-repository.js";
import { deterministicEmbedding } from "../src/gateways/embed/deterministic.js";
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

test.before(async () => {
  await applySchema(pool);
});

test.after(async () => {
  await pool.end();
});

async function reset(): Promise<void> {
  await pool.query("TRUNCATE TABLE users CASCADE");
}

async function seedUser(userId: string): Promise<void> {
  const users = createUserRepository(pool);
  const user: User = {
    id: userId,
    email: `${userId}@example.com`,
    passwordHash: "hash",
    createdAt: now,
  };
  assert.equal(await users.insert(user), "ok");
}

async function insertPhoto(input: {
  id: string;
  ownerId: string;
  description: string | null;
  tags?: string[];
  status?: "processing" | "ready" | "failed";
  takenAt?: Date | null;
  locationText?: string | null;
  createdAt?: Date;
  embedding?: number[] | null;
  model?: string;
}): Promise<void> {
  const createdAt = input.createdAt ?? now;
  await pool.query(
    `INSERT INTO photos (
       id, owner_id, object_key, thumb_key, content_type, byte_size,
       taken_at, location_text, description, tags, status, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'image/jpeg', 100,
       $5, $6, $7, $8, $9, $10, $10
     )`,
    [
      input.id,
      input.ownerId,
      `owners/${input.ownerId}/photos/${input.id}/original`,
      `owners/${input.ownerId}/photos/${input.id}/thumb`,
      input.takenAt === undefined ? createdAt : input.takenAt,
      input.locationText ?? null,
      input.description,
      input.tags ?? [],
      input.status ?? "ready",
      createdAt,
    ],
  );
  if (input.embedding) {
    await pool.query(
      `INSERT INTO photo_embeddings (photo_id, embedding, model) VALUES ($1, $2::vector, $3)`,
      [input.id, formatVectorLiteral(input.embedding, 1536), input.model ?? "model-a"],
    );
  }
}

const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";

serial("关键词命中描述或标签，不命中地点、别人、非 ready，并按键集翻页", async () => {
  await reset();
  await seedUser(ownerA);
  await seedUser(ownerB);
  const boat = "33333333-3333-4333-8333-333333333331";
  const side = "33333333-3333-4333-8333-333333333332";
  const place = "33333333-3333-4333-8333-333333333333";
  const other = "33333333-3333-4333-8333-333333333334";
  const processing = "33333333-3333-4333-8333-333333333335";
  await insertPhoto({
    id: boat,
    ownerId: ownerA,
    description: "Red Boat",
    tags: ["Seaside"],
    createdAt: new Date("2030-01-03T00:00:00.000Z"),
  });
  await insertPhoto({
    id: side,
    ownerId: ownerA,
    description: null,
    tags: ["Seaside"],
    createdAt: new Date("2030-01-02T00:00:00.000Z"),
  });
  await insertPhoto({
    id: place,
    ownerId: ownerA,
    description: "湖",
    tags: [],
    locationText: "red harbor",
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
  });
  await insertPhoto({ id: other, ownerId: ownerB, description: "Red Boat", tags: ["Seaside"] });
  await insertPhoto({ id: processing, ownerId: ownerA, description: "Red Boat", status: "processing" });
  const search = createSearchRepository(pool);
  const red = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("red"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(red.map((hit) => hit.photo.id), [boat]);
  assert.equal(red[0]?.scoreText, null);
  assert.equal(red[0]?.photo.status, "ready");
  const folded = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("Red"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(folded.map((hit) => hit.photo.id), [boat]);
  const byTag = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("side"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(byTag.map((hit) => hit.photo.id), [boat, side]);
  const page = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("side"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: { createdAt: byTag[0]!.photo.createdAt, id: byTag[0]!.photo.id },
    limit: 10,
  });
  assert.deepEqual(page.map((hit) => hit.photo.id), [side]);
});

serial("百分号与下划线按字面匹配，空格短语不分词", async () => {
  await reset();
  await seedUser(ownerA);
  const literal = "44444444-4444-4444-8444-444444444441";
  const wildcard = "44444444-4444-4444-8444-444444444442";
  const phrase = "44444444-4444-4444-8444-444444444443";
  const split = "44444444-4444-4444-8444-444444444444";
  const slash = "44444444-4444-4444-8444-444444444445";
  await insertPhoto({ id: literal, ownerId: ownerA, description: "100%_ok" });
  await insertPhoto({ id: wildcard, ownerId: ownerA, description: "100XXok" });
  await insertPhoto({ id: phrase, ownerId: ownerA, description: "红 船" });
  await insertPhoto({ id: split, ownerId: ownerA, description: "红", tags: ["船"] });
  await insertPhoto({ id: slash, ownerId: ownerA, description: "a\\b" });
  const search = createSearchRepository(pool);
  const exact = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("100%_ok"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(exact.map((hit) => hit.photo.id), [literal]);
  const percent = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("%"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(percent.map((hit) => hit.photo.id), [literal]);
  const underscore = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("_"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(underscore.map((hit) => hit.photo.id), [literal]);
  const spaced = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("红 船"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(spaced.map((hit) => hit.photo.id), [phrase]);
  const escaped = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("a\\b"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(escaped.map((hit) => hit.photo.id), [slash]);
});

serial("标签过滤与拍摄时间是 AND，NULL 拍摄时间在任一端出现时排除", async () => {
  await reset();
  await seedUser(ownerA);
  const both = "55555555-5555-4555-8555-555555555551";
  const lower = "55555555-5555-4555-8555-555555555552";
  const outside = "55555555-5555-4555-8555-555555555553";
  const undated = "55555555-5555-4555-8555-555555555554";
  const from = new Date("2026-01-01T00:00:00.000Z");
  const to = new Date("2026-12-31T23:59:59.999Z");
  await insertPhoto({
    id: both,
    ownerId: ownerA,
    description: "boat",
    tags: ["Seaside", "Trip"],
    takenAt: new Date("2026-06-01T00:00:00.000Z"),
  });
  await insertPhoto({
    id: lower,
    ownerId: ownerA,
    description: "boat",
    tags: ["seaside"],
    takenAt: new Date("2026-06-01T00:00:00.000Z"),
  });
  await insertPhoto({
    id: outside,
    ownerId: ownerA,
    description: "boat",
    tags: ["Seaside", "Trip"],
    takenAt: new Date("2025-06-01T00:00:00.000Z"),
  });
  await insertPhoto({
    id: undated,
    ownerId: ownerA,
    description: "boat",
    tags: ["Seaside", "Trip"],
    takenAt: null,
  });
  const search = createSearchRepository(pool);
  const filtered = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("boat"),
    takenFrom: from,
    takenTo: to,
    tags: ["Seaside", "Trip"],
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(filtered.map((hit) => hit.photo.id), [both]);
  const open = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("boat"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.equal(open.some((hit) => hit.photo.id === undated), true);
  const onlyFrom = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("boat"),
    takenFrom: from,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.equal(onlyFrom.some((hit) => hit.photo.id === undated), false);
});

serial("语义按余弦相似度排序，排除非 ready 与无向量，不按 model 过滤", async () => {
  await reset();
  await seedUser(ownerA);
  const redOld = "66666666-6666-4666-8666-666666666661";
  const redNew = "66666666-6666-4666-8666-666666666662";
  const blue = "66666666-6666-4666-8666-666666666663";
  const failed = "66666666-6666-4666-8666-666666666664";
  const bare = "66666666-6666-4666-8666-666666666665";
  const redVector = deterministicEmbedding("red", 1536);
  const blueVector = deterministicEmbedding("blue", 1536);
  await insertPhoto({ id: redNew, ownerId: ownerA, description: "red", embedding: redVector, model: "new-model" });
  await insertPhoto({ id: redOld, ownerId: ownerA, description: "red", embedding: redVector, model: "old-model" });
  await insertPhoto({ id: blue, ownerId: ownerA, description: "blue", embedding: blueVector, model: "new-model" });
  await insertPhoto({ id: failed, ownerId: ownerA, description: "red", status: "failed", embedding: redVector });
  await insertPhoto({ id: bare, ownerId: ownerA, description: "red", embedding: null });
  const search = createSearchRepository(pool);
  const hits = await search.searchSemantic({
    ownerId: ownerA,
    values: redVector,
    dimensions: 1536,
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(hits.map((hit) => hit.photo.id), [redOld, redNew, blue]);
  assert.equal(hits[0]?.scoreText, "1.000000");
  assert.equal(hits[1]?.scoreText, "1.000000");
  assert.match(hits[2]?.scoreText ?? "", /^-?(?:0|[1-9]\d*)\.\d{6}$/);
  assert.notEqual(hits[2]?.scoreText, "1.000000");
  const second = await search.searchSemantic({
    ownerId: ownerA,
    values: redVector,
    dimensions: 1536,
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: { scoreText: hits[0]!.scoreText ?? "", id: hits[0]!.photo.id },
    limit: 10,
  });
  assert.deepEqual(second.map((hit) => hit.photo.id), [redNew, blue]);
  const expected = await pool.query(
    `SELECT p.id::text AS id
     FROM photos p
     INNER JOIN photo_embeddings e ON e.photo_id = p.id
     WHERE p.owner_id = $1 AND p.status = 'ready'
     ORDER BY round((1 - (e.embedding <=> $2::vector))::numeric, 6) DESC, p.id ASC`,
    [ownerA, formatVectorLiteral(redVector, 1536)],
  );
  assert.deepEqual(
    hits.map((hit) => hit.photo.id),
    expected.rows.map((row) => String(row.id)),
  );
});

serial("向量字面量在发 SQL 前拒绝坏向量", async () => {
  await reset();
  const search = createSearchRepository(pool);
  await assert.rejects(
    () =>
      search.searchSemantic({
        ownerId: ownerA,
        values: [1, 2, 3],
        dimensions: 1536,
        takenFrom: null,
        takenTo: null,
        tags: null,
        cursor: null,
        limit: 1,
      }),
    (error: unknown) => error instanceof Error && error.name === "DimensionMismatch",
  );
  const huge = deterministicEmbedding("red", 1536);
  huge[0] = 1e21;
  await assert.rejects(
    () =>
      search.searchSemantic({
        ownerId: ownerA,
        values: huge,
        dimensions: 1536,
        takenFrom: null,
        takenTo: null,
        tags: null,
        cursor: null,
        limit: 1,
      }),
    (error: unknown) => error instanceof Error && error.name === "InvalidEmbedding",
  );
});

serial("检索 SQL 使用余弦距离，不按 model 过滤，也不建近似索引语句", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/dao/search-repository.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /<=>/);
  assert.equal(source.includes("<->"), false);
  assert.equal(source.includes("<#>"), false);
  assert.equal(source.includes("e.model"), false);
  assert.equal(/using\s+hnsw/i.test(source), false);
  assert.equal(/ivfflat/i.test(source), false);
  const ilikeEscapeClauses = source.match(/ILIKE \$5 ESCAPE '\\\\'/g);
  assert.equal(ilikeEscapeClauses?.length, 2);
});
