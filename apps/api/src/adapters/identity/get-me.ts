import type { Principal } from "../../domain/identity/model.js";
import type { IdentityDeps } from "./deps.js";
import { unauthorized, type AuthResult } from "./messages.js";

export type MeBody = {
  user: { id: string; email: string };
  principal: Principal;
};

export async function getMe(deps: IdentityDeps, principal: Principal): Promise<AuthResult<MeBody>> {
  const user = await deps.users.findById(principal.userId);
  if (!user) return unauthorized();
  return {
    ok: true,
    status: 200,
    body: {
      user: { id: user.id, email: user.email },
      principal: {
        userId: principal.userId,
        credentialKind: principal.credentialKind,
        credentialId: principal.credentialId,
      },
    },
  };
}
