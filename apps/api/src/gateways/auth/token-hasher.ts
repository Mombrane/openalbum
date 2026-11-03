import { createHmac, timingSafeEqual } from "node:crypto";
import type { TokenHasher } from "../../domain/identity/ports.js";

/**
 * pepper 来自环境变量 API_KEY_PEPPER。
 * API Key 与 Refresh Token 共用这一把 HMAC 键。本阶段不引入 TOKEN_PEPPER。
 */
export function createTokenHasher(pepper: string): TokenHasher {
  return {
    hash(raw: string) {
      return createHmac("sha256", pepper).update(raw, "utf8").digest("hex");
    },
    equal(leftHex: string, rightHex: string) {
      const left = Buffer.from(leftHex, "hex");
      const right = Buffer.from(rightHex, "hex");
      if (left.length === 0 || left.length !== right.length) return false;
      return timingSafeEqual(left, right);
    },
  };
}
