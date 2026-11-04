import { normalizeApiKeyName } from "../../domain/identity/api-key-name.js";
import { normalizeEmail } from "../../domain/identity/email.js";
import { validatePassword } from "../../domain/identity/password.js";
import { MESSAGES } from "../../adapters/identity/messages.js";

export function parseCredentials(body: { email: string; password: string }): { email: string; password: string } | { message: string } {
  const email = normalizeEmail(body.email);
  if (!email) return { message: MESSAGES.invalidEmail };
  if (!validatePassword(body.password)) return { message: MESSAGES.invalidPassword };
  return { email, password: body.password };
}

export function parseApiKeyName(raw: string): string | { message: string } {
  const name = normalizeApiKeyName(raw);
  return name ?? { message: MESSAGES.invalidName };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuid(raw: string): string | { message: string } {
  return UUID_RE.test(raw) ? raw.toLowerCase() : { message: MESSAGES.invalidId };
}
