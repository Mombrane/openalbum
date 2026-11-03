import { SignJWT, jwtVerify } from "jose";
import type { AccessTokenIssuer, Clock } from "../../domain/identity/ports.js";

const ISSUER = "openalbum";
const AUDIENCE = "openalbum-api";

export function createAccessTokenIssuer(input: {
  secret: string;
  ttlSeconds: number;
  clock: Clock;
}): AccessTokenIssuer {
  const key = new TextEncoder().encode(input.secret);
  return {
    async sign(claims) {
      // cid 预埋、本阶段禁止查库。不得用 credentialId 查询 refresh token 表。
      const issuedAt = Math.floor(input.clock.now().getTime() / 1000);
      return new SignJWT({ kind: "password_session", cid: claims.credentialId })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(claims.userId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + input.ttlSeconds)
        .sign(key);
    },
    async verify(jwt) {
      // cid 预埋、本阶段禁止查库。这里只读令牌，不访问数据库。
      try {
        const { payload, protectedHeader } = await jwtVerify(jwt, key, {
          algorithms: ["HS256"],
          issuer: ISSUER,
          audience: AUDIENCE,
          clockTolerance: 5,
          currentDate: input.clock.now(),
        });
        if (protectedHeader.alg !== "HS256") return null;
        if (payload.kind !== "password_session") return null;
        if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
        if (typeof payload.cid !== "string" || payload.cid.length === 0) return null;
        return { userId: payload.sub, credentialId: payload.cid, kind: "password_session" };
      } catch {
        return null;
      }
    },
  };
}
