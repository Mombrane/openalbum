import { decideRefresh } from "../../domain/identity/refresh-policy.js";
import type { IdentityDeps } from "./deps.js";
import { unauthorized, type AuthResult } from "./messages.js";
import { newRefreshRecord, signSession, type SessionBody } from "./session.js";

export async function refreshSession(deps: IdentityDeps, refreshToken: string): Promise<AuthResult<SessionBody>> {
  let result: AuthResult<SessionBody> = unauthorized();
  await deps.refreshTokens.transactByHash(deps.tokenHasher.hash(refreshToken), async (row, tx) => {
    const now = deps.clock.now();
    const decision = decideRefresh(row === null ? null : { revokedAt: row.revokedAt, expiresAt: row.expiresAt }, now);
    if (decision.kind === "missing" || decision.kind === "expired" || row === null) {
      result = unauthorized();
      return;
    }
    if (decision.kind === "replay") {
      await tx.revokeFamily(row.familyId, now);
      result = unauthorized();
      return;
    }
    const issued = newRefreshRecord(deps, row.userId, row.familyId);
    const body = await signSession(deps, { id: row.userId, email: row.userEmail }, issued);
    await tx.insert(issued.record);
    await tx.markReplaced(row.id, issued.record.id, now);
    result = { ok: true, status: 200, body };
  });
  return result;
}
