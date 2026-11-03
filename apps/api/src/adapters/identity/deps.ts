import type {
  AccessTokenIssuer,
  ApiKeyRepository,
  AuthLog,
  Clock,
  IdGenerator,
  PasswordHasher,
  RefreshTokenRepository,
  SecretGenerator,
  TokenHasher,
  UserRepository,
} from "../../domain/identity/ports.js";

export type IdentityDeps = {
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  clock: Clock;
  ids: IdGenerator;
  passwords: PasswordHasher;
  tokenHasher: TokenHasher;
  accessTokens: AccessTokenIssuer;
  secrets: SecretGenerator;
  users: UserRepository;
  apiKeys: ApiKeyRepository;
  refreshTokens: RefreshTokenRepository;
  log: AuthLog;
};

/** JWT 校验只拿这些端口。故意不包含 RefreshTokenRepository。 */
export type ResolvePrincipalDeps = {
  accessTokens: AccessTokenIssuer;
  apiKeys: Pick<ApiKeyRepository, "findActiveByPrefix" | "touchLastUsed">;
  tokenHasher: TokenHasher;
  clock: Clock;
  log: AuthLog;
};
