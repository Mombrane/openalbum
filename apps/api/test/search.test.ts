import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { formatVectorLiteral } from "../src/dao/vector-literal.js";
import { decodeSemanticCursor, encodeKeywordCursor } from "../src/domain/search/index.js";
import type { EmbedGateway } from "../src/domain/library/ports.js";
import { createFakeEmbedGateway } from "../src/gateways/embed/fake-embed.js";
import { deterministicEmbedding } from "../src/gateways/embed/deterministic.js";
import { createFakeObjectStorage } from "../src/gateways/storage/fake-object-storage.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";
import { ManualClock } from "./manual-clock.js";
import { bearer, createApiKey, insertSearchPhoto, registerUser } from "./search-fixtures.js";

const databaseUrl = requireDatabaseUrl();
const START = new Date("2030-03-01T00:00:00.000Z");
const clock = new ManualClock(START);
const pool = new pg.Pool({ connectionString: databaseUrl });
const storage = createFakeObjectStorage();
const embed = createFakeEmbedGateway({ dimensions: 1536 });
let app: Awaited<ReturnType<typeof buildApp>>;

const appConfig = {
  jwtSecret: "test-jwt-secret-at-least-32-bytes",
  pepper: "test-pepper-at-least-32-bytes-ok",
  accessTtlSeconds: 120,
  refreshTtlSeconds: 30 * 24 * 60 * 60,
  databaseUrl,
};

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
    config: appConfig,
    clock,
    pool,
    storage,
    signedUrlTtlSeconds: 900,
    embed,
    embedModel: "fake",
  });
});

test.after(async () => {
  await app.close();
  await pool.end();
});

async function reset(): Promise<void> {
  clock.set(START);
  await pool.query("TRUNCATE TABLE users CASCADE");
}

serial("关键词命中描述或标签，不命中只有地点文本的照片", async () => {
  await reset();
  const owner = await registerUser(app, "keyword-a@example.com");
  const boat = "77777777-7777-4777-8777-777777777771";
  const tagOnly = "77777777-7777-4777-8777-777777777772";
  const place = "77777777-7777-4777-8777-777777777773";
  await insertSearchPhoto(pool, {
    id: boat,
    ownerId: owner.userId,
    description: "Red Boat",
    tags: ["Seaside"],
    createdAt: new Date("2030-03-03T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: tagOnly,
    ownerId: owner.userId,
    description: null,
    tags: ["Seaside"],
    createdAt: new Date("2030-03-02T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: place,
    ownerId: owner.userId,
    description: "湖",
    tags: [],
    locationText: "red harbor",
    createdAt: new Date("2030-03-01T00:00:00.000Z"),
  });
  const red = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "red" },
  });
  assert.equal(red.statusCode, 200);
  assert.deepEqual(red.json().photos.map((photo: { id: string }) => photo.id), [boat]);
  assert.equal(red.json().photos[0].score, null);
  assert.equal(red.json().photos[0].status, "ready");
  const folded = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "Red" },
  });
  assert.deepEqual(folded.json().photos.map((photo: { id: string }) => photo.id), [boat]);
  const side = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "side" },
  });
  assert.deepEqual(side.json().photos.map((photo: { id: string }) => photo.id), [boat, tagOnly]);
});

