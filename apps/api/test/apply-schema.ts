import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL 缺失：身份测试必须连接 PostgreSQL，禁止跳过");
  }
  return databaseUrl;
}

export async function applySchema(pool: pg.Pool): Promise<void> {
  const schemaPath = path.resolve(fileURLToPath(new URL("../../../deploy/db/schema.sql", import.meta.url)));
  const sql = await readFile(schemaPath, "utf8");
  await pool.query(sql);
}

export async function truncateIdentity(pool: pg.Pool): Promise<void> {
  await pool.query("TRUNCATE TABLE users CASCADE");
}
