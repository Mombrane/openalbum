import pg from "pg";
import type { SearchHit, SearchPhoto, SearchPort } from "../domain/search/ports.js";
import { mapPhotoRow, PHOTO_COLUMNS } from "./photo-repository.js";
import { formatVectorLiteral } from "./vector-literal.js";

// Postgres ILIKE: ESCAPE '\'
const KEYWORD_SQL = `SELECT ${PHOTO_COLUMNS}
FROM photos p
WHERE p.owner_id = $1
  AND p.status = 'ready'
  AND ($2::timestamptz IS NULL OR p.taken_at >= $2)
  AND ($3::timestamptz IS NULL OR p.taken_at <= $3)
  AND ($4::text[] IS NULL OR p.tags @> $4::text[])
  AND (
    p.description ILIKE $5 ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM unnest(p.tags) AS tag
      WHERE tag ILIKE $5 ESCAPE '\\'
    )
  )
  AND (
    $6::timestamptz IS NULL
    OR (p.created_at, p.id) < ($6::timestamptz, $7::uuid)
  )
ORDER BY p.created_at DESC, p.id DESC
LIMIT $8`;

const SCORE_EXPR = `round((1 - (e.embedding <=> $2::vector))::numeric, 6)`;

const SEMANTIC_PHOTO_COLUMNS = PHOTO_COLUMNS.replace(/\b([a-z_]+)\b/g, "p.$1");

const SEMANTIC_SQL = `SELECT ${SEMANTIC_PHOTO_COLUMNS},
       ${SCORE_EXPR}::text AS score_text
FROM photos p
INNER JOIN photo_embeddings e ON e.photo_id = p.id
WHERE p.owner_id = $1
  AND p.status = 'ready'
  AND ($3::timestamptz IS NULL OR p.taken_at >= $3)
  AND ($4::timestamptz IS NULL OR p.taken_at <= $4)
  AND ($5::text[] IS NULL OR p.tags @> $5::text[])
  AND (
    $6::numeric IS NULL
    OR ${SCORE_EXPR} < $6::numeric
    OR (
      ${SCORE_EXPR} = $6::numeric
      AND p.id > $7::uuid
    )
  )
ORDER BY ${SCORE_EXPR} DESC, p.id ASC
LIMIT $8`;

function readyPhoto(row: Record<string, unknown>): SearchPhoto {
  const photo = mapPhotoRow(row);
  if (!photo || photo.status !== "ready") {
    throw Object.assign(new Error("internal_error"), { name: "InternalError" });
  }
  return {
    id: photo.id,
    ownerId: photo.ownerId,
    objectKey: photo.objectKey,
    thumbKey: photo.thumbKey,
    contentType: photo.contentType,
    byteSize: photo.byteSize,
    takenAt: photo.takenAt,
    locationText: photo.locationText,
    latitude: photo.latitude,
    longitude: photo.longitude,
    description: photo.description,
    tags: photo.tags,
    status: "ready",
    sourceUserId: photo.sourceUserId,
    sourceKeyId: photo.sourceKeyId,
    errorCode: photo.errorCode,
    createdAt: photo.createdAt,
    updatedAt: photo.updatedAt,
  };
}

export function createSearchRepository(pool: pg.Pool): SearchPort {
  return {
    async searchKeyword(input) {
      const result = await pool.query(KEYWORD_SQL, [
        input.ownerId,
        input.takenFrom,
        input.takenTo,
        input.tags,
        input.pattern,
        input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null,
        input.limit,
      ]);
      return result.rows.map((row) => ({ photo: readyPhoto(row), scoreText: null }));
    },
    async searchSemantic(input) {
      const literal = formatVectorLiteral(input.values, input.dimensions);
      const result = await pool.query(SEMANTIC_SQL, [
        input.ownerId,
        literal,
        input.takenFrom,
        input.takenTo,
        input.tags,
        input.cursor?.scoreText ?? null,
        input.cursor?.id ?? null,
        input.limit,
      ]);
      return result.rows.map((row) => {
        const scoreText = row.score_text;
        if (typeof scoreText !== "string") {
          throw Object.assign(new Error("internal_error"), { name: "InternalError" });
        }
        const hit: SearchHit = { photo: readyPhoto(row), scoreText };
        return hit;
      });
    },
  };
}
