import assert from "node:assert/strict";
import test from "node:test";
import { CONTENT_TYPES, normalizeContentType } from "../src/domain/library/content-type.js";
import { MAX_PHOTO_BYTES, MIN_NON_FINAL_PART_BYTES } from "../src/domain/library/constants.js";
import { decodePhotoCursor, encodePhotoCursor, parsePhotoLimit } from "../src/domain/library/cursor.js";
import { normalizeMetadataPatch } from "../src/domain/library/metadata-patch.js";
import { photoObjectKey } from "../src/domain/library/object-key.js";
import { validatePartsForComplete } from "../src/domain/library/parts.js";
import { isVisiblePhoto } from "../src/domain/library/visibility.js";

const USER = "11111111-1111-4111-8111-11111111111a";
const PHOTO = "22222222-2222-4222-8222-222222222222";

test("白名单接受九种类型，拒绝参数、空格写法以外的大小写已折叠", () => {
  assert.deepEqual([...CONTENT_TYPES], [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/x-canon-cr2",
    "image/x-nikon-nef",
    "image/x-sony-arw",
    "image/x-adobe-dng",
  ]);
  assert.equal(normalizeContentType(" Image/JPEG "), "image/jpeg");
  assert.equal(normalizeContentType("image/heic"), "image/heic");
  assert.equal(normalizeContentType("image/x-adobe-dng"), "image/x-adobe-dng");
  assert.equal(normalizeContentType("image/jpeg; charset=binary"), null);
  assert.equal(normalizeContentType("image/gif"), null);
  assert.equal(MAX_PHOTO_BYTES, 33_554_432);
  assert.equal(MIN_NON_FINAL_PART_BYTES, 5_242_880);
});

test("对象键使用小写 UUID，拒绝桶名和前导斜杠", () => {
  assert.equal(photoObjectKey(USER, PHOTO), `owners/${USER}/photos/${PHOTO}/original`);
  assert.equal(photoObjectKey(USER, PHOTO).startsWith("/"), false);
  assert.throws(() => photoObjectKey(USER.toUpperCase(), PHOTO), /对象键标识不合法/);
});

test("分片完成规则", () => {
  assert.equal(validatePartsForComplete([{ partNumber: 1, byteSize: 10 }], 10), "ok");
  assert.equal(
    validatePartsForComplete(
      [
        { partNumber: 1, byteSize: MIN_NON_FINAL_PART_BYTES },
        { partNumber: 2, byteSize: 10 },
      ],
      MIN_NON_FINAL_PART_BYTES + 10,
    ),
    "ok",
  );
  assert.equal(
    validatePartsForComplete(
      [
        { partNumber: 2, byteSize: 10 },
        { partNumber: 1, byteSize: MIN_NON_FINAL_PART_BYTES },
      ],
      MIN_NON_FINAL_PART_BYTES + 10,
    ),
    "ok",
  );
  assert.equal(validatePartsForComplete([{ partNumber: 1, byteSize: 40 }, { partNumber: 2, byteSize: 60 }], 100), "invalid");
  assert.equal(validatePartsForComplete([{ partNumber: 1, byteSize: 10 }], 11), "invalid");
  assert.equal(validatePartsForComplete([{ partNumber: 1, byteSize: 10 }, { partNumber: 3, byteSize: 10 }], 20), "invalid");
  assert.equal(validatePartsForComplete([], 0), "invalid");
  const eight = Array.from({ length: 8 }, (_, index) => ({ partNumber: index + 1, byteSize: MIN_NON_FINAL_PART_BYTES }));
  assert.equal(validatePartsForComplete(eight, 8 * MIN_NON_FINAL_PART_BYTES), "invalid");
});

