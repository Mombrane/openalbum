import type { RefreshTokenRecord } from "../../domain/identity/model.js";
import type { IdentityDeps } from "./deps.js";

export type SessionBody = {
  tokenType: "Bearer";
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: { id: string; email: string };
};

export type IssuedRefresh = { record: RefreshTokenRecord; secret: string };

export function newRefreshRecord(deps: IdentityDeps, userId: string, familyId: string): IssuedRefresh {
  const createdAt = deps.clock.now();
  const secret = deps.secrets.refreshToken();
  return {
    secret,
    record: {
      id: deps.ids.nextId(),
      userId,
      tokenHash: deps.tokenHasher.hash(secret),
      familyId,
      expiresAt: new Date(createdAt.getTime() + deps.refreshTtlSeconds * 1000),
      revokedAt: null,
      replacedBy: null,
      createdAt,
    },
  };
}

export async function signSession(
  deps: IdentityDeps,
  user: { id: string; email: string },
  issued: IssuedRefresh,
): Promise<SessionBody> {
  // cid 预埋、本阶段禁止查库。credentialId 就是新 Refresh Token 行的 id。
  const accessToken = await deps.accessTokens.sign({
    userId: user.id,
    credentialId: issued.record.id,
  });
  return {
    tokenType: "Bearer",
    accessToken,
    accessTokenExpiresIn: deps.accessTtlSeconds,
    refreshToken: issued.secret,
    refreshTokenExpiresAt: issued.record.expiresAt.toISOString(),
    user: { id: user.id, email: user.email },
  };
}

export async function issueNewFamily(
  deps: IdentityDeps,
  user: { id: string; email: string },
): Promise<SessionBody> {
  const issued = newRefreshRecord(deps, user.id, deps.ids.nextId());
  await deps.refreshTokens.insert(issued.record);
  return signSession(deps, user, issued);
}
