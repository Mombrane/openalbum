import pg from "pg";
import type { User } from "../domain/identity/model.js";
import type { UserRepository } from "../domain/identity/ports.js";

export function createUserRepository(pool: pg.Pool): UserRepository {
  return {
    async insert(user) {
      try {
        await pool.query(
          `INSERT INTO users (id, email, password_hash, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)`,
          [user.id, user.email, user.passwordHash, user.createdAt],
        );
        return "ok";
      } catch (error) {
        if (isUniqueViolation(error)) return "email_taken";
        throw error;
      }
    },
    async findByEmail(email) {
      const result = await pool.query(
        "SELECT id, email, password_hash, created_at FROM users WHERE email = $1",
        [email],
      );
      return mapUser(result.rows[0]);
    },
    async findById(id) {
      const result = await pool.query(
        "SELECT id, email, password_hash, created_at FROM users WHERE id = $1",
        [id],
      );
      return mapUser(result.rows[0]);
    },
  };
}

function mapUser(row: { id: string; email: string; password_hash: string; created_at: Date } | undefined): User | null {
  if (!row) return null;
  return { id: row.id, email: row.email, passwordHash: row.password_hash, createdAt: row.created_at };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
