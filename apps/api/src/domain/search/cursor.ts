const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const SCORE_TEXT = /^-?(?:0|[1-9]\d*)\.\d{6}$/;

export type KeywordCursor = { createdAt: Date; id: string };
export type SemanticCursor = { scoreText: string; id: string };

export function encodeKeywordCursor(createdAt: Date, id: string): string {
  return Buffer.from(`k\n${createdAt.toISOString()}\n${id.toLowerCase()}`, "utf8").toString("base64url");
}

export function encodeSemanticCursor(scoreText: string, id: string): string {
  return Buffer.from(`s\n${scoreText}\n${id.toLowerCase()}`, "utf8").toString("base64url");
}

export function isScoreText(value: string): boolean {
  return SCORE_TEXT.test(value) && value !== "-0.000000";
}

function decodeParts(raw: string): [string, string, string] | null {
  if (raw.length === 0 || raw.includes("=")) return null;
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const parts = text.split("\n");
  if (parts.length !== 3) return null;
  return [parts[0] ?? "", parts[1] ?? "", parts[2] ?? ""];
}

export function decodeKeywordCursor(raw: string): KeywordCursor | null {
  const parts = decodeParts(raw);
  if (!parts || parts[0] !== "k" || !INSTANT.test(parts[1]) || !UUID.test(parts[2])) return null;
  const createdAt = new Date(parts[1]);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: parts[2].toLowerCase() };
}

export function decodeSemanticCursor(raw: string): SemanticCursor | null {
  const parts = decodeParts(raw);
  if (!parts || parts[0] !== "s" || !isScoreText(parts[1]) || !UUID.test(parts[2])) return null;
  return { scoreText: parts[1], id: parts[2].toLowerCase() };
}
