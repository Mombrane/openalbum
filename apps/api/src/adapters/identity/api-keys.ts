import type { ApiKeyRecord, Principal } from "../../domain/identity/model.js";
import type { IdentityDeps } from "./deps.js";
import { forbidden, MESSAGES, type AuthResult } from "./messages.js";

export type ApiKeyDto = {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export async function createApiKey(
  deps: IdentityDeps,
  principal: Principal,
  name: string,
): Promise<AuthResult<{ apiKey: ApiKeyDto; secret: string }>> {
  if (principal.credentialKind !== "password_session") return forbidden();
  const generated = deps.secrets.apiKey();
  const record: ApiKeyRecord = {
    id: deps.ids.nextId(),
    userId: principal.userId,
    name,
    keyPrefix: generated.prefix,
    keyHash: deps.tokenHasher.hash(generated.secret),
    revokedAt: null,
    lastUsedAt: null,
    createdAt: deps.clock.now(),
  };
  await deps.apiKeys.insert(record);
  return { ok: true, status: 201, body: { apiKey: toApiKeyDto(record), secret: generated.secret } };
}

export async function listApiKeys(
  deps: IdentityDeps,
  principal: Principal,
): Promise<AuthResult<{ apiKeys: ApiKeyDto[] }>> {
  if (principal.credentialKind !== "password_session") return forbidden();
  const records = await deps.apiKeys.listByUser(principal.userId);
  return { ok: true, status: 200, body: { apiKeys: records.map(toApiKeyDto) } };
}

export async function revokeApiKey(deps: IdentityDeps, principal: Principal, id: string): Promise<AuthResult<null>> {
  if (principal.credentialKind !== "password_session") return forbidden();
  const outcome = await deps.apiKeys.revoke(id, principal.userId, deps.clock.now());
  if (outcome === "missing") {
    return { ok: false, status: 404, code: "not_found", message: MESSAGES.notFound };
  }
  return { ok: true, status: 204, body: null };
}

function toApiKeyDto(record: ApiKeyRecord): ApiKeyDto {
  return {
    id: record.id,
    name: record.name,
    keyPrefix: record.keyPrefix,
    createdAt: record.createdAt.toISOString(),
    lastUsedAt: record.lastUsedAt ? record.lastUsedAt.toISOString() : null,
    revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
  };
}
