import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { searchPhotos } from "../src/adapters/index.js";
import type { SearchDeps, SearchLog } from "../src/adapters/search/deps.js";
import type { LibraryActor } from "../src/domain/library/model.js";
import type { EmbedGateway, ObjectStorage } from "../src/domain/library/ports.js";
import type { SearchHit, SearchPhoto, SearchPort } from "../src/domain/search/ports.js";
import { deterministicEmbedding } from "../src/gateways/embed/deterministic.js";

const actor: LibraryActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  credentialKind: "api_key",
  credentialId: "22222222-2222-4222-8222-222222222222",
};
const now = new Date("2030-01-01T00:00:00.000Z");

function photo(id: string, createdAt: string): SearchPhoto {
  return {
    id,
    ownerId: actor.userId,
    objectKey: `owners/${actor.userId}/photos/${id}/original`,
    thumbKey: `owners/${actor.userId}/photos/${id}/thumb`,
    contentType: "image/jpeg",
    byteSize: 100,
    takenAt: null,
    locationText: null,
    latitude: null,
    longitude: null,
    description: "海边",
    tags: ["黄昏"],
    status: "ready",
    sourceUserId: null,
    sourceKeyId: null,
    errorCode: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function recordingLog(): SearchLog & { lines: Array<{ message: string; fields: unknown }> } {
  const lines: Array<{ message: string; fields: unknown }> = [];
  return {
    lines,
    warn(message, fields) {
      lines.push({ message, fields: { ...fields } });
    },
  };
}

function signingLibrary(events: string[], failOnCall: number | null = null): SearchDeps["library"] {
  let calls = 0;
  const storage = {
    async presignGet(input: { key: string; expiresInSeconds: number; now: Date }) {
      calls += 1;
      events.push("sign");
      if (failOnCall !== null && calls === failOnCall) {
        throw Object.assign(new Error("secret-url"), { name: "StorageDown" });
      }
      const expiresAt = new Date(input.now.getTime() + input.expiresInSeconds * 1000);
      return {
        url: `http://storage.invalid/get?key=${encodeURIComponent(input.key)}&exp=${Math.floor(expiresAt.getTime() / 1000)}`,
        expiresAt,
      };
    },
  } as ObjectStorage;
  return {
    photos: {} as SearchDeps["library"]["photos"],
    sessions: {} as SearchDeps["library"]["sessions"],
    storage,
    ids: { nextId: () => "unused" },
    signedUrlTtlSeconds: 900,
    log: {
      warn(message, fields) {
        events.push(`storage-log:${message}:${fields.errorName ?? ""}`);
      },
    },
  };
}

test("关键词不调用嵌入，默认页大小加 1，score 为 null", async () => {
  const events: string[] = [];
  const seen: Array<{ ownerId: string; limit: number; pattern: string }> = [];
  const hits: SearchHit[] = [
    { photo: photo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "2030-01-01T00:00:00.000Z"), scoreText: null },
  ];
  const port: SearchPort = {
    async searchKeyword(input) {
      events.push("sql");
      seen.push({ ownerId: input.ownerId, limit: input.limit, pattern: input.pattern });
      return hits;
    },
    async searchSemantic() {
      throw new Error("关键词路径不应查询向量");
    },
  };
  let embedCalls = 0;
  const embed: EmbedGateway = {
    async embed() {
      embedCalls += 1;
      return { ok: false, kind: "embed_unavailable" };
    },
  };
  const log = recordingLog();
  const deps: SearchDeps = { port, embed, embedModel: "m", library: signingLibrary(events), log };
  const result = await searchPhotos(deps, actor, { mode: "keyword", q: "  红 船 " }, now);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(embedCalls, 0);
  assert.deepEqual(events, ["sql", "sign", "sign"]);
  assert.equal(seen[0]?.ownerId, actor.userId);
  assert.equal(seen[0]?.limit, 51);
  assert.equal(seen[0]?.pattern, "%红 船%");
  assert.equal(result.body.photos.length, 1);
  assert.equal(result.body.photos[0]?.score, null);
  assert.equal(Object.hasOwn(result.body.photos[0] ?? {}, "score"), true);
  assert.equal(result.body.photos[0]?.originalUrl.startsWith("http://storage.invalid/get?key="), true);
  assert.equal(result.body.nextCursor, null);
});

test("limit 加 1 时用本页最后一条做关键词游标", async () => {
  const first = photo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "2030-01-02T00:00:00.000Z");
  const extra = photo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "2030-01-01T00:00:00.000Z");
  const port: SearchPort = {
    async searchKeyword() {
      return [
        { photo: first, scoreText: null },
        { photo: extra, scoreText: null },
      ];
    },
    async searchSemantic() {
      return [];
    },
  };
  const deps: SearchDeps = {
    port,
    embed: null,
    embedModel: null,
    library: signingLibrary([]),
    log: recordingLog(),
  };
  const result = await searchPhotos(deps, actor, { mode: "keyword", q: "海", limit: 1 }, now);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.body.photos.length, 1);
  assert.equal(result.body.photos[0]?.id, first.id);
  const cursor = Buffer.from(result.body.nextCursor ?? "", "base64url").toString("utf8");
  assert.equal(cursor, `k\n${first.createdAt.toISOString()}\n${first.id}`);
  assert.equal(cursor.includes(extra.id), false);
});

