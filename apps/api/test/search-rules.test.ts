import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeKeywordCursor,
  decodeSemanticCursor,
  encodeKeywordCursor,
  encodeSemanticCursor,
  keywordPattern,
  parseSearchBody,
} from "../src/domain/search/index.js";

test("空查询与缺失 q 的原因不同，500 个码元合法", () => {
  assert.equal(parseSearchBody({ mode: "keyword" }).ok, false);
  const missing = parseSearchBody({ mode: "keyword", q: 1 });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "invalid_body");
  const empty = parseSearchBody({ mode: "keyword", q: "   " });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, "empty_query");
  const exact = parseSearchBody({ mode: "keyword", q: "啊".repeat(500) });
  assert.equal(exact.ok, true);
  if (exact.ok) assert.equal(exact.query.q, "啊".repeat(500));
  const emoji = parseSearchBody({ mode: "semantic", q: "😀".repeat(250) });
  assert.equal(emoji.ok, true);
  const tooLong = parseSearchBody({ mode: "keyword", q: `${"😀".repeat(250)}a` });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.reason, "query_too_long");
  const kept = parseSearchBody({ mode: "keyword", q: "  红 船  " });
  assert.equal(kept.ok, true);
  if (kept.ok) assert.equal(kept.query.q, "红 船");
});

test("未知键、status、limit 与 mode", () => {
  for (const key of ["semantic", "topK", "offset", "image", "albumId", "ownerId", "sort", "threshold"]) {
    const parsed = parseSearchBody({ mode: "keyword", q: "海", [key]: 1 });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.reason, "invalid_body");
  }
  const ready = parseSearchBody({ mode: "keyword", q: "海", status: "ready" });
  assert.equal(ready.ok, true);
  const omitted = parseSearchBody({ mode: "semantic", q: "海" });
  assert.equal(omitted.ok, true);
  if (omitted.ok) assert.equal(omitted.query.limit, 50);
  for (const status of ["processing", "failed", null, ["ready"]]) {
    const parsed = parseSearchBody({ mode: "keyword", q: "海", status });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.reason, "invalid_body");
  }
  for (const limit of ["20", 0, 101, 1.5, null]) {
    const parsed = parseSearchBody({ mode: "keyword", q: "海", limit });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.reason, "invalid_body");
  }
  const page = parseSearchBody({ mode: "keyword", q: "海", limit: 1 });
  assert.equal(page.ok, true);
  if (page.ok) assert.equal(page.query.limit, 1);
  assert.equal(parseSearchBody({ q: "海" }).ok, false);
  assert.equal(parseSearchBody({ mode: "both", q: "海" }).ok, false);
});

test("时间区间与标签", () => {
  const same = parseSearchBody({
    mode: "keyword",
    q: "海",
    takenFrom: "2026-01-01T00:00:00.000Z",
    takenTo: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(same.ok, true);
  if (same.ok) assert.equal(same.query.takenFrom?.toISOString(), "2026-01-01T00:00:00.000Z");
  const inverted = parseSearchBody({
    mode: "keyword",
    q: "海",
    takenFrom: "2026-02-01T00:00:00.000Z",
    takenTo: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(inverted.ok, false);
  if (!inverted.ok) assert.equal(inverted.reason, "invalid_range");
  for (const takenFrom of [null, 1, "2026-01-01"]) {
    const parsed = parseSearchBody({ mode: "keyword", q: "海", takenFrom });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.reason, "invalid_time");
  }
  const none = parseSearchBody({ mode: "keyword", q: "海" });
  assert.equal(none.ok, true);
  if (none.ok) {
    assert.equal(none.query.takenFrom, null);
    assert.equal(none.query.takenTo, null);
    assert.equal(none.query.tags, null);
  }
  const emptyTags = parseSearchBody({ mode: "keyword", q: "海", tags: [] });
  assert.equal(emptyTags.ok, true);
  if (emptyTags.ok) assert.equal(emptyTags.query.tags, null);
  const tags = parseSearchBody({ mode: "keyword", q: "海", tags: [" Seaside ", "Seaside", "Trip"] });
  assert.equal(tags.ok, true);
  if (tags.ok) assert.deepEqual(tags.query.tags, ["Seaside", "Trip"]);
  const badTags = parseSearchBody({ mode: "keyword", q: "海", tags: ["a\u0000"] });
  assert.equal(badTags.ok, false);
  if (!badTags.ok) assert.equal(badTags.reason, "invalid_tags");
  const nullTags = parseSearchBody({ mode: "keyword", q: "海", tags: null });
  assert.equal(nullTags.ok, false);
  if (!nullTags.ok) assert.equal(nullTags.reason, "invalid_tags");
});

test("keywordPattern 先转义反斜杠", () => {
  assert.equal(keywordPattern("100%_ok"), "%100\\%\\_ok%");
  assert.equal(keywordPattern("a\\b%_"), "%a\\\\b\\%\\_%");
  assert.equal(keywordPattern("%"), "%\\%%");
  assert.equal(keywordPattern("_"), "%\\_%");
});

test("游标往返，关键词游标不能当语义游标，拒绝 -0.000000", () => {
  const createdAt = new Date("2026-11-06T02:31:00.000Z");
  const id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAA1";
  const keyword = encodeKeywordCursor(createdAt, id);
  assert.equal(keyword.includes("="), false);
  const decoded = decodeKeywordCursor(keyword);
  assert.equal(decoded?.createdAt.toISOString(), createdAt.toISOString());
  assert.equal(decoded?.id, id.toLowerCase());
  assert.equal(decodeSemanticCursor(keyword), null);
  const semantic = encodeSemanticCursor("1.000000", id);
  assert.equal(decodeSemanticCursor(semantic)?.scoreText, "1.000000");
  assert.equal(decodeSemanticCursor(semantic)?.id, id.toLowerCase());
  assert.equal(decodeKeywordCursor(semantic), null);
  assert.equal(decodeSemanticCursor(encodeSemanticCursor("-0.000000", id)), null);
  assert.equal(decodeSemanticCursor(encodeSemanticCursor("00.100000", id)), null);
  assert.equal(decodeSemanticCursor(encodeSemanticCursor("-0.250000", id))?.scoreText, "-0.250000");
  assert.equal(decodeKeywordCursor(""), null);
  assert.equal(decodeKeywordCursor(`${keyword}=`), null);
  const listCursor = Buffer.from(`${createdAt.toISOString()}\n${id.toLowerCase()}`, "utf8").toString("base64url");
  const reused = parseSearchBody({ mode: "keyword", q: "海", cursor: listCursor });
  assert.equal(reused.ok, false);
  if (!reused.ok) assert.equal(reused.reason, "invalid_body");
  const wrongMode = parseSearchBody({ mode: "semantic", q: "海", cursor: keyword });
  assert.equal(wrongMode.ok, false);
  if (!wrongMode.ok) assert.equal(wrongMode.reason, "invalid_body");
  const okSemantic = parseSearchBody({ mode: "semantic", q: "海", cursor: semantic });
  assert.equal(okSemantic.ok, true);
  if (okSemantic.ok && okSemantic.query.mode === "semantic") {
    assert.equal(okSemantic.query.cursor?.scoreText, "1.000000");
  }
});
