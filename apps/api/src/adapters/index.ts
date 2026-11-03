/**
 * 适配层入口。
 *
 * 编排身份用例。不直接写 SQL，也不调用 jose、argon2 或 node:crypto。
 */
export const ADAPTERS_LAYER = "adapters" as const;
export { createApiKey, listApiKeys, revokeApiKey } from "./identity/api-keys.js";
export type { ApiKeyDto } from "./identity/api-keys.js";
export type { IdentityDeps, ResolvePrincipalDeps } from "./identity/deps.js";
export { getMe } from "./identity/get-me.js";
export type { MeBody } from "./identity/get-me.js";
export { loginUser } from "./identity/login-user.js";
export { logoutSession } from "./identity/logout-session.js";
export { MESSAGES } from "./identity/messages.js";
export type { AuthError, AuthResult } from "./identity/messages.js";
export { registerUser } from "./identity/register-user.js";
export { isPrincipal, requirePrincipal } from "./identity/require-principal.js";
export { resolvePrincipal } from "./identity/resolve-principal.js";
export { refreshSession } from "./identity/refresh-session.js";
export type { SessionBody } from "./identity/session.js";