test("语义把 trim 后的 q 原样送进嵌入，按调用、SQL、签名的顺序", async () => {
  const events: string[] = [];
  const texts: string[] = [];
  const values = deterministicEmbedding("海边", 1536);
  const embed: EmbedGateway = {
    async embed(input) {
      events.push("embed");
      texts.push(input.text);
      assert.equal(input.model, "embed-model");
      return { ok: true, values: values.slice() };
    },
  };
  const hitPhoto = photo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "2030-01-01T00:00:00.000Z");
  const port: SearchPort = {
    async searchKeyword() {
      throw new Error("语义路径不应走关键词");
    },
    async searchSemantic(input) {
      events.push("sql");
      assert.equal(input.ownerId, actor.userId);
      assert.equal(input.dimensions, 1536);
      assert.equal(input.limit, 51);
      assert.deepEqual(input.values, values);
      return [{ photo: hitPhoto, scoreText: "1.000000" }];
    },
  };
  const deps: SearchDeps = {
    port,
    embed,
    embedModel: "embed-model",
    library: signingLibrary(events),
    log: recordingLog(),
  };
  const result = await searchPhotos(deps, actor, { mode: "semantic", q: "  海边  " }, now);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(texts, ["海边"]);
  assert.deepEqual(events, ["embed", "sql", "sign", "sign"]);
  assert.equal(result.body.photos[0]?.score, 1);
  assert.equal(result.body.nextCursor, null);
});

test("嵌入失败或结果无效时不查询向量，响应不含查询文本", async () => {
  let sqlCalls = 0;
  const port: SearchPort = {
    async searchKeyword() {
      return [];
    },
    async searchSemantic() {
      sqlCalls += 1;
      return [];
    },
  };
  const log = recordingLog();
  const unavailable: EmbedGateway = {
    async embed() {
      return { ok: false, kind: "embed_unavailable" };
    },
  };
  const deps: SearchDeps = {
    port,
    embed: unavailable,
    embedModel: "m",
    library: signingLibrary([]),
    log,
  };
  const failed = await searchPhotos(deps, actor, { mode: "semantic", q: "海边日落" }, now);
  assert.deepEqual(failed, { ok: false, status: 503, code: "embed_unavailable", message: "嵌入暂不可用" });
  assert.equal(sqlCalls, 0);
  assert.equal(JSON.stringify(failed).includes("海边日落"), false);
  assert.equal(log.lines[0]?.message, "嵌入调用失败");
  assert.deepEqual(log.lines[0]?.fields, { userId: actor.userId, mode: "semantic", errorCode: "embed_unavailable" });

  let calls = 0;
  deps.embed = {
    async embed() {
      calls += 1;
      return { ok: true, values: [1, 2, 3] };
    },
  };
  const rejected = await searchPhotos(deps, actor, { mode: "semantic", q: "海边日落" }, now);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.status, 502);
    assert.equal(rejected.code, "embed_rejected");
    assert.equal(rejected.message, "嵌入被拒绝");
    assert.equal(JSON.stringify(rejected).includes("1536"), false);
  }
  assert.equal(calls, 1);
  assert.equal(sqlCalls, 0);
  assert.equal(log.lines.at(-1)?.message, "嵌入结果无效");
  assert.equal((log.lines.at(-1)?.fields as { errorCode?: string }).errorCode, "dimension_mismatch");
});

