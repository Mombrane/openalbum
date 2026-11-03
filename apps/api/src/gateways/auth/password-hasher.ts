import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { PasswordHasher } from "../../domain/identity/ports.js";

const options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function createPasswordHasher(): Promise<PasswordHasher> {
  const dummy = await argon2.hash(randomBytes(32).toString("base64url"), options);
  return {
    dummyHash: () => dummy,
    hash(plain: string) {
      return argon2.hash(plain, options);
    },
    async verify(plain: string, encoded: string) {
      try {
        return await argon2.verify(encoded, plain);
      } catch {
        return false;
      }
    },
  };
}
