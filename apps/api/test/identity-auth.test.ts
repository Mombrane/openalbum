import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import test from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { applySchema, requireDatabaseUrl, truncateIdentity } from "./apply-schema.js";
import { ManualClock } from "./manual-clock.js";

const databaseUrl = requireDatabaseUrl();
const START = new Date("2030-01-01T00:00:00.000Z");
const PEPPER = "test-pepper-at-least-32-bytes-ok";
const JWT_SECRET = "test-jwt-secret-at-least-32-bytes";
const testConfig = {
  jwtSecret: JWT_SECRET,
  pepper: PEPPER,
  accessTtlSeconds: 120,
  refreshTtlSeconds: 30 * 24 * 60 * 60,
  databaseUrl,
};
const clock = new ManualClock(START);
const pool = new pg.Pool({ connectionString: databaseUrl });
let app: Awaited<ReturnType<typeof buildApp>>;

let tail: Promise<unknown> = Promise.resolve();
function serial(name: string, fn: () => Promise<void>): void {
  test(name, () => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  });
}

function tokenHash(raw: string): string {
  return createHmac("sha256", PEPPER).update(raw).digest("hex");
}

async function familyOf(refreshToken: string): Promise<string> {
  const result = await pool.query("select family_id from refresh_tokens where token_hash = $1", [tokenHash(refreshToken)]);
  assert.equal(result.rowCount, 1);
  return String(result.rows[0].family_id);
}

async function reset(): Promise<void> {
  clock.set(START);
  await truncateIdentity(pool);
}

function registerUserHttp(email: string, password: string) {
  return app.inject({ method: "POST", url: "/auth/register", payload: { email, password } });
}

function loginUserHttp(email: string, password: string) {
  return app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
}

test.before(async () => {
  await applySchema(pool);
  app = await buildApp({ logger: false, config: testConfig, clock, pool });
});

test.after(async () => {
  await app.close();
  await pool.end();
});

serial("注册返回 201，口令以 argon2id 保存，并发冲突是 409", async () => {
  await reset();
  const created = await registerUserHttp("  User@Example.COM ", "correct-horse");
  assert.equal(created.statusCode, 201);
  const body = created.json();
  assert.equal(body.tokenType, "Bearer");
  assert.equal(typeof body.accessToken, "string");
  assert.equal(body.accessTokenExpiresIn, 120);
  assert.match(body.refreshToken, /^oalr_/);
  assert.equal(body.user.email, "user@example.com");
  assert.equal(JSON.stringify(body).includes("password_hash"), false);
  const stored = await pool.query("select password_hash from users where email = $1", ["user@example.com"]);
  assert.equal(String(stored.rows[0].password_hash).startsWith("$argon2id$"), true);
  assert.equal(String(stored.rows[0].password_hash).includes("correct-horse"), false);
  const tokenRows = await pool.query("select * from refresh_tokens");
  assert.equal(JSON.stringify(tokenRows.rows).includes(String(body.refreshToken)), false);

  const again = await registerUserHttp("user@example.com", "correct-horse");
  assert.equal(again.statusCode, 409);
  assert.deepEqual(again.json(), { error: { code: "email_taken", message: "该邮箱已注册" } });
  const spaced = await registerUserHttp(" USER@example.com ", "another-password");
  assert.equal(spaced.statusCode, 409);

  const [left, right] = await Promise.all([
    registerUserHttp("race@example.com", "12345678"),
    registerUserHttp("race@example.com", "12345678"),
  ]);
  assert.deepEqual([left.statusCode, right.statusCode].sort((a, b) => a - b), [201, 409]);
  const conflict = left.statusCode === 409 ? left : right;
  assert.equal(conflict.json().error.code, "email_taken");
});