test("没有网关是 503，空白模型不调用网关", async () => {
  let calls = 0;
  const embed: EmbedGateway = {
    async embed() {
      calls += 1;
      return { ok: true, values: deterministicEmbedding("海", 1536) };
    },
  };
  const port: SearchPort = {
    async searchKeyword() {
      return [];
    },
    async searchSemantic() {
      throw new Error("不应查询");
    },
  };
  const missing = await searchPhotos(
    { port, embed: null, embedModel: "m", library: signingLibrary([]), log: recordingLog() },
    actor,
    { mode: "semantic", q: "海" },
    now,
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.status, 503);
  const blank = await searchPhotos(
    { port, embed, embedModel: "   ", library: signingLibrary([]), log: recordingLog() },
    actor,
    { mode: "semantic", q: "海" },
    now,
  );
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.code, "embed_rejected");
  assert.equal(calls, 0);
});

test("DAO 的 InvalidEmbedding 收成 502，坏的 score_text 与签名失败都不返回半截列表", async () => {
  const values = deterministicEmbedding("海", 1536);
  const embed: EmbedGateway = {
    async embed() {
      return { ok: true, values };
    },
  };
  const log = recordingLog();
  const port: SearchPort = {
    async searchKeyword() {
      return [];
    },
    async searchSemantic() {
      throw Object.assign(new Error("vector dump 1,2,3"), { name: "InvalidEmbedding" });
    },
  };
  const invalid = await searchPhotos(
    { port, embed, embedModel: "m", library: signingLibrary([]), log },
    actor,
    { mode: "semantic", q: "海" },
    now,
  );
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.code, "embed_rejected");
    assert.equal(JSON.stringify(invalid).includes("vector dump"), false);
  }
  assert.equal((log.lines.at(-1)?.fields as { errorCode?: string }).errorCode, "invalid_embedding");

  port.searchSemantic = async () => [{ photo: photo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "2030-01-01T00:00:00.000Z"), scoreText: "1.0" }];
  const badScore = await searchPhotos(
    { port, embed, embedModel: "m", library: signingLibrary([]), log: recordingLog() },
    actor,
    { mode: "semantic", q: "海" },
    now,
  );
  assert.equal(badScore.ok, false);
  if (!badScore.ok) assert.equal(badScore.code, "internal_error");

  const events: string[] = [];
  port.searchSemantic = async () => [
    { photo: photo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "2030-01-02T00:00:00.000Z"), scoreText: "1.000000" },
    { photo: photo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "2030-01-01T00:00:00.000Z"), scoreText: "0.500000" },
  ];
  const stored = await searchPhotos(
    { port, embed, embedModel: "m", library: signingLibrary(events, 2), log: recordingLog() },
    actor,
    { mode: "semantic", q: "海", limit: 2 },
    now,
  );
  assert.equal(stored.ok, false);
  if (!stored.ok) {
    assert.equal(stored.status, 500);
    assert.equal(stored.code, "storage_error");
    assert.equal(stored.message, "对象存储不可用");
  }
  assert.equal(events.includes("storage-log:对象存储失败:StorageDown"), true);
});

test("解析失败不访问端口，源码不把查询改写成 embeddingInput", async () => {
  let calls = 0;
  const port: SearchPort = {
    async searchKeyword() {
      calls += 1;
      return [];
    },
    async searchSemantic() {
      calls += 1;
      return [];
    },
  };
  const deps: SearchDeps = { port, embed: null, embedModel: null, library: signingLibrary([]), log: recordingLog() };
  const empty = await searchPhotos(deps, actor, { mode: "keyword", q: " " }, now);
  assert.deepEqual(empty, { ok: false, status: 400, code: "empty_query", message: "查询为空" });
  const range = await searchPhotos(
    deps,
    actor,
    { mode: "keyword", q: "海", takenFrom: "2026-02-01T00:00:00.000Z", takenTo: "2026-01-01T00:00:00.000Z" },
    now,
  );
  assert.equal(range.ok, false);
  if (!range.ok) assert.equal(range.message, "时间范围不合法");
  const tags = await searchPhotos(deps, actor, { mode: "keyword", q: "海", tags: [""] }, now);
  assert.equal(tags.ok, false);
  if (!tags.ok) assert.equal(tags.message, "标签不合法");
  assert.equal(calls, 0);
  const source = await readFile(new URL("../src/adapters/search/search-photos.ts", import.meta.url), "utf8");
  assert.equal(source.includes("embeddingInput"), false);
  assert.match(source, /text: query\.q/);
});
