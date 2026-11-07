import assert from "node:assert/strict";
import pg from "pg";
import type { buildApp } from "../src/app.js";
import { formatVectorLiteral } from "../src/dao/vector-literal.js";

type App = Awaited<ReturnType<typeof buildApp>>;

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export async function registerUser(app: App, email: string): Promise<{ accessToken: string; userId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "correct-horse" },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  return { accessToken: String(body.accessToken), userId: String(body.user.id) };
}

export async function createApiKey(app: App, accessToken: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api-keys",
    headers: bearer(accessToken),
    payload: { name: "agent" },
  });
  assert.equal(response.statusCode, 201);
  return String(response.json().secret);
}

export async function insertSearchPhoto(
  pool: pg.Pool,
  input: {
    id: string;
    ownerId: string;
    description: string | null;
    tags?: string[];
    status?: "processing" | "ready" | "failed";
    takenAt?: Date | null;
    locationText?: string | null;
    createdAt: Date;
    thumbKey?: string | null;
    embedding?: number[] | null;
    model?: string;
  },
): Promise<void> {
  const thumbKey = input.thumbKey === undefined ? `owners/${input.ownerId}/photos/${input.id}/thumb` : input.thumbKey;
  await pool.query(
    `INSERT INTO photos (
       id, owner_id, object_key, thumb_key, content_type, byte_size,
       taken_at, location_text, description, tags, status, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'image/jpeg', 12345,
       $5, $6, $7, $8, $9, $10, $10
     )`,
    [
      input.id,
      input.ownerId,
      `owners/${input.ownerId}/photos/${input.id}/original`,
      thumbKey,
      input.takenAt === undefined ? input.createdAt : input.takenAt,
      input.locationText ?? null,
      input.description,
      input.tags ?? [],
      input.status ?? "ready",
      input.createdAt,
    ],
  );
  if (input.embedding) {
    await pool.query(`INSERT INTO photo_embeddings (photo_id, embedding, model) VALUES ($1, $2::vector, $3)`, [
      input.id,
      formatVectorLiteral(input.embedding, 1536),
      input.model ?? "test-model",
    ]);
  }
}
