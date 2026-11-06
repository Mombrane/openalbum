import assert from "node:assert/strict";
import test from "node:test";
import { ThumbnailEncodeError } from "../src/domain/library/pipeline.js";
import { createExifrReader } from "../src/gateways/exif/exifr-reader.js";
import { createFakeExifReader } from "../src/gateways/exif/fake-exif-reader.js";
import { parseExifTimestamp, parseGpsPair } from "../src/gateways/exif/parse.js";
import { createFakeThumbnailEncoder } from "../src/gateways/thumbnail/fake-encoder.js";
import { createSharpThumbnailEncoder } from "../src/gateways/thumbnail/sharp-encoder.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("无偏移的 EXIF 时间按 UTC，坏年份与坏坐标变成空", () => {
  assert.equal(parseExifTimestamp("2020:01:02 03:04:05", undefined)?.toISOString(), "2020-01-02T03:04:05.000Z");
  assert.equal(parseExifTimestamp("2020:01:02 03:04:05", "+08:00")?.toISOString(), "2020-01-01T19:04:05.000Z");
  assert.equal(parseExifTimestamp("1960:01:02 03:04:05", undefined), null);
  assert.equal(parseExifTimestamp("not-a-date", undefined), null);
  assert.deepEqual(parseGpsPair(1.25, -2.5), { latitude: 1.25, longitude: -2.5 });
  assert.deepEqual(parseGpsPair(91, 0), { latitude: null, longitude: null });
  assert.deepEqual(parseGpsPair(1, null), { latitude: null, longitude: null });
});

test("假 EXIF 返回注入值，坏字节的生产读数是三个空", async () => {
  const takenAt = new Date("2021-05-06T07:08:09.000Z");
  const fake = createFakeExifReader({ takenAt, latitude: 3, longitude: 4 });
  assert.deepEqual(await fake.read(Buffer.from("x")), { takenAt, latitude: 3, longitude: 4 });
  assert.equal(fake.calls, 1);
  const real = await createExifrReader().read(Buffer.from("not-an-image"));
  assert.deepEqual(real, { takenAt: null, latitude: null, longitude: null });
});

test("生产编码器输出 JPEG，假编码器可以抛出 ThumbnailEncodeError", async () => {
  const encoded = await createSharpThumbnailEncoder().encode(PNG);
  assert.equal(encoded.contentType, "image/jpeg");
  assert.ok(encoded.bytes.length > 1);
  assert.equal(encoded.bytes[0], 0xff);
  assert.equal(encoded.bytes[1], 0xd8);
  const fake = createFakeThumbnailEncoder();
  const thumb = await fake.encode(Buffer.from("x"));
  assert.equal(thumb.contentType, "image/jpeg");
  assert.ok(thumb.bytes.length > 0);
  assert.equal(fake.calls, 1);
  const failing = createFakeThumbnailEncoder({ fail: true });
  await assert.rejects(() => failing.encode(Buffer.from("x")), (error: unknown) => error instanceof ThumbnailEncodeError);
  await assert.rejects(() => createSharpThumbnailEncoder().encode(Buffer.from("nope")), (error: unknown) => error instanceof ThumbnailEncodeError);
});