serial("字面量通配符与不分词", async () => {
  await reset();
  const owner = await registerUser(app, "literal@example.com");
  const literal = "88888888-8888-4888-8888-888888888881";
  const other = "88888888-8888-4888-8888-888888888882";
  const phrase = "88888888-8888-4888-8888-888888888883";
  const split = "88888888-8888-4888-8888-888888888884";
  const underscoreDecoy = "88888888-8888-4888-8888-888888888885";
  const backslashLiteral = "88888888-8888-4888-8888-888888888886";
  const backslashDecoy = "88888888-8888-4888-8888-888888888887";
  await insertSearchPhoto(pool, { id: literal, ownerId: owner.userId, description: "100%_ok", createdAt: START });
  await insertSearchPhoto(pool, { id: underscoreDecoy, ownerId: owner.userId, description: "100%Xok", createdAt: START });
  await insertSearchPhoto(pool, { id: other, ownerId: owner.userId, description: "plain", createdAt: START });
  await insertSearchPhoto(pool, {
    id: backslashLiteral,
    ownerId: owner.userId,
    description: "a\\b",
    createdAt: START,
  });
  await insertSearchPhoto(pool, { id: backslashDecoy, ownerId: owner.userId, description: "ab", createdAt: START });
  await insertSearchPhoto(pool, { id: phrase, ownerId: owner.userId, description: "红 船", createdAt: START });
  await insertSearchPhoto(pool, { id: split, ownerId: owner.userId, description: "红", tags: ["船"], createdAt: START });
  const exact = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "100%_ok" },
  });
  assert.deepEqual(exact.json().photos.map((photo: { id: string }) => photo.id), [literal]);
  const backslash = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "a\\b" },
  });
  assert.deepEqual(backslash.json().photos.map((photo: { id: string }) => photo.id), [backslashLiteral]);
  const percent = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "%" },
  });
  assert.deepEqual(percent.json().photos.map((photo: { id: string }) => photo.id), [underscoreDecoy, literal]);
  const spaced = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "红 船" },
  });
  assert.deepEqual(spaced.json().photos.map((photo: { id: string }) => photo.id), [phrase]);
});

serial("标签与时间过滤，非 ready 不返回", async () => {
  await reset();
  const owner = await registerUser(app, "filter@example.com");
  const both = "99999999-9999-4999-8999-999999999991";
  const lower = "99999999-9999-4999-8999-999999999992";
  const outside = "99999999-9999-4999-8999-999999999993";
  const undated = "99999999-9999-4999-8999-999999999994";
  const processing = "99999999-9999-4999-8999-999999999995";
  const failed = "99999999-9999-4999-8999-999999999996";
  await insertSearchPhoto(pool, {
    id: both,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside", "Trip"],
    takenAt: new Date("2026-06-01T00:00:00.000Z"),
    createdAt: new Date("2030-03-04T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: lower,
    ownerId: owner.userId,
    description: "boat",
    tags: ["seaside"],
    takenAt: new Date("2026-06-01T00:00:00.000Z"),
    createdAt: new Date("2030-03-03T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: outside,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside"],
    takenAt: new Date("2025-01-01T00:00:00.000Z"),
    createdAt: new Date("2030-03-02T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: undated,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside"],
    takenAt: null,
    createdAt: new Date("2030-03-01T00:00:00.000Z"),
  });
  const leftover = Array.from({ length: 1536 }, () => 0.1);
  await insertSearchPhoto(pool, {
    id: processing,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside"],
    status: "processing",
    createdAt: START,
    embedding: leftover,
  });
  await insertSearchPhoto(pool, {
    id: failed,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside"],
    status: "failed",
    createdAt: START,
    embedding: leftover,
  });
  const filtered = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: {
      mode: "keyword",
      q: "boat",
      tags: ["Seaside"],
      takenFrom: "2026-01-01T00:00:00.000Z",
      takenTo: "2026-12-31T23:59:59.999Z",
      status: "ready",
    },
  });
  assert.deepEqual(filtered.json().photos.map((photo: { id: string }) => photo.id), [both]);
  const openEnded = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "boat", tags: ["Seaside"] },
  });
  const openIds = openEnded.json().photos.map((photo: { id: string }) => photo.id);
  assert.equal(openIds.includes(undated), true);
  assert.equal(openIds.includes(processing), false);
  assert.equal(openIds.includes(failed), false);
  assert.equal(openIds.includes(outside), true);
  const explicitReady = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "boat", tags: ["Seaside"], status: "ready" },
  });
  assert.deepEqual(explicitReady.json().photos.map((photo: { id: string }) => photo.id), openIds);
  const badStatus = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "boat", status: "failed" },
  });
  assert.equal(badStatus.statusCode, 400);
  assert.deepEqual(badStatus.json(), { error: { code: "validation_error", message: "请求不合法" } });
  const inverted = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: {
      mode: "keyword",
      q: "boat",
      takenFrom: "2026-12-31T00:00:00.000Z",
      takenTo: "2026-01-01T00:00:00.000Z",
    },
  });
  assert.equal(inverted.statusCode, 400);
  assert.deepEqual(inverted.json(), { error: { code: "validation_error", message: "时间范围不合法" } });
});

