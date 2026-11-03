import { randomBytes } from "node:crypto";
import type { SecretGenerator } from "../../domain/identity/ports.js";

const PREFIX_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function createSecretGenerator(): SecretGenerator {
  return {
    refreshToken() {
      return `oalr_${randomBytes(32).toString("base64url")}`;
    },
    apiKey() {
      const prefix = `oalb_${randomPrefixBody()}`;
      return { prefix, secret: `${prefix}_${randomBytes(32).toString("base64url")}` };
    },
  };
}

function randomPrefixBody(): string {
  let out = "";
  while (out.length < 8) {
    for (const byte of randomBytes(16)) {
      if (byte < 248) {
        out += PREFIX_ALPHABET[byte % 62];
        if (out.length === 8) return out;
      }
    }
  }
  return out;
}
