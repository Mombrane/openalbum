const CONTROL = /[\u0000-\u001F\u007F]/;

export function normalizeApiKeyName(raw: string): string | null {
  const name = raw.trim();
  if (name.length < 1 || name.length > 64) return null;
  if (CONTROL.test(name)) return null;
  return name;
}
