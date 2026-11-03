import type { IdentityDeps } from "./deps.js";
import { MESSAGES, type AuthResult } from "./messages.js";
import { issueNewFamily, type SessionBody } from "./session.js";

export async function loginUser(
  deps: IdentityDeps,
  input: { email: string; password: string },
): Promise<AuthResult<SessionBody>> {
  const user = await deps.users.findByEmail(input.email);
  const encoded = user?.passwordHash ?? deps.passwords.dummyHash();
  const matches = await deps.passwords.verify(input.password, encoded);
  if (!user || !matches) {
    return { ok: false, status: 401, code: "invalid_credentials", message: MESSAGES.invalidCredentials };
  }
  return { ok: true, status: 200, body: await issueNewFamily(deps, { id: user.id, email: user.email }) };
}
