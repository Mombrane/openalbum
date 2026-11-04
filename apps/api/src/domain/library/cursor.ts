const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const LIMIT = /^(?:[1-9][0-9]?|100)$/;

export function parsePhotoLimit(raw: string | undefined): number | "invalid" {
  if (raw === undefined) return 50;
  if (!LIMIT.test(raw)) return "invalid";
  return Number(raw);
}

export function encodePhotoCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}\n${id}`, "utf8").toString("base64url");
}

export function decodePhotoCursor(raw: string): { createdAt: Date; id: string } | null {
  if (raw.includes("=") || raw.length === 0) return null;
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const splitAt = text.indexOf("\n");
  if (splitAt <= 0) return null;
  const createdAtRaw = text.slice(0, splitAt);
  const id = text.slice(splitAt + 1);
  if (!INSTANT.test(createdAtRaw) || !UUID.test(id)) return null;
  const createdAt = new Date(createdAtRaw);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: id.toLowerCase() };
}
