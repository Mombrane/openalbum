export const CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/x-canon-cr2",
  "image/x-nikon-nef",
  "image/x-sony-arw",
  "image/x-adobe-dng",
] as const;

const ALLOWED = new Set<string>(CONTENT_TYPES);

export function normalizeContentType(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.includes(";") || !ALLOWED.has(trimmed)) return null;
  return trimmed;
}
