import assert from "node:assert/strict";
import test from "node:test";
import {
  checkEmbedding,
  embeddingInput,
  exifFill,
  failureDisposition,
  normalizeVisionDescription,
  normalizeVisionTags,
  PIPELINE_LEASE_MS,
  PIPELINE_MAX_ATTEMPTS,
  semanticChanged,
  shouldCallVision,
  thumbObjectKey,
  ThumbnailEncodeError,
  visionWrite,
} from "../src/domain/library/pipeline.js";

const userId = "11111111-1111-4111-8111-111111111111";
const photoId = "33333333-3333-4333-8333-333333333333";

test("EXIF 只补空字段，坐标必须成对且在范围内", () => {
  const taken = new Date("2020-01-02T03:04:05.000Z");
  const filled = exifFill(
    { takenAt: null, latitude: null, longitude: null },
    { takenAt: taken, latitude: 1.5, longitude: 2.5 },
  );
  assert.equal(filled.takenAt?.toISOString(), taken.toISOString());
  assert.equal(filled.latitude, 1.5);
  assert.equal(filled.longitude, 2.5);

  const kept = exifFill(
    { takenAt: taken, latitude: 9, longitude: 8 },
    { takenAt: new Date("2024-01-01T00:00:00.000Z"), latitude: 1, longitude: 2 },
  );
  assert.equal(Object.hasOwn(kept, "takenAt"), false);
  assert.equal(Object.hasOwn(kept, "latitude"), false);
  assert.equal(Object.hasOwn(kept, "longitude"), false);
  assert.deepEqual(exifFill(
    { takenAt: null, latitude: null, longitude: null },
    { takenAt: null, latitude: 1, longitude: null },
  ), {});
  assert.deepEqual(exifFill(
    { takenAt: null, latitude: null, longitude: null },
    { takenAt: null, latitude: 91, longitude: 0 },
  ), {});
  assert.equal(Object.hasOwn(filled, "locationText"), false);
});

test("视觉描述截断到 4000 且丢掉含非法控制字符的整段，标签最多 32 个", () => {
  assert.equal(normalizeVisionDescription("  海边\n黄昏  "), "海边\n黄昏");
  assert.equal(normalizeVisionDescription("   "), null);
  assert.equal(normalizeVisionDescription("海\u0000边"), null);
  assert.equal(normalizeVisionDescription("a".repeat(4001))?.length, 4000);
  const high = "\uD83D";
  const withSurrogate = `${"a".repeat(3999)}${high}\uDC00`;
  const truncated = normalizeVisionDescription(withSurrogate);
  assert.equal(truncated?.length, 3999);
  assert.equal(truncated?.includes("\uD83D"), false);

  const tags = normalizeVisionTags([" 海 ", "海", "", "a".repeat(65), "黄昏\n", "湖"]);
  assert.deepEqual(tags, ["海", "湖"]);
  const many = normalizeVisionTags(Array.from({ length: 40 }, (_item, index) => `t${index}`));
  assert.equal(many.length, 32);
  assert.equal(many[0], "t0");
  assert.equal(many[31], "t31");
});

test("嵌入文本的三种拼法", () => {
  assert.equal(embeddingInput({ description: null, tags: [] }), "photo");
  assert.equal(embeddingInput({ description: "海边", tags: [] }), "海边");
  assert.equal(embeddingInput({ description: null, tags: ["海", "黄昏"] }), "海, 黄昏");
  assert.equal(embeddingInput({ description: "海边", tags: ["海", "黄昏"] }), "海边\n海, 黄昏");
});

test("维度不符先于非法数，第 5 次可重试失败才终态", () => {
  assert.deepEqual(checkEmbedding([0.1, 0.2], 2), { ok: true });
  assert.deepEqual(checkEmbedding([0.1], 2), { ok: false, code: "dimension_mismatch" });
  assert.deepEqual(checkEmbedding([Number.NaN, 0], 2), { ok: false, code: "invalid_embedding" });
  assert.deepEqual(failureDisposition("vision_unavailable", 1), { outcome: "retry", delayMs: 30_000 });
  assert.deepEqual(failureDisposition("storage", 2), { outcome: "retry", delayMs: 60_000 });
  assert.deepEqual(failureDisposition("embed_unavailable", 3), { outcome: "retry", delayMs: 120_000 });
  assert.deepEqual(failureDisposition("vision_unavailable", 4), { outcome: "retry", delayMs: 240_000 });
  assert.deepEqual(failureDisposition("vision_unavailable", 5), { outcome: "terminal" });
  assert.deepEqual(failureDisposition("vision_rejected", 1), { outcome: "terminal" });
  assert.deepEqual(failureDisposition("thumbnail_failed", 1), { outcome: "terminal" });
  assert.deepEqual(failureDisposition("dimension_mismatch", 1), { outcome: "terminal" });
  assert.equal(PIPELINE_MAX_ATTEMPTS, 5);
  assert.equal(PIPELINE_LEASE_MS, 600_000);
});

test("只有描述或标签的值变了才算语义变化", () => {
  const current = { description: "海边", tags: ["海"] };
  assert.equal(semanticChanged(current, { description: "海边" }), false);
  assert.equal(semanticChanged(current, { description: "湖边" }), true);
  assert.equal(semanticChanged(current, { description: null }), true);
  assert.equal(semanticChanged({ description: null, tags: [] }, { description: null }), false);
  assert.equal(semanticChanged(current, { tags: ["海"] }), false);
  assert.equal(semanticChanged(current, { tags: ["黄昏", "海"] }), true);
  assert.equal(semanticChanged(current, { takenAt: new Date("2020-01-01T00:00:00.000Z") }), false);
  assert.equal(semanticChanged(current, {}), false);
});

test("两个字段都有值时不调用视觉，否则只写出仍为空的字段", () => {
  assert.equal(shouldCallVision({ description: "海边", tags: ["海"] }), false);
  assert.equal(shouldCallVision({ description: null, tags: ["海"] }), true);
  assert.equal(shouldCallVision({ description: "海边", tags: [] }), true);
  assert.deepEqual(
    visionWrite({ description: "用户", tags: [] }, { description: "模型", tags: ["海"] }),
    { description: null, tags: ["海"] },
  );
  assert.deepEqual(
    visionWrite({ description: null, tags: ["用户"] }, { description: "模型", tags: ["海"] }),
    { description: "模型", tags: [] },
  );
});

test("缩略图键与编码错误名", () => {
  assert.equal(thumbObjectKey(userId, photoId), `owners/${userId}/photos/${photoId}/thumb`);
  assert.equal(new ThumbnailEncodeError().name, "ThumbnailEncodeError");
  assert.throws(() => thumbObjectKey("nope", photoId));
});
