import pg from "pg";
import type { LockedRefreshToken, RefreshTokenRecord } from "../domain/identity/model.js";
import type { RefreshTokenRepository, RefreshTokenTx } from "../domain/identity/ports.js";

const INSERT_SQL = `INSERT INTO refresh_tokens
  (id, user_id, token_hash, family_id, expires_at, revoked_at, replaced_by, created_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

export function createRefreshTokenRepository(pool: pg.Pool): RefreshTokenRepository {
  return {
    async insert(record) {
      await pool.query(INSERT_SQL, insertParams(record));
    },
    async transactByHash(tokenHash, mutate) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query(
          `SELECT rt.id, rt.user_id, u.email AS user_email, rt.family_id, rt.expires_at, rt.revoked_at
           FROM refresh_tokens rt
           JOIN users u ON u.id = rt.user_id
           WHERE rt.token_hash = $1
           FOR UPDATE OF rt`,
          [tokenHash],
        );
        const row = found.rows[0] ? mapLocked(found.rows[0]) : null;
        const tx: RefreshTokenTx = {
          async insert(record) {
            await client.query(INSERT_SQL, insertParams(record));
          },
          async revokeFamily(familyId, revokedAt) {
            await client.query(
              `UPDATE refresh_tokens SET revoked_at = $2
               WHERE family_id = $1 AND revoked_at IS NULL`,
              [familyId, revokedAt],
            );
          },
          async markReplaced(id, replacedBy, revokedAt) {
            await client.query(
              `UPDATE refresh_tokens SET revoked_at = $3, replaced_by = $2 WHERE id = $1`,
              [id, replacedBy, revokedAt],
            );
          },
        };
        await mutate(row, tx);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async revokeByHash(tokenHash, revokedAt) {
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = $2
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash, revokedAt],
      );
    },
  };
}

function insertParams(record: RefreshTokenRecord): unknown[] {
  return [
    record.id,
    record.userId,
    record.tokenHash,
    record.familyId,
    record.expiresAt,
    record.revokedAt,
    record.replacedBy,
    record.createdAt,
  ];
}

function mapLocked(row: {
  id: string;
  user_id: string;
  user_email: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}): LockedRefreshToken {
  return {
    id: row.id,
    userId: row.user_id,
    userEmail: row.user_email,
    familyId: row.family_id,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}
