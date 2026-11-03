import assert from "node:assert/strict";
import test from "node:test";
import type { ApiKeyRecord } from "../src/domain/identity/model.js";
import type { ResolvePrincipalDeps } from "../src/adapters/identity/deps.js";
import { resolvePrincipal } from "../src/adapters/identity/resolve-principal.js";
import { createTokenHasher } from "../src/gateways/auth/token-hasher.js";
import { ManualClock } from "./manual-clock.js";

const PEPPER = "test-pepper-at-least-32-bytes-ok";
const clock = new ManualClock(new Date("2030-01-01T00:00:00.000Z"));
const hasher = createTokenHasher(PEPPER);

function deps(overrides: Partial<ResolvePrincipalDeps> = {}): ResolvePrincipalDeps {
  return {
    accessTokens: {
      async sign() {
        throw new Error("sign unused");
      },
      async verify() {
        return null;
      },
    },
    apiKeys: {
      async findActiveByPrefix() {
        return [];
      },
      async touchLastUsed() {
        throw new Error("touch unused");
      },
    },
    tokenHasher: hasher,
    clock,
    log: { warn() {} },
    ...overrides,
  };
}

test("两处点号的凭证只走 JWT，不查 Key", async () => {
  let lookups = 0;
  const principal = await resolvePrincipal(
    deps({
      accessTokens: {
        async sign() {
          throw new Error("sign unused");
        },
        async verify(jwt) {
          assert.equal(jwt, "aaa.bbb.ccc");
          return { userId: "user-1", credentialId: "cid-1", kind: "password_session" };
        },
      },
      apiKeys: {
        async findActiveByPrefix() {
          lookups += 1;
          throw new Error("JWT 分支禁止查库");
        },
        async touchLastUsed() {
          throw new Error("JWT 分支禁止写库");
        },
      },
    }),
    "Bearer aaa.bbb.ccc",
  );
  assert.equal(lookups, 0);
  assert.deepEqual(principal, {
    userId: "user-1",
    credentialKind: "password_session",
    credentialId: "cid-1",
  });
});

test("Refresh Token、空 Bearer 和错误方案都是未授权", async () => {
  const verify = async () => {
    throw new Error("oalr 不能当 Access JWT");
  };
  const local = deps({ accessTokens: { sign: async () => "unused", verify } });
  assert.equal(await resolvePrincipal(local, "Bearer oalr_abc"), null);
  assert.equal(await resolvePrincipal(local, "Bearer    "), null);
  assert.equal(await resolvePrincipal(local, undefined), null);
  assert.equal(await resolvePrincipal(local, "Basic abc"), null);
});

test("API Key 命中后更新 last_used_at，更新失败仍放行", async () => {
  const secret = "oalb_Ab12Cd34_abcdefghijABCDEFGHIJ0123456789abc";
  const record: ApiKeyRecord = {
    id: "key-1",
    userId: "user-1",
    name: "agent",
    keyPrefix: "oalb_Ab12Cd34",
    keyHash: hasher.hash(secret),
    revokedAt: null,
    lastUsedAt: null,
    createdAt: clock.now(),
  };
  let touched = 0;
  const principal = await resolvePrincipal(
    deps({
      apiKeys: {
        async findActiveByPrefix(prefix) {
          assert.equal(prefix, "oalb_Ab12Cd34");
          return [record];
        },
        async touchLastUsed(id) {
          touched += 1;
          assert.equal(id, "key-1");
        },
      },
    }),
    `bearer ${secret}`,
  );
  assert.equal(touched, 1);
  assert.equal(principal?.credentialKind, "api_key");
  assert.equal(principal?.credentialId, "key-1");

  let warned = false;
  const still = await resolvePrincipal(
    deps({
      apiKeys: {
        async findActiveByPrefix() {
          return [record];
        },
        async touchLastUsed() {
          throw new Error("db down");
        },
      },
      log: {
        warn(event, fields) {
          warned = true;
          assert.equal(event, "api_key_last_used_failed");
          assert.equal(fields.keyId, "key-1");
          assert.equal(fields.userId, "user-1");
          assert.equal("secret" in fields, false);
        },
      },
    }),
    `Bearer ${secret}`,
  );
  assert.equal(warned, true);
  assert.equal(still?.userId, "user-1");
});
