import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { SignJWT, decodeJwt } from "jose";
import { createAccessTokenIssuer } from "../src/gateways/auth/access-token-issuer.js";
import { createPasswordHasher } from "../src/gateways/auth/password-hasher.js";
import { createSecretGenerator } from "../src/gateways/auth/secret-generator.js";
import { createTokenHasher } from "../src/gateways/auth/token-hasher.js";
import { ManualClock } from "./manual-clock.js";

const SECRET = "test-jwt-secret-at-least-32-bytes";
const PEPPER = "test-pepper-at-least-32-bytes-ok";
const START = new Date("2030-01-01T00:00:00.000Z");

test("argon2id 可校验，哑哈希不能通过任意口令", async () => {
  const hasher = await createPasswordHasher();
  const encoded = await hasher.hash("correct-horse");
  assert.equal(encoded.startsWith("$argon2id$"), true);
  assert.equal(encoded.includes("correct-horse"), false);
  assert.equal(await hasher.verify("correct-horse", encoded), true);
  assert.equal(await hasher.verify("wrong-password", encoded), false);
  assert.equal(await hasher.verify("wrong-password", hasher.dummyHash()), false);
  assert.equal(hasher.dummyHash().startsWith("$argon2id$"), true);
});

test("TokenHasher 用 API_KEY_PEPPER 做 HMAC，并恒定时间比较", () => {
  const hasher = createTokenHasher(PEPPER);
  const expected = createHmac("sha256", PEPPER).update("oalr_abc").digest("hex");
  assert.equal(hasher.hash("oalr_abc"), expected);
  assert.equal(hasher.equal(expected, expected), true);
  assert.equal(hasher.equal(expected, hasher.hash("oalr_other")), false);
  assert.equal(hasher.equal("aa", expected), false);
});

test("随机明文符合前缀、长度和无填充", () => {
  const secrets = createSecretGenerator();
  const refresh = secrets.refreshToken();
  assert.match(refresh, /^oalr_[A-Za-z0-9_-]{43}$/);
  assert.equal(refresh.includes("="), false);
  const apiKey = secrets.apiKey();
  assert.match(apiKey.prefix, /^oalb_[A-Za-z0-9]{8}$/);
  assert.equal(apiKey.secret.startsWith(`${apiKey.prefix}_`), true);
  assert.match(apiKey.secret, /^oalb_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
});

test("Access JWT 走注入时钟，cid 只存在令牌里", async () => {
  const clock = new ManualClock(START);
  const issuer = createAccessTokenIssuer({ secret: SECRET, ttlSeconds: 120, clock });
  const token = await issuer.sign({ userId: "user-1", credentialId: "refresh-1" });
  const verified = await issuer.verify(token);
  assert.deepEqual(verified, { userId: "user-1", credentialId: "refresh-1", kind: "password_session" });
  const decoded = decodeJwt(token);
  assert.equal(decoded.iss, "openalbum");
  assert.equal(decoded.aud, "openalbum-api");

  clock.advance(124_000);
  assert.deepEqual(await issuer.verify(token), verified);

  clock.advance(1_000);
  assert.equal(await issuer.verify(token), null);

  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  clock.set(START);
  assert.equal(await issuer.verify(tampered), null);
});

test("kind、iss、aud 不对或 alg=none 时拒绝", async () => {
  const clock = new ManualClock(START);
  const issuer = createAccessTokenIssuer({ secret: SECRET, ttlSeconds: 120, clock });
  const issuedAt = Math.floor(START.getTime() / 1000);
  async function signed(overrides: { iss?: string; aud?: string; kind?: string }) {
    return new SignJWT({ kind: overrides.kind ?? "password_session", cid: "cid-1" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(overrides.iss ?? "openalbum")
      .setAudience(overrides.aud ?? "openalbum-api")
      .setSubject("user-1")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 120)
      .sign(new TextEncoder().encode(SECRET));
  }
  assert.equal(await issuer.verify(await signed({ kind: "api_key" })), null);
  assert.equal(await issuer.verify(await signed({ iss: "other" })), null);
  assert.equal(await issuer.verify(await signed({ aud: "other" })), null);

  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "openalbum",
      aud: "openalbum-api",
      sub: "user-1",
      kind: "password_session",
      cid: "cid-1",
      iat: issuedAt,
      exp: issuedAt + 120,
    }),
  ).toString("base64url");
  assert.equal(await issuer.verify(`${header}.${payload}.`), null);
});
