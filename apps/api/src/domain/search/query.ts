import { decodeKeywordCursor, decodeSemanticCursor, type KeywordCursor, type SemanticCursor } from "./cursor.js";

const ALLOWED = new Set(["mode", "q", "takenFrom", "takenTo", "tags", "status", "limit", "cursor"]);
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export type SearchParseFailure =
  | "invalid_body"
  | "empty_query"
  | "query_too_long"
  | "invalid_tags"
  | "invalid_time"
  | "invalid_range";

type CommonQuery = {
  q: string;
  takenFrom: Date | null;
  takenTo: Date | null;
  tags: string[] | null;
  limit: number;
};

export type ParsedSearch =
  | (CommonQuery & { mode: "keyword"; cursor: KeywordCursor | null })
  | (CommonQuery & { mode: "semantic"; cursor: SemanticCursor | null });

function fail(reason: SearchParseFailure): { ok: false; reason: SearchParseFailure } {
  return { ok: false, reason };
}

function forbiddenTagControls(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseTags(present: boolean, value: unknown): string[] | null | "invalid" {
  if (!present) return null;
  if (!Array.isArray(value) || value.length > 32) return "invalid";
  if (value.length === 0) return null;
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || forbiddenTagControls(item)) return "invalid";
    const trimmed = item.trim();
    if (trimmed.length < 1 || trimmed.length > 64) return "invalid";
    if (!tags.includes(trimmed)) tags.push(trimmed);
  }
  return tags;
}

function parseInstant(present: boolean, value: unknown): Date | null | "invalid" {
  if (!present) return null;
  if (typeof value !== "string" || !INSTANT.test(value)) return "invalid";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "invalid";
  return parsed;
}

export function keywordPattern(q: string): string {
  return `%${q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export function parseSearchBody(
  body: Record<string, unknown>,
): { ok: true; query: ParsedSearch } | { ok: false; reason: SearchParseFailure } {
  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) return fail("invalid_body");
  }
  if (body.mode !== "keyword" && body.mode !== "semantic") return fail("invalid_body");
  if (!("q" in body) || typeof body.q !== "string") return fail("invalid_body");
  const q = body.q.trim();
  if (q.length === 0) return fail("empty_query");
  if (q.length > 500) return fail("query_too_long");
  if ("status" in body && body.status !== "ready") return fail("invalid_body");
  let limit = 50;
  if ("limit" in body) {
    if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 100) {
      return fail("invalid_body");
    }
    limit = body.limit;
  }
  const takenFrom = parseInstant("takenFrom" in body, body.takenFrom);
  if (takenFrom === "invalid") return fail("invalid_time");
  const takenTo = parseInstant("takenTo" in body, body.takenTo);
  if (takenTo === "invalid") return fail("invalid_time");
  if (takenFrom && takenTo && takenFrom.getTime() > takenTo.getTime()) return fail("invalid_range");
  const tags = parseTags("tags" in body, body.tags);
  if (tags === "invalid") return fail("invalid_tags");
  let cursor: KeywordCursor | SemanticCursor | null = null;
  if ("cursor" in body) {
    if (typeof body.cursor !== "string") return fail("invalid_body");
    const decoded = body.mode === "keyword" ? decodeKeywordCursor(body.cursor) : decodeSemanticCursor(body.cursor);
    if (!decoded) return fail("invalid_body");
    cursor = decoded;
  }
  const common = { q, takenFrom, takenTo, tags, limit };
  if (body.mode === "keyword") {
    return { ok: true, query: { ...common, mode: "keyword", cursor: cursor as KeywordCursor | null } };
  }
  return { ok: true, query: { ...common, mode: "semantic", cursor: cursor as SemanticCursor | null } };
}