serial("JWT 与 API Key 顺序一致，游标不会读出别人的照片", async () => {
  await reset();
  const owner = await registerUser(app, "owner-a@example.com");
  const other = await registerUser(app, "owner-b@example.com");
  const key = await createApiKey(app, owner.accessToken);
  const otherKey = await createApiKey(app, other.accessToken);
  const ownId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const otherId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const ownOld = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
  const ownNewest = new Date("2030-03-04T00:00:00.000Z");
  const otherCreated = new Date("2030-03-03T00:00:00.000Z");
  const ownerOlder = new Date("2030-03-01T00:00:00.000Z");
  await insertSearchPhoto(pool, { id: ownOld, ownerId: owner.userId, description: "Red Boat", createdAt: ownerOlder });
  await insertSearchPhoto(pool, { id: otherId, ownerId: other.userId, description: "Red Boat", createdAt: otherCreated });
  await insertSearchPhoto(pool, { id: ownId, ownerId: owner.userId, description: "Red Boat", createdAt: ownNewest });
  const byJwt = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "red" },
  });
  const byKey = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(key),
    payload: { mode: "keyword", q: "red" },
  });
  const ownerExpected: Array<[string, null]> = [
    [ownId, null],
    [ownOld, null],
  ];
  assert.deepEqual(
    byJwt.json().photos.map((photo: { id: string; score: null }) => [photo.id, photo.score]),
    ownerExpected,
  );
  assert.deepEqual(
    byKey.json().photos.map((photo: { id: string; score: null }) => [photo.id, photo.score]),
    ownerExpected,
  );
  const otherView = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(other.accessToken),
    payload: { mode: "keyword", q: "red" },
  });
  const otherByKey = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(otherKey),
    payload: { mode: "keyword", q: "red" },
  });
  assert.deepEqual(otherView.json().photos.map((photo: { id: string }) => photo.id), [otherId]);
  assert.deepEqual(otherByKey.json().photos.map((photo: { id: string }) => photo.id), [otherId]);
  const stolen = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "red", cursor: encodeKeywordCursor(ownNewest, ownId) },
  });
  assert.equal(stolen.statusCode, 200);
  assert.deepEqual(stolen.json().photos.map((photo: { id: string }) => photo.id), [ownOld]);
});

serial("关键词结果带签名 URL，列表元素没有 score", async () => {
  await reset();
  const owner = await registerUser(app, "signed@example.com");
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  await insertSearchPhoto(pool, {
    id,
    ownerId: owner.userId,
    description: "海边",
    createdAt: START,
  });
  const found = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "海边" },
  });
  const photo = found.json().photos[0];
  assert.equal(photo.status, "ready");
  assert.equal(typeof photo.originalUrl, "string");
  assert.equal(typeof photo.thumbUrl, "string");
  assert.equal(photo.originalUrlExpiresAt, new Date(START.getTime() + 900 * 1000).toISOString());
  assert.equal(photo.thumbUrlExpiresAt, new Date(START.getTime() + 900 * 1000).toISOString());
  assert.equal(Object.hasOwn(photo, "objectKey"), false);
  assert.equal(Object.hasOwn(photo, "thumbKey"), false);
  const listed = await app.inject({ method: "GET", url: "/photos", headers: bearer(owner.accessToken) });
  assert.equal(listed.statusCode, 200);
  assert.equal(Object.hasOwn(listed.json().photos[0], "score"), false);
});

