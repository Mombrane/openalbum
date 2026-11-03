const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 1 || email.length > 320) return null;
  if (!EMAIL.test(email)) return null;
  return email;
}
