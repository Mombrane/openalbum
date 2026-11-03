import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import type { RefreshTokenRecord, User } from "../src/domain/identity/model.js";
import { createApiKeyRepository } from "../src/dao/api-key-repository.js";
import { createRefreshTokenRepository } from "../src/dao/refresh-token-repository.js";
import { createUserRepository } from "../src/dao/user-repository.js";
import { applySchema, requireDatabaseUrl, truncateIdentity } from "./apply-schema.js";

const databaseUrl = requireDatabaseUrl();
const now = new Date("2030-01-01T00:00:00.000Z");

test("用户唯一约束、API Key 吊销与 Refresh Token 轮换事务", async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await applySchema(pool);
    await truncateIdentity(pool);
    const users = createUserRepository(pool);
    const apiKeys = createApiKeyRepository(pool);
    const refreshTokens = createRefreshTokenRepository(pool);
    const user: User = {
      id: "00000000-0000-4000-8000-000000000001",
      email: "user@example.com",
      passwordHash: "$argon2id$dummy",
      createdAt: now,
    };
    assert.equal(await users.insert(user), "ok");
    assert.equal(await users.insert({ ...user, id: "00000000-0000-4000-8000-000000000002" }), "email_taken");

    await apiKeys.insert({
      id: "00000000-0000-4000-8000-000000000011",
      userId: user.id,
      name: "agent",
      keyPrefix: "oalb_Ab12Cd34",
      keyHash: "ab".repeat(32),
      revokedAt: null,
      lastUsedAt: null,
      createdAt: now,
    });
    assert.equal((await apiKeys.findActiveByPrefix("oalb_Ab12Cd34")).length, 1);
    assert.equal(await apiKeys.revoke("00000000-0000-4000-8000-000000000011", user.id, now), "revoked");
    assert.equal(await apiKeys.revoke("00000000-0000-4000-8000-000000000011", user.id, now), "already");
    assert.equal(await apiKeys.revoke("00000000-0000-4000-8000-000000000099", user.id, now), "missing");
    assert.equal((await apiKeys.findActiveByPrefix("oalb_Ab12Cd34")).length, 0);

    const current: RefreshTokenRecord = {
      id: "00000000-0000-4000-8000-000000000021",
      userId: user.id,
      tokenHash: "11".repeat(32),
      familyId: "00000000-0000-4000-8000-000000000031",
      expiresAt: new Date("2030-02-01T00:00:00.000Z"),
      revokedAt: null,
      replacedBy: null,
      createdAt: now,
    };
    await refreshTokens.insert(current);
    const replacementId = "00000000-0000-4000-8000-000000000022";
    await refreshTokens.transactByHash(current.tokenHash, async (row, tx) => {
      assert.equal(row?.userEmail, "user@example.com");
      assert.equal(row?.revokedAt, null);
      await tx.insert({ ...current, id: replacementId, tokenHash: "22".repeat(32) });
      await tx.markReplaced(current.id, replacementId, now);
    });
    await refreshTokens.transactByHash(current.tokenHash, async (row, tx) => {
      assert.notEqual(row?.revokedAt, null);
      await tx.revokeFamily(current.familyId, now);
    });
    const left = await pool.query(
      "select count(*)::int as n from refresh_tokens where family_id = $1 and revoked_at is null",
      [current.familyId],
    );
    assert.equal(left.rows[0].n, 0);
  } finally {
    await pool.end();
  }
});
