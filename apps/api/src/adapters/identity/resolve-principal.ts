import type { Principal } from "../../domain/identity/model.js";
import type { ResolvePrincipalDeps } from "./deps.js";

const API_KEY = /^(oalb_[A-Za-z0-9]{8})_[A-Za-z0-9_-]+$/;

export async function resolvePrincipal(
  deps: ResolvePrincipalDeps,
  authorization: string | undefined,
): Promise<Principal | null> {
  const credential = parseBearer(authorization);
  if (credential === null) return null;
  if (credential.split(".").length - 1 === 2) {
    // cid 预埋、本阶段禁止查库。参数类型里没有刷新令牌仓储。
    const verified = await deps.accessTokens.verify(credential);
    if (!verified) return null;
    return {
      userId: verified.userId,
      credentialKind: "password_session",
      credentialId: verified.credentialId,
    };
  }
  if (credential.startsWith("oalb_")) {
    const matched = API_KEY.exec(credential);
    const prefix = matched?.[1];
    if (!prefix) return null;
    const presented = deps.tokenHasher.hash(credential);
    for (const row of await deps.apiKeys.findActiveByPrefix(prefix)) {
      if (!deps.tokenHasher.equal(presented, row.keyHash)) continue;
      try {
        await deps.apiKeys.touchLastUsed(row.id, deps.clock.now());
      } catch {
        deps.log.warn("api_key_last_used_failed", {
          userId: row.userId,
          keyId: row.id,
          keyPrefix: row.keyPrefix,
        });
      }
      return { userId: row.userId, credentialKind: "api_key", credentialId: row.id };
    }
    return null;
  }
  return null;
}

export function parseBearer(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const trimmed = authorization.trim();
  const separator = trimmed.indexOf(" ");
  if (separator <= 0) return null;
  if (trimmed.slice(0, separator).toLowerCase() !== "bearer") return null;
  const value = trimmed.slice(separator + 1).trim();
  return value.length === 0 ? null : value;
}
