import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateEmail, validatePassword } from "../src/pages/auth-form.ts";

test('validateEmail trims whitespace and preserves case', () => {
  const result = validateEmail("  A@Example.com  ");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.email, "A@Example.com");
  }
});

test("validateEmail rejects invalid formats", () => {
  assert.deepEqual(validateEmail("a@b"), { ok: false, message: "邮箱格式不正确" });
  assert.deepEqual(validateEmail(""), { ok: false, message: "邮箱格式不正确" });
  const longLocal = "x".repeat(321);
  assert.deepEqual(validateEmail(`${longLocal}@x.com`), { ok: false, message: "邮箱格式不正确" });
});

test("validatePassword enforces length without trimming", () => {
  assert.deepEqual(validatePassword("1234567"), {
    ok: false,
    message: "密码长度须为 8 到 128",
  });
  assert.deepEqual(validatePassword("x".repeat(129)), {
    ok: false,
    message: "密码长度须为 8 到 128",
  });
  assert.deepEqual(validatePassword("12345678"), { ok: true });
  assert.deepEqual(validatePassword("  12345678  "), { ok: true });
});

test("login page autoComplete and password input types", async () => {
  const source = await readFile(new URL("../src/pages/login.tsx", import.meta.url), "utf8");
  assert.match(source, /autoComplete="username"/);
  assert.match(source, /autoComplete="current-password"/);
  assert.match(source, /type="password"/);
});

test("register page autoComplete and password input types", async () => {
  const source = await readFile(new URL("../src/pages/register.tsx", import.meta.url), "utf8");
  assert.match(source, /autoComplete="email"/);
  assert.match(source, /autoComplete="new-password"/);
  assert.match(source, /type="password"/);
});
