import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { planSearchSubmit, type SearchFormInput } from "../src/pages/search-query.ts";

const BASE: SearchFormInput = {
  mode: "keyword",
  q: "灯塔",
  tags: [],
  takenFromLocal: "",
  takenToLocal: "",
};

test("planSearchSubmit(false, 任意输入) 为 disabled", () => {
  assert.deepEqual(planSearchSubmit(false, BASE), { type: "disabled" });
  assert.deepEqual(
    planSearchSubmit(false, { ...BASE, q: "   " }),
    { type: "disabled" },
  );
});

test("trim 后空串是「查询为空」", () => {
  const r = planSearchSubmit(true, { ...BASE, q: "   " });
  assert.deepEqual(r, { type: "error", message: "查询为空" });
});

test("501 个码元是「查询过长」", () => {
  const r = planSearchSubmit(true, { ...BASE, q: "a".repeat(501) });
  assert.deepEqual(r, { type: "error", message: "查询过长" });
});

test("500 个 a 通过", () => {
  const q = "a".repeat(500);
  const r = planSearchSubmit(true, { ...BASE, q });
  assert.equal(r.type, "send");
  if (r.type === "send") {
    assert.equal(r.body.q, q);
    assert.equal(r.body.limit, 20);
    assert.equal(r.body.mode, "keyword");
  }
});

test("🙂×251 为 502 码元，失败", () => {
  const q = "🙂".repeat(251);
  assert.equal(q.length, 502);
  const r = planSearchSubmit(true, { ...BASE, q });
  assert.deepEqual(r, { type: "error", message: "查询过长" });
});

test("开始时间晚于结束时间是「时间范围不合法」", () => {
  const r = planSearchSubmit(true, {
    ...BASE,
    takenFromLocal: "2026-06-02T10:00",
    takenToLocal: "2026-06-01T10:00",
  });
  assert.deepEqual(r, { type: "error", message: "时间范围不合法" });
});

test("相等时间通过", () => {
  const r = planSearchSubmit(true, {
    ...BASE,
    takenFromLocal: "2026-06-01T10:00",
    takenToLocal: "2026-06-01T10:00",
  });
  assert.equal(r.type, "send");
  if (r.type === "send") {
    assert.equal(typeof r.body.takenFrom, "string");
    assert.equal(typeof r.body.takenTo, "string");
  }
});

test("没有标签时正文没有 tags", () => {
  const r = planSearchSubmit(true, { ...BASE, tags: [] });
  assert.equal(r.type, "send");
  if (r.type === "send") {
    assert.equal("tags" in r.body, false);
  }
});

test("有标签时正文含 tags", () => {
  const r = planSearchSubmit(true, { ...BASE, tags: ["海", "灯塔"] });
  assert.equal(r.type, "send");
  if (r.type === "send") {
    assert.deepEqual(r.body.tags, ["海", "灯塔"]);
  }
});

test("标签不合法", () => {
  const r = planSearchSubmit(true, { ...BASE, tags: ["a\u0000"] });
  assert.deepEqual(r, { type: "error", message: "标签不合法" });
});

test("拍摄时间不合法", () => {
  const r = planSearchSubmit(true, { ...BASE, takenFromLocal: "not-a-date" });
  assert.deepEqual(r, { type: "error", message: "拍摄时间不合法" });
});

test("没有结束时间时不出现 takenTo", () => {
  const r = planSearchSubmit(true, {
    ...BASE,
    takenFromLocal: "2026-06-01T10:00",
    takenToLocal: "",
  });
  assert.equal(r.type, "send");
  if (r.type === "send") {
    assert.equal(typeof r.body.takenFrom, "string");
    assert.equal("takenTo" in r.body, false);
  }
});

test("没有开始时间时不出现 takenFrom", () => {
  const r = planSearchSubmit(true, {
    ...BASE,
    takenFromLocal: "",
    takenToLocal: "2026-06-01T10:00",
  });
  assert.equal(r.type, "send");
  if (r.type === "send") {
    assert.equal("takenFrom" in r.body, false);
    assert.equal(typeof r.body.takenTo, "string");
  }
});

test("cursor 只在非空字符串时出现", () => {
  const noCursor = planSearchSubmit(true, BASE);
  assert.equal(noCursor.type, "send");
  if (noCursor.type === "send") {
    assert.equal("cursor" in noCursor.body, false);
  }
  const withCursor = planSearchSubmit(true, { ...BASE, cursor: "abc" });
  assert.equal(withCursor.type, "send");
  if (withCursor.type === "send") {
    assert.equal(withCursor.body.cursor, "abc");
  }
  const emptyCursor = planSearchSubmit(true, { ...BASE, cursor: "" });
  assert.equal(emptyCursor.type, "send");
  if (emptyCursor.type === "send") {
    assert.equal("cursor" in emptyCursor.body, false);
  }
});

test("body 无禁止键", () => {
  const r = planSearchSubmit(true, {
    ...BASE,
    mode: "semantic",
    tags: ["t"],
    takenFromLocal: "2026-01-01T00:00",
    takenToLocal: "2026-12-31T23:59",
    cursor: "cur",
  });
  assert.equal(r.type, "send");
  if (r.type === "send") {
    for (const forbidden of ["status", "offset", "topK", "albumId"] as const) {
      assert.equal(forbidden in r.body, false);
    }
  }
});

test("features.ts 开关", async () => {
  const source = await readFile(new URL("../src/features.ts", import.meta.url), "utf8");
  assert.match(source, /export const searchCallsEnabled = true;/);
  assert.match(source, /export const albumCallsEnabled = false;/);
});

test("api.ts 含 POST /photos/search，无 GET 与 album", async () => {
  const source = await readFile(new URL("../src/api.ts", import.meta.url), "utf8");
  assert.match(source, /\/photos\/search/);
  assert.equal(source.includes("album"), false);
  assert.match(source, /\/api\/photos\/search"[\s\S]{0,160}method:\s*"POST"/);
  assert.doesNotMatch(source, /\/api\/photos\/search"[\s\S]{0,160}method:\s*"GET"/);
});

test("search.tsx 调用 planSearchSubmit", async () => {
  const source = await readFile(new URL("../src/pages/search.tsx", import.meta.url), "utf8");
  assert.match(source, /\bplanSearchSubmit\b/);
});
