import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import type { IdentityDeps } from "./adapters/identity/deps.js";
import type { AuthLog, Clock } from "./domain/identity/ports.js";
import { createApiKeyRepository, createRefreshTokenRepository, createUserRepository } from "./dao/index.js";
import type { AuthConfig } from "./gateways/auth/config.js";
import {
  createAccessTokenIssuer,
  createIdGenerator,
  createPasswordHasher,
  createSecretGenerator,
  createTokenHasher,
} from "./gateways/index.js";

/**
 * 组合根装配。禁止把本文件移进 adapters、interfaces、domain、dao 或 gateways。
 */
export async function createIdentityDeps(input: {
  config: AuthConfig;
  clock: Clock;
  pool: pg.Pool;
  log: AuthLog;
}): Promise<IdentityDeps> {
  return {
    accessTtlSeconds: input.config.accessTtlSeconds,
    refreshTtlSeconds: input.config.refreshTtlSeconds,
    clock: input.clock,
    ids: createIdGenerator(),
    passwords: await createPasswordHasher(),
    tokenHasher: createTokenHasher(input.config.pepper),
    accessTokens: createAccessTokenIssuer({
      secret: input.config.jwtSecret,
      ttlSeconds: input.config.accessTtlSeconds,
      clock: input.clock,
    }),
    secrets: createSecretGenerator(),
    users: createUserRepository(input.pool),
    apiKeys: createApiKeyRepository(input.pool),
    refreshTokens: createRefreshTokenRepository(input.pool),
    log: input.log,
  };
}

export function authLogFromFastify(logger: FastifyBaseLogger): AuthLog {
  return {
    warn(event, fields) {
      logger.warn({ event, userId: fields.userId, keyId: fields.keyId, keyPrefix: fields.keyPrefix }, event);
    },
  };
}