serial("有向量的非 ready 照片不是语义命中，省略 status 与 ready 相同", async () => {
  await reset();
  const owner = await registerUser(app, "semantic-status@example.com");
  const readyId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
  const failedId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
  const processingId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
  const readyNoEmbedId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc4";
  const vector = deterministicEmbedding("red", 1536);
  await insertSearchPhoto(pool, {
    id: readyId,
    ownerId: owner.userId,
    description: "red",
    createdAt: START,
    embedding: vector,
  });
  await insertSearchPhoto(pool, {
    id: failedId,
    ownerId: owner.userId,
    description: "red",
    status: "failed",
    createdAt: START,
    embedding: vector,
  });
  await insertSearchPhoto(pool, {
    id: processingId,
    ownerId: owner.userId,
    description: "red",
    status: "processing",
    createdAt: START,
    embedding: vector,
  });
  await insertSearchPhoto(pool, {
    id: readyNoEmbedId,
    ownerId: owner.userId,
    description: "red",
    createdAt: START,
  });
  const embedInputs: Array<{ model: string; text: string }> = [];
  const recording: EmbedGateway = {
    async embed(input) {
      embedInputs.push({ model: input.model, text: input.text });
      return { ok: true, values: deterministicEmbedding(input.text, 1536) };
    },
  };
  const semanticApp = await buildApp({
    logger: false,
    config: appConfig,
    clock,
    pool,
    storage,
    signedUrlTtlSeconds: 900,
    embed: recording,
    embedModel: "fake",
  });
  try {
    const ready = await semanticApp.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "  red  ", status: "ready" },
    });
    const omitted = await semanticApp.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "  red  " },
    });
    assert.deepEqual(ready.json().photos.map((photo: { id: string }) => photo.id), [readyId]);
    assert.deepEqual(omitted.json().photos.map((photo: { id: string }) => photo.id), [readyId]);
    assert.deepEqual(embedInputs, [
      { model: "fake", text: "red" },
      { model: "fake", text: "red" },
    ]);
  } finally {
    await semanticApp.close();
  }
});

