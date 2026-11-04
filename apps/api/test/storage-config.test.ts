import assert from "node:assert/strict";
import test from "node:test";
import { loadStorageConfig } from "../src/gateways/storage/config.js";

const base = {
  S3_ENDPOINT: "https://cos.ap-singapore.myqcloud.com",
  S3_REGION: "ap-singapore",
  S3_BUCKET: "album",
  S3_ACCESS_KEY_ID: "AKID",
  S3_SECRET_ACCESS_KEY: "SECRET",
};

test("空白 TTL 与 15m 都是 900 秒，超过 7 天拒绝", () => {
  assert.equal(loadStorageConfig(base).signedUrlTtlSeconds, 900);
  assert.equal(loadStorageConfig({ ...base, S3_SIGNED_URL_TTL: "   " }).signedUrlTtlSeconds, 900);
  assert.equal(loadStorageConfig({ ...base, S3_SIGNED_URL_TTL: "15m" }).signedUrlTtlSeconds, 900);
  assert.equal(loadStorageConfig({ ...base, S3_SIGNED_URL_TTL: "7d" }).signedUrlTtlSeconds, 604_800);
  assert.throws(() => loadStorageConfig({ ...base, S3_SIGNED_URL_TTL: "604801s" }), /S3_SIGNED_URL_TTL 超过 7 天/);
  assert.throws(() => loadStorageConfig({ ...base, S3_SIGNED_URL_TTL: "8d" }), /S3_SIGNED_URL_TTL 超过 7 天/);
  assert.throws(() => loadStorageConfig({ ...base, S3_SIGNED_URL_TTL: "soon" }), /S3_SIGNED_URL_TTL 无效/);
});

test("缺密钥、非法 endpoint 与 path style 只点名变量", () => {
  assert.throws(() => loadStorageConfig({ ...base, S3_SECRET_ACCESS_KEY: " " }), /S3_SECRET_ACCESS_KEY 缺失/);
  assert.throws(() => loadStorageConfig({ ...base, S3_ENDPOINT: "https://key:secret@example.com" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "S3_ENDPOINT 无效");
    assert.equal(error.message.includes("secret"), false);
    assert.equal(error.message.includes("key"), false);
    return true;
  });
  assert.throws(() => loadStorageConfig({ ...base, S3_FORCE_PATH_STYLE: "TRUE" }), /S3_FORCE_PATH_STYLE 无效/);
  assert.equal(loadStorageConfig({ ...base, S3_FORCE_PATH_STYLE: "true" }).forcePathStyle, true);
  assert.equal(loadStorageConfig(base).forcePathStyle, false);
  const loaded = loadStorageConfig(base);
  assert.equal(Object.hasOwn(loaded, "publicBaseUrl"), false);
});
