/** 身份上下文：用户、口令会话、Refresh Token、API Key。 */
export const IDENTITY_CONTEXT = "identity" as const;

export { normalizeApiKeyName } from "./api-key-name.js";
export { normalizeEmail } from "./email.js";
export {
  CREDENTIAL_KINDS,
  type ApiKeyRecord,
  type CredentialKind,
  type LockedRefreshToken,
  type Principal,
  type RefreshTokenRecord,
  type User,
} from "./model.js";
export { validatePassword } from "./password.js";
export type {
  AccessTokenClaims,
  AccessTokenIssuer,
  ApiKeyRepository,
  AuthLog,
  Clock,
  GeneratedApiKey,
  IdGenerator,
  PasswordHasher,
  RefreshTokenRepository,
  RefreshTokenTx,
  SecretGenerator,
  TokenHasher,
  UserRepository,
  VerifiedAccessToken,
} from "./ports.js";
export { decideRefresh, type RefreshDecision, type RefreshSnapshot } from "./refresh-policy.js";
