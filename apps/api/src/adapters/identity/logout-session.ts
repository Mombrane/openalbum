import type { IdentityDeps } from "./deps.js";

export async function logoutSession(deps: IdentityDeps, refreshToken: string): Promise<void> {
  await deps.refreshTokens.revokeByHash(deps.tokenHasher.hash(refreshToken), deps.clock.now());
}