serial("登录成功新建 family，失败响应不区分未知邮箱", async () => {
  await reset();
  const registered = await registerUserHttp("user@example.com", "correct-horse");
  const logged = await loginUserHttp(" User@Example.com ", "correct-horse");
  assert.equal(logged.statusCode, 200);
  assert.equal(Object.hasOwn(logged.json(), "family_id"), false);
  assert.equal(logged.json().user.email, "user@example.com");
  assert.notEqual(await familyOf(registered.json().refreshToken), await familyOf(logged.json().refreshToken));

  const wrong = await loginUserHttp("user@example.com", "wrong-password-1");
  const missing = await loginUserHttp("missing@example.com", "wrong-password-1");
  assert.deepEqual(wrong.json(), missing.json());
  assert.deepEqual(wrong.json(), { error: { code: "invalid_credentials", message: "邮箱或密码错误" } });
  assert.equal(JSON.stringify(wrong.json()).includes("password_hash"), false);
});

serial("非法邮箱和短密码返回固定句，邮箱问题优先", async () => {
  await reset();
  const email = await registerUserHttp("not-an-email", "short");
  assert.deepEqual(email.json(), { error: { code: "validation_error", message: "邮箱格式不正确" } });
  assert.equal(email.statusCode, 400);
  const password = await registerUserHttp("ok@example.com", "1234567");
  assert.deepEqual(password.json(), { error: { code: "validation_error", message: "密码长度须为 8 到 128" } });
  const extra = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "ok@example.com", password: "12345678", extra: true },
  });
  assert.deepEqual(extra.json(), { error: { code: "validation_error", message: "请求不合法" } });
});

serial("默认日志路径不含注册、登录、登出的秘密", async () => {
  await reset();
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const local = await buildApp({ logger: { level: "info", stream }, config: testConfig, clock, pool });
  const password = "pw-SENTINEL-7c1e";
  const registered = await local.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "log@example.com", password },
  });
  assert.equal(registered.statusCode, 201);
  const refreshToken = String(registered.json().refreshToken);
  const accessToken = String(registered.json().accessToken);
  await local.inject({ method: "POST", url: "/auth/login", payload: { email: "log@example.com", password } });
  await local.inject({ method: "POST", url: "/auth/logout", payload: { refreshToken } });
  const logs = lines.join("\n");
  assert.equal(logs.includes(password), false);
  assert.equal(logs.includes(refreshToken), false);
  assert.equal(logs.includes(accessToken), false);
  const routeSource = await readFile(new URL("../src/interfaces/http/register-auth.ts", import.meta.url), "utf8");
  const errorSource = await readFile(new URL("../src/interfaces/http/error-handler.ts", import.meta.url), "utf8");
  const loggerSource = await readFile(new URL("../src/interfaces/http/auth-logger.ts", import.meta.url), "utf8");
  assert.equal(/\brequest\.log\s*[.(]/.test(routeSource), false);
  assert.equal(/\breply\.log\s*[.(]/.test(routeSource), false);
  assert.equal(errorSource.includes("request.body"), false);
  for (const path of ["req.body", "body", "req.headers.authorization", "password", "refreshToken", "secret", "accessToken"]) {
    assert.equal(loggerSource.includes(`"${path}"`), true, path);
  }
  await local.close();
});

serial("即使有人记录 body，redact 仍去掉明文", async () => {
  await reset();
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const local = await buildApp({ logger: { level: "info", stream }, config: testConfig, clock, pool });
  local.addHook("preHandler", async (request) => {
    request.log.info({ body: request.body }, "debug-body");
  });
  const password = "pw-SENTINEL-body-9aa1";
  const registered = await local.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "redact@example.com", password },
  });
  assert.equal(registered.statusCode, 201);
  const refreshToken = String(registered.json().refreshToken);
  await local.inject({ method: "POST", url: "/auth/logout", payload: { refreshToken } });
  const logs = lines.join("\n");
  assert.equal(logs.includes(password), false);
  assert.equal(logs.includes(refreshToken), false);
  assert.equal(logs.includes("[Redacted]"), true);
  await local.close();
});