serial("假嵌入按同一文本稳定排序并分页，关键词游标不能用于语义", async () => {
  await reset();
  const owner = await registerUser(app, "semantic-order@example.com");
  const redA = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
  const redB = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
  const blue = "dddddddd-dddd-4ddd-8ddd-ddddddddddd0";
  const redVector = deterministicEmbedding("red", 1536);
  const blueVector = deterministicEmbedding("blue", 1536);
  await insertSearchPhoto(pool, { id: redB, ownerId: owner.userId, description: "later", createdAt: START, embedding: redVector, model: "m1" });
  await insertSearchPhoto(pool, { id: redA, ownerId: owner.userId, description: "earlier", createdAt: START, embedding: redVector, model: "m2" });
  await insertSearchPhoto(pool, { id: blue, ownerId: owner.userId, description: "blue", createdAt: START, embedding: blueVector, model: "m1" });
  const texts: string[] = [];
  const recording: EmbedGateway = {
    async embed(input) {
      texts.push(input.text);
      return { ok: true, values: deterministicEmbedding(input.text, 1536) };
    },
  };
  const semanticApp = await buildApp({
    logger: false,
    config: appConfig,
    clock,
    pool,
    storage,
    signedUrlTtlSeconds: 900,
    embed: recording,
    embedModel: "fake",
  });
  try {
    const first = await semanticApp.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "red" },
    });
    const second = await semanticApp.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "red" },
    });
    assert.deepEqual(texts, ["red", "red"]);
    assert.equal(texts.some((text) => text.includes("\n")), false);
    const expected = await pool.query(
      `SELECT p.id::text AS id,
              round((1 - (e.embedding <=> $2::vector))::numeric, 6)::text AS score_text
       FROM photos p
       INNER JOIN photo_embeddings e ON e.photo_id = p.id
       WHERE p.owner_id = $1 AND p.status = 'ready'
       ORDER BY round((1 - (e.embedding <=> $2::vector))::numeric, 6) DESC, p.id ASC`,
      [owner.userId, formatVectorLiteral(redVector, 1536)],
    );
    const body = first.json();
    const scoreById = new Map(expected.rows.map((row) => [String(row.id), String(row.score_text)]));
    assert.deepEqual(
      body.photos.map((photo: { id: string }) => photo.id),
      expected.rows.map((row) => String(row.id)),
    );
    for (const photo of body.photos as Array<{ id: string; score: number }>) {
      const scoreText = scoreById.get(photo.id);
      assert.ok(scoreText !== undefined);
      assert.equal(photo.score, Number(scoreText));
    }
    assert.deepEqual(
      second.json().photos.map((photo: { id: string; score: number }) => [photo.id, photo.score]),
      body.photos.map((photo: { id: string; score: number }) => [photo.id, photo.score]),
    );
    assert.equal(body.photos[0].id < body.photos[1].id, true);
    assert.equal(body.photos[2].id, blue);
    const blueScoreText = scoreById.get(blue);
    assert.ok(blueScoreText !== undefined);
    assert.equal((body.photos[2] as { score: number }).score, Number(blueScoreText));

    let cursor: string | undefined;
    const fetched: string[] = [];
    const scoreSixDecimal = /^-?(?:0|[1-9]\d*)\.\d{6}$/;
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const page = await semanticApp.inject({
        method: "POST",
        url: "/photos/search",
        headers: bearer(owner.accessToken),
        payload: {
          mode: "semantic",
          q: "red",
          limit: 1,
          ...(cursor !== undefined ? { cursor } : {}),
        },
      });
      assert.equal(page.statusCode, 200);
      const pageBody = page.json();
      assert.equal(pageBody.photos.length, 1);
      const id = pageBody.photos[0].id as string;
      fetched.push(id);
      assert.equal(id, String(expected.rows[pageIndex]?.id));
      const rowScoreText = String(expected.rows[pageIndex]?.score_text);
      assert.equal((pageBody.photos[0] as { score: number }).score, Number(rowScoreText));
      const nextCursor = pageBody.nextCursor as string | null;
      if (pageIndex === 2) {
        assert.equal(id, blue);
        assert.equal(nextCursor, null);
        break;
      }
      assert.ok(nextCursor);
      const decoded = decodeSemanticCursor(nextCursor);
      assert.ok(decoded);
      assert.equal(decoded.id, id);
      assert.equal(decoded.scoreText, rowScoreText);
      assert.equal(scoreSixDecimal.test(decoded.scoreText), true);

      if (pageIndex === 1) {
        const secondRedSqlText = String(expected.rows[1]?.score_text);
        assert.equal(decoded.scoreText, secondRedSqlText);
        const jsFixed = Number((body.photos[1] as { score: number }).score).toFixed(6);
        if (jsFixed !== secondRedSqlText) {
          assert.notEqual(decoded.scoreText, jsFixed);
        }
      }

      cursor = nextCursor;
    }
    assert.deepEqual(fetched, [redA, redB, blue]);
    const keywordCursor = encodeKeywordCursor(START, redA);
    const rejected = await semanticApp.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "red", cursor: keywordCursor },
    });
    assert.equal(rejected.statusCode, 400);
    assert.deepEqual(rejected.json(), { error: { code: "validation_error", message: "请求不合法" } });
  } finally {
    await semanticApp.close();
  }
});