test("元数据补丁按固定顺序拒绝，并规范化合法字段", () => {
  const illegal = normalizeMetadataPatch({ contentType: "image/png", description: "x" });
  assert.deepEqual(illegal, { ok: false, message: "请求不合法" });
  assert.deepEqual(normalizeMetadataPatch({ description: "  \u0001  " }), { ok: false, message: "描述不合法" });
  assert.deepEqual(normalizeMetadataPatch({ description: "  海边\n\t " }), { ok: true, patch: { description: "海边\n\t" } });
  assert.deepEqual(normalizeMetadataPatch({ description: "   " }), { ok: true, patch: { description: null } });
  assert.deepEqual(normalizeMetadataPatch({ description: "a".repeat(4001) }), { ok: false, message: "描述不合法" });
  assert.deepEqual(normalizeMetadataPatch({ tags: null }), { ok: false, message: "标签不合法" });
  assert.deepEqual(normalizeMetadataPatch({ tags: [" 海 ", "海", "山"] }), { ok: true, patch: { tags: ["海", "山"] } });
  assert.deepEqual(normalizeMetadataPatch({ tags: [] }), { ok: true, patch: { tags: [] } });
  assert.deepEqual(normalizeMetadataPatch({ tags: ["a\n"] }), { ok: false, message: "标签不合法" });
  assert.deepEqual(normalizeMetadataPatch({ takenAt: "2026-11-04" }), { ok: false, message: "拍摄时间不合法" });
  assert.deepEqual(normalizeMetadataPatch({ takenAt: null }).ok, true);
  const taken = normalizeMetadataPatch({ takenAt: "2026-11-04T02:31:00.000Z" });
  assert.equal(taken.ok, true);
  if (taken.ok) assert.equal(taken.patch.takenAt?.toISOString(), "2026-11-04T02:31:00.000Z");
  assert.deepEqual(normalizeMetadataPatch({ locationText: "  " }), { ok: true, patch: { locationText: null } });
  assert.deepEqual(normalizeMetadataPatch({ locationText: "x".repeat(501) }), { ok: false, message: "地点不合法" });
  assert.deepEqual(normalizeMetadataPatch({ latitude: 1 }), { ok: false, message: "经纬度须成对出现" });
  assert.deepEqual(normalizeMetadataPatch({ latitude: null, longitude: 1 }), { ok: false, message: "经纬度须成对出现" });
  assert.deepEqual(normalizeMetadataPatch({ latitude: null, longitude: null }), {
    ok: true,
    patch: { latitude: null, longitude: null },
  });
  assert.deepEqual(normalizeMetadataPatch({ latitude: 91, longitude: 0 }), { ok: false, message: "经纬度超出范围" });
  assert.deepEqual(normalizeMetadataPatch({ latitude: -90, longitude: 180 }), {
    ok: true,
    patch: { latitude: -90, longitude: 180 },
  });
  assert.deepEqual(normalizeMetadataPatch({}).ok && normalizeMetadataPatch({}).patch, { ok: true, patch: {} }.patch);
});

test("不可见照片与分页游标", () => {
  assert.equal(isVisiblePhoto(null, USER), false);
  assert.equal(isVisiblePhoto({ ownerId: PHOTO }, USER), false);
  assert.equal(isVisiblePhoto({ ownerId: USER }, USER), true);
  assert.equal(parsePhotoLimit(undefined), 50);
  assert.equal(parsePhotoLimit("1"), 1);
  assert.equal(parsePhotoLimit("100"), 100);
  assert.equal(parsePhotoLimit("01"), "invalid");
  assert.equal(parsePhotoLimit("0"), "invalid");
  assert.equal(parsePhotoLimit("101"), "invalid");
  const createdAt = new Date("2026-11-04T02:31:00.000Z");
  const encoded = encodePhotoCursor(createdAt, PHOTO);
  assert.equal(encoded.includes("="), false);
  assert.deepEqual(decodePhotoCursor(encoded), { createdAt, id: PHOTO });
  assert.equal(decodePhotoCursor(`${encoded}=`), null);
  assert.equal(decodePhotoCursor("not-base64url"), null);
});
