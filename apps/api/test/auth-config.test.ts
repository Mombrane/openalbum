import assert from "node:assert/strict";
import test from "node:test";
import { loadAuthConfig, parseDurationSeconds } from "../src/gateways/auth/config.js";

const secret = "j".repeat(32);
const pepper = "p".repeat(32);
const databaseUrl = "postgres://photo:secret@127.0.0.1:5432/photo_album";

test("parseDurationSeconds 解析 s/m/d", () => {
  assert.equal(parseDurationSeconds("15m"), 900);
  assert.equal(parseDurationSeconds("2s"), 2);
  assert.equal(parseDurationSeconds("30d"), 2_592_000);
});

test("parseDurationSeconds 拒绝没有单位或不是正整数的值", () => {
  for (const value of ["15", "0s", "01s", "-1s", "1h", "15M", "1.5m"]) {
    assert.throws(() => parseDurationSeconds(value), /时长无效/);
  }
});

test("loadAuthConfig 使用 15m 与 30d 作为默认值", () => {
  const config = loadAuthConfig({ JWT_SECRET: secret, API_KEY_PEPPER: pepper, DATABASE_URL: databaseUrl });
  assert.equal(config.accessTtlSeconds, 900);
  assert.equal(config.refreshTtlSeconds, 2_592_000);
  assert.equal(config.jwtSecret, secret);
  assert.equal(config.pepper, pepper);
  assert.equal(config.databaseUrl, databaseUrl);
});

test("loadAuthConfig 拒绝短密钥、短 pepper 和缺失的数据库 URL", () => {
  assert.throws(() => loadAuthConfig({ JWT_SECRET: "short", API_KEY_PEPPER: pepper, DATABASE_URL: databaseUrl }), /JWT_SECRET/);
  assert.throws(() => loadAuthConfig({ JWT_SECRET: secret, API_KEY_PEPPER: "short", DATABASE_URL: databaseUrl }), /API_KEY_PEPPER/);
  assert.throws(() => loadAuthConfig({ JWT_SECRET: secret, API_KEY_PEPPER: pepper }), /DATABASE_URL/);
});
