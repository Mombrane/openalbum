import type { ApiKeyRecord, LockedRefreshToken, RefreshTokenRecord, User } from "./model.js";

export type Clock = { now(): Date };
export type IdGenerator = { nextId(): string };

export type PasswordHasher = {
  hash(plain: string): Promise<string>;
  verify(plain: string, encoded: string): Promise<boolean>;
  /** 启动时生成的固定 argon2id 哑哈希，不对应任何账户。 */
  dummyHash(): string;
};

export type TokenHasher = {
  hash(raw: string): string;
  equal(leftHex: string, rightHex: string): boolean;
};

export type AccessTokenClaims = { userId: string; credentialId: string };
export type VerifiedAccessToken = {
  userId: string;
  credentialId: string;
  kind: "password_session";
};

export type AccessTokenIssuer = {
  sign(claims: AccessTokenClaims): Promise<string>;
  /**
   * 只校验令牌本身。cid 预埋、本阶段禁止查库。
   * 任何失败都返回 null，不抛错。
   */
  verify(jwt: string): Promise<VerifiedAccessToken | null>;
};

export type GeneratedApiKey = { prefix: string; secret: string };
export type SecretGenerator = {
  refreshToken(): string;
  apiKey(): GeneratedApiKey;
};

export type AuthLog = {
  warn(event: string, fields: { userId?: string; keyId?: string; keyPrefix?: string }): void;
};

export type UserRepository = {
  insert(user: User): Promise<"ok" | "email_taken">;
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
};

export type ApiKeyRepository = {
  insert(record: ApiKeyRecord): Promise<void>;
  listByUser(userId: string): Promise<ApiKeyRecord[]>;
  findActiveByPrefix(prefix: string): Promise<ApiKeyRecord[]>;
  revoke(id: string, userId: string, revokedAt: Date): Promise<"revoked" | "already" | "missing">;
  touchLastUsed(id: string, usedAt: Date): Promise<void>;
};

export type RefreshTokenTx = {
  insert(record: RefreshTokenRecord): Promise<void>;
  revokeFamily(familyId: string, revokedAt: Date): Promise<void>;
  markReplaced(id: string, replacedBy: string, revokedAt: Date): Promise<void>;
};

export type RefreshTokenRepository = {
  insert(record: RefreshTokenRecord): Promise<void>;
  /**
   * 在一个事务里按 token_hash 执行 SELECT … FOR UPDATE。
   * 找不到行时 row 为 null，mutate 若不再写库则整个事务不改数据。
   * mutate 抛错则回滚。
   */
  transactByHash(
    tokenHash: string,
    mutate: (row: LockedRefreshToken | null, tx: RefreshTokenTx) => Promise<void>,
  ): Promise<void>;
  /** 只撤销匹配的那一行。不存在或已经撤销时不报错，不连坐 family。 */
  revokeByHash(tokenHash: string, revokedAt: Date): Promise<void>;
};
