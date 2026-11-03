import type { FastifyInstance } from "fastify";
import { getMe, isPrincipal, requirePrincipal, type IdentityDeps } from "../../adapters/index.js";
import { sendAuthError } from "./send-auth-error.js";

export function registerMeRoute(app: FastifyInstance, deps: IdentityDeps): void {
  app.get("/me", async (request, reply) => {
    const header = Array.isArray(request.headers.authorization) ? undefined : request.headers.authorization;
    const principal = await requirePrincipal(deps, header);
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    const result = await getMe(deps, principal);
    if (!result.ok) return sendAuthError(reply, result);
    return reply.code(200).send(result.body);
  });
}
