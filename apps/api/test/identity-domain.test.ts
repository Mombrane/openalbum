import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApiKeyName } from "../src/domain/identity/api-key-name.js";
import { normalizeEmail } from "../src/domain/identity/email.js";
import { validatePassword } from "../src/domain/identity/password.js";
import { decideRefresh } from "../src/domain/identity/refresh-policy.js";

const now = new Date("2030-01-01T00:00:00.000Z");

test("normalizeEmail 去掉空白并转成小写", () => {
  assert.equal(normalizeEmail("  User@Example.COM "), "user@example.com");
  assert.equal(normalizeEmail("a@b.c"), "a@b.c");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail("a@b"), null);
  assert.equal(normalizeEmail("a b@c.d"), null);
  assert.equal(normalizeEmail(`${"a".repeat(320)}@b.c`), null);
});

test("validatePassword 只看 JavaScript 长度并且不 trim", () => {
  assert.equal(validatePassword("1234567"), false);
  assert.equal(validatePassword("12345678"), true);
  assert.equal(validatePassword("a".repeat(128)), true);
  assert.equal(validatePassword("a".repeat(129)), false);
  assert.equal(validatePassword(" 1234567"), true);
});

test("normalizeApiKeyName 拒绝空名、超长名和控制字符", () => {
  assert.equal(normalizeApiKeyName("  我的 Agent  "), "我的 Agent");
  assert.equal(normalizeApiKeyName("a".repeat(64)), "a".repeat(64));
  assert.equal(normalizeApiKeyName("   "), null);
  assert.equal(normalizeApiKeyName("a".repeat(65)), null);
  assert.equal(normalizeApiKeyName("a\nb"), null);
  assert.equal(normalizeApiKeyName("a\u007Fb"), null);
});

test("decideRefresh 覆盖四态，已撤销优先于过期", () => {
  assert.deepEqual(decideRefresh(null, now), { kind: "missing" });
  assert.deepEqual(
    decideRefresh({ revokedAt: null, expiresAt: new Date("2029-01-01T00:00:00.000Z") }, now),
    { kind: "expired" },
  );
  assert.deepEqual(
    decideRefresh({ revokedAt: null, expiresAt: now }, now),
    { kind: "expired" },
  );
  assert.deepEqual(
    decideRefresh({ revokedAt: now, expiresAt: new Date("2031-01-01T00:00:00.000Z") }, now),
    { kind: "replay" },
  );
  assert.deepEqual(
    decideRefresh({ revokedAt: now, expiresAt: new Date("2029-01-01T00:00:00.000Z") }, now),
    { kind: "replay" },
  );
  assert.deepEqual(
    decideRefresh({ revokedAt: null, expiresAt: new Date("2031-01-01T00:00:00.000Z") }, now),
    { kind: "rotate" },
  );
});
