import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Photo } from "../src/api.ts";
import {
  buildPatch,
  saveNotice,
  takenAtFromLocalInput,
  validateCoordinatePair,
  validateDescription,
  validateLocation,
  validateTags,
} from "../src/pages/photo-form.ts";

const PATCH_KEYS = [
  "description",
  "tags",
  "takenAt",
  "locationText",
  "latitude",
  "longitude",
] as const;

function minimalPhoto(overrides: Partial<Photo> = {}): Photo {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    contentType: "image/jpeg",
    byteSize: 1024,
    takenAt: null,
    locationText: null,
    latitude: null,
    longitude: null,
    description: "orig",
    tags: ["t1"],
    status: "ready",
    errorCode: null,
    originalUrl: "https://example.test/o",
    originalUrlExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    thumbUrl: null,
    thumbUrlExpiresAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("validateDescription：trim 后空为 null", () => {
  const r = validateDescription("   ");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.description, null);
});

test("validateDescription：4001 字符失败", () => {
  assert.deepEqual(validateDescription("a".repeat(4001)), {
    ok: false,
    message: "描述不合法",
  });
});

test("validateDescription：U+0001 失败", () => {
  assert.deepEqual(validateDescription("a\u0001b"), {
    ok: false,
    message: "描述不合法",
  });
});

test("validateDescription：制表符与换行允许", () => {
  const r = validateDescription("a\tb\nc");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.description, "a\tb\nc");
});

test("validateLocation：trim 后空为 null", () => {
  const r = validateLocation("  ");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.locationText, null);
});

test("validateLocation：501 字符失败", () => {
  assert.deepEqual(validateLocation("x".repeat(501)), {
    ok: false,
    message: "地点不合法",
  });
});

test("validateTags：丢弃空白、去重保留第一次", () => {
  const r = validateTags(["", "  ", "a", "a", "b"]);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.tags, ["a", "b"]);
});

test("validateTags：第 33 个失败", () => {
  const tags = Array.from({ length: 33 }, (_, i) => `t${i}`);
  assert.deepEqual(validateTags(tags), { ok: false, message: "标签不合法" });
});

test("validateTags：含换行失败", () => {
  assert.deepEqual(validateTags(["ok", "bad\nline"]), {
    ok: false,
    message: "标签不合法",
  });
});

test("validateTags：U+0001 与 U+007F 失败", () => {
  assert.deepEqual(validateTags(["x\u0001"]), { ok: false, message: "标签不合法" });
  assert.deepEqual(validateTags(["x\u007f"]), { ok: false, message: "标签不合法" });
});

test("validateTags：65 码元失败", () => {
  assert.deepEqual(validateTags(["x".repeat(65)]), { ok: false, message: "标签不合法" });
});

test("validateCoordinatePair：都空则两个 null", () => {
  const r = validateCoordinatePair("", "");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.latitude, null);
    assert.equal(r.longitude, null);
  }
});

test("validateCoordinatePair：只填一个", () => {
  assert.deepEqual(validateCoordinatePair("1", ""), {
    ok: false,
    message: "经纬度须成对出现",
  });
  assert.deepEqual(validateCoordinatePair("", "1"), {
    ok: false,
    message: "经纬度须成对出现",
  });
});

test("validateCoordinatePair：91 与 NaN 超出范围", () => {
  assert.deepEqual(validateCoordinatePair("91", "0"), {
    ok: false,
    message: "经纬度超出范围",
  });
  assert.deepEqual(validateCoordinatePair("0", "NaN"), {
    ok: false,
    message: "经纬度超出范围",
  });
});

test("validateCoordinatePair：-90 与 180 通过", () => {
  const r = validateCoordinatePair("-90", "180");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.latitude, -90);
    assert.equal(r.longitude, 180);
  }
});

test("takenAtFromLocalInput：空串为 null", () => {
  const r = takenAtFromLocalInput("");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.takenAt, null);
});

test("takenAtFromLocalInput：not-a-date 失败", () => {
  assert.deepEqual(takenAtFromLocalInput("not-a-date"), {
    ok: false,
    message: "拍摄时间不合法",
  });
});

test("takenAtFromLocalInput：合法 datetime-local 转 ISO", () => {
  const local = "2024-06-15T10:30";
  const r = takenAtFromLocalInput(local);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.takenAt, new Date(local).toISOString());
});

test("buildPatch：正文恰好六键且无多余字段", () => {
  const original = minimalPhoto();
  const r = buildPatch(
    {
      description: "  new  ",
      tags: ["t2"],
      takenAtLocal: "",
      locationText: "here",
      latitude: "",
      longitude: "",
    },
    original,
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(Object.keys(r.body).sort(), [...PATCH_KEYS].sort());
    assert.equal("status" in r.body, false);
    assert.equal("id" in r.body, false);
    assert.equal(r.descriptionChanged, true);
    assert.equal(r.tagsChanged, true);
    assert.equal(r.body.description, "new");
    assert.deepEqual(r.body.tags, ["t2"]);
    assert.equal(r.body.takenAt, null);
    assert.equal(r.body.locationText, "here");
    assert.equal(r.body.latitude, null);
    assert.equal(r.body.longitude, null);
  }
});

test("buildPatch：描述未变时 descriptionChanged 为 false", () => {
  const original = minimalPhoto({ description: "same" });
  const r = buildPatch(
    {
      description: "same",
      tags: ["t1"],
      takenAtLocal: "",
      locationText: "",
      latitude: "",
      longitude: "",
    },
    original,
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.descriptionChanged, false);
});

test("saveNotice", () => {
  assert.equal(
    saveNotice("ready", true, false),
    "已保存。描述或标签变更后会重新嵌入，状态保持已就绪。",
  );
  assert.equal(saveNotice("ready", false, false), "已保存");
  assert.equal(saveNotice("processing", true, false), "已保存");
});

test("photo.tsx 源码：轮询、对话框与无 innerHTML", async () => {
  const photo = await readFile(new URL("../src/pages/photo.tsx", import.meta.url), "utf8");
  assert.match(photo, /\bvalidateTags\b/);
  assert.match(photo, /validateTags\(\[\.\.\.form\.tags,\s*trimmed\]\)/);
  assert.match(photo, /\bgetPhoto\b/);
  assert.match(photo, /document\.hidden/);
  assert.match(photo, /\b5000\b/);
  assert.match(photo, /\bpatchPhoto\b/);
  assert.match(photo, /\bdeletePhoto\b/);
  assert.match(photo, /\bretryPhoto\b/);
  assert.match(photo, /aria-live=["']polite["']/);
  assert.match(photo, /datetime-local/);
  assert.equal(photo.includes("innerHTML"), false);
  assert.equal(photo.includes("dangerouslySetInnerHTML"), false);
  const dialog = await readFile(new URL("../src/pages/dialog.tsx", import.meta.url), "utf8");
  assert.match(dialog, /Escape/);
  assert.match(dialog, /wasOpenRef/);
});

test("App.tsx 挂载 PhotoPage", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /\bPhotoPage\b/);
});
