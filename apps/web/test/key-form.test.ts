import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateKeyName } from "../src/pages/key-form.ts";

test("validateKeyName trims and accepts length 1–64", () => {
  const result = validateKeyName("  my-key  ");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.name, "my-key");
  }
  assert.deepEqual(validateKeyName("a"), { ok: true, name: "a" });
  assert.deepEqual(validateKeyName("x".repeat(64)), { ok: true, name: "x".repeat(64) });
});

test("validateKeyName rejects empty, too long, and control characters", () => {
  assert.deepEqual(validateKeyName(""), { ok: false, message: "名称不合法" });
  assert.deepEqual(validateKeyName("   "), { ok: false, message: "名称不合法" });
  assert.deepEqual(validateKeyName("x".repeat(65)), { ok: false, message: "名称不合法" });
  assert.deepEqual(validateKeyName("a\u0000b"), { ok: false, message: "名称不合法" });
  assert.deepEqual(validateKeyName("a\u007fb"), { ok: false, message: "名称不合法" });
});

test("keys.tsx secret dialog and no persistence", async () => {
  const source = await readFile(new URL("../src/pages/keys.tsx", import.meta.url), "utf8");
  assert.match(source, /readOnly/);
  assert.match(source, /setSecret\(null\)/);
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /document\.title\s*=/);
});

test("account.tsx has link to /keys and logout", async () => {
  const source = await readFile(new URL("../src/pages/account.tsx", import.meta.url), "utf8");
  assert.match(source, /\/keys/);
  assert.match(source, /退出/);
});
