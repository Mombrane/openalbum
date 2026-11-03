export const CREDENTIAL_KINDS = ["password_session", "api_key"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** 两种成功凭证的 credentialId 都必填。 */
export type Principal = {
  userId: string;
  credentialKind: CredentialKind;
  credentialId: string;
};

export type User = {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
};

export type ApiKeyRecord = {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

export type RefreshTokenRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
  createdAt: Date;
};

export type LockedRefreshToken = {
  id: string;
  userId: string;
  userEmail: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
};
