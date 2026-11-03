import type { Principal } from "../../domain/identity/model.js";
import type { IdentityDeps } from "./deps.js";
import { unauthorized, type AuthError } from "./messages.js";
import { resolvePrincipal } from "./resolve-principal.js";

export async function requirePrincipal(
  deps: IdentityDeps,
  authorization: string | undefined,
): Promise<Principal | AuthError> {
  // 只传入校验需要的端口。cid 预埋、本阶段禁止查库。
  const principal = await resolvePrincipal(
    {
      accessTokens: deps.accessTokens,
      apiKeys: deps.apiKeys,
      tokenHasher: deps.tokenHasher,
      clock: deps.clock,
      log: deps.log,
    },
    authorization,
  );
  return principal ?? unauthorized();
}

export function isPrincipal(value: Principal | AuthError): value is Principal {
  return !("ok" in value);
}
