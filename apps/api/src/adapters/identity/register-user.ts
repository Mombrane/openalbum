import type { IdentityDeps } from "./deps.js";
import { MESSAGES, type AuthResult } from "./messages.js";
import { issueNewFamily, type SessionBody } from "./session.js";

export async function registerUser(
  deps: IdentityDeps,
  input: { email: string; password: string },
): Promise<AuthResult<SessionBody>> {
  const createdAt = deps.clock.now();
  const passwordHash = await deps.passwords.hash(input.password);
  const user = { id: deps.ids.nextId(), email: input.email, passwordHash, createdAt };
  const inserted = await deps.users.insert(user);
  if (inserted === "email_taken") {
    return { ok: false, status: 409, code: "email_taken", message: MESSAGES.emailTaken };
  }
  return { ok: true, status: 201, body: await issueNewFamily(deps, { id: user.id, email: user.email }) };
}
