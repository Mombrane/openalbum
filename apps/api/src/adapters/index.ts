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
export { abortUpload } from "./library/abort-upload.js";
export { completeUpload } from "./library/complete-upload.js";
export { createUpload } from "./library/create-upload.js";
export type { UploadSessionResponse } from "./library/create-upload.js";
export { deletePhoto } from "./library/delete-photo.js";
export type { LibraryDeps } from "./library/deps.js";
export { getPhoto } from "./library/get-photo.js";
export { listPhotos } from "./library/list-photos.js";
export { patchPhoto } from "./library/patch-photo.js";
export type { PhotoResponse } from "./library/photo-response.js";
export { uploadPart } from "./library/upload-part.js";
export { runOnce } from "./pipeline/run-once.js";
