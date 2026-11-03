import type { FastifyInstance } from "fastify";
import {
  createApiKey,
  isPrincipal,
  listApiKeys,
  requirePrincipal,
  revokeApiKey,
  type IdentityDeps,
} from "../../adapters/index.js";
import { sendAuthError, sendInvalid } from "./send-auth-error.js";
import { parseApiKeyName, parseUuid } from "./validation.js";

const nameBody = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string" } },
};

export function registerApiKeyRoutes(app: FastifyInstance, deps: IdentityDeps): void {
  async function principalOf(authorization: string | string[] | undefined) {
    const header = Array.isArray(authorization) ? undefined : authorization;
    return requirePrincipal(deps, header);
  }

  app.post("/api-keys", { schema: { body: nameBody } }, async (request, reply) => {
    const principal = await principalOf(request.headers.authorization);
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    const name = parseApiKeyName((request.body as { name: string }).name);
    if (typeof name !== "string") return sendInvalid(reply, name.message);
    const result = await createApiKey(deps, principal, name);
    if (!result.ok) return sendAuthError(reply, result);
    return reply.code(201).send(result.body);
  });

  app.get("/api-keys", async (request, reply) => {
    const principal = await principalOf(request.headers.authorization);
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    const result = await listApiKeys(deps, principal);
    if (!result.ok) return sendAuthError(reply, result);
    return reply.code(200).send(result.body);
  });

  app.delete("/api-keys/:id", async (request, reply) => {
    const principal = await principalOf(request.headers.authorization);
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    const id = parseUuid((request.params as { id: string }).id);
    if (typeof id !== "string") return sendInvalid(reply, id.message);
    const result = await revokeApiKey(deps, principal, id);
    if (!result.ok) return sendAuthError(reply, result);
    return reply.code(204).send();
  });
}