serial("嵌入失败不查询，空查询与超长查询在调用前拒绝", async () => {
  await reset();
  const owner = await registerUser(app, "semantic-error@example.com");
  let sql = 0;
  const original = pool.query.bind(pool);
  pool.query = (async (...args: Parameters<typeof original>) => {
    const text = String(args[0]);
    if (text.includes("<=>")) sql += 1;
    return original(...args);
  }) as typeof pool.query;
  try {
    const unavailable = await buildApp({
      logger: false,
      config: appConfig,
      clock,
      pool,
      storage,
      signedUrlTtlSeconds: 900,
      embed: { async embed() { return { ok: false, kind: "embed_unavailable" }; } },
      embedModel: "fake",
    });
    const down = await unavailable.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "red" },
    });
    assert.equal(down.statusCode, 503);
    assert.deepEqual(down.json(), { error: { code: "embed_unavailable", message: "嵌入暂不可用" } });
    await unavailable.close();
    const rejectedApp = await buildApp({
      logger: false,
      config: appConfig,
      clock,
      pool,
      storage,
      signedUrlTtlSeconds: 900,
      embed: { async embed() { return { ok: true, values: [1, 2, 3] }; } },
      embedModel: "fake",
    });
    const rejected = await rejectedApp.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "red" },
    });
    assert.equal(rejected.statusCode, 502);
    assert.deepEqual(rejected.json(), { error: { code: "embed_rejected", message: "嵌入被拒绝" } });
    assert.equal(JSON.stringify(rejected.json()).includes("1536"), false);
    await rejectedApp.close();
    assert.equal(sql, 0);
    const empty = await app.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "   " },
    });
    assert.equal(empty.statusCode, 400);
    assert.deepEqual(empty.json(), { error: { code: "empty_query", message: "查询为空" } });
    const missing = await app.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic" },
    });
    assert.equal(missing.statusCode, 400);
    assert.deepEqual(missing.json(), { error: { code: "validation_error", message: "请求不合法" } });
    let embedCalls = 0;
    const countingEmbed: EmbedGateway = {
      async embed(input) {
        embedCalls += 1;
        return { ok: true, values: deterministicEmbedding(input.text, 1536) };
      },
    };
    const semanticValidateApp = await buildApp({
      logger: false,
      config: appConfig,
      clock,
      pool,
      storage,
      signedUrlTtlSeconds: 900,
      embed: countingEmbed,
      embedModel: "fake",
    });
    try {
      const tooLong = await semanticValidateApp.inject({
        method: "POST",
        url: "/photos/search",
        headers: bearer(owner.accessToken),
        payload: { mode: "semantic", q: "a".repeat(501) },
      });
      assert.equal(tooLong.statusCode, 400);
      assert.deepEqual(tooLong.json(), { error: { code: "query_too_long", message: "查询过长" } });
      assert.equal(embedCalls, 0);
    } finally {
      await semanticValidateApp.close();
    }
    const anonymous = await app.inject({
      method: "POST",
      url: "/photos/search",
      payload: { mode: "semantic", q: "" },
    });
    assert.equal(anonymous.statusCode, 401);
    assert.deepEqual(anonymous.json(), { error: { code: "unauthorized", message: "未授权" } });
  } finally {
    pool.query = original;
  }
});

serial("同一个未注入嵌入的应用里关键词可用、语义不可用", async () => {
  await reset();
  const plain = await buildApp({
    logger: false,
    config: appConfig,
    clock,
    pool,
    storage,
    signedUrlTtlSeconds: 900,
  });
  try {
    const owner = await registerUser(plain, "no-embed@example.com");
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
    await insertSearchPhoto(pool, { id, ownerId: owner.userId, description: "海边", createdAt: START });
    const keyword = await plain.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "keyword", q: "海边" },
    });
    assert.equal(keyword.statusCode, 200);
    assert.equal(keyword.json().photos[0].id, id);
    assert.equal(keyword.json().photos[0].score, null);
    const semantic = await plain.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "海边" },
    });
    assert.equal(semantic.statusCode, 503);
    assert.deepEqual(semantic.json(), { error: { code: "embed_unavailable", message: "嵌入暂不可用" } });
  } finally {
    await plain.close();
  }
});
