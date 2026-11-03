import pg from "pg";
import type { ApiKeyRecord } from "../domain/identity/model.js";
import type { ApiKeyRepository } from "../domain/identity/ports.js";

type ApiKeyRow = {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
};

export function createApiKeyRepository(pool: pg.Pool): ApiKeyRepository {
  return {
    async insert(record) {
      await pool.query(
        `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, revoked_at, last_used_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [record.id, record.userId, record.name, record.keyPrefix, record.keyHash, record.revokedAt, record.lastUsedAt, record.createdAt],
      );
    },
    async listByUser(userId) {
      const result = await pool.query<ApiKeyRow>(
        `SELECT id, user_id, name, key_prefix, key_hash, revoked_at, last_used_at, created_at
         FROM api_keys WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
        [userId],
      );
      return result.rows.map(mapApiKey);
    },
    async findActiveByPrefix(prefix) {
      const result = await pool.query<ApiKeyRow>(
        `SELECT id, user_id, name, key_prefix, key_hash, revoked_at, last_used_at, created_at
         FROM api_keys WHERE key_prefix = $1 AND revoked_at IS NULL`,
        [prefix],
      );
      return result.rows.map(mapApiKey);
    },
    async revoke(id, userId, revokedAt) {
      const updated = await pool.query(
        `UPDATE api_keys SET revoked_at = $3
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [id, userId, revokedAt],
      );
      if ((updated.rowCount ?? 0) > 0) return "revoked";
      const existing = await pool.query("SELECT id FROM api_keys WHERE id = $1 AND user_id = $2", [id, userId]);
      return (existing.rowCount ?? 0) > 0 ? "already" : "missing";
    },
    async touchLastUsed(id, usedAt) {
      await pool.query("UPDATE api_keys SET last_used_at = $2 WHERE id = $1", [id, usedAt]);
    },
  };
}

function mapApiKey(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}
