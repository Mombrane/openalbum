import type { FastifyInstance } from "fastify";
import { loginUser, logoutSession, refreshSession, registerUser, type IdentityDeps } from "../../adapters/index.js";
import { parseCredentials } from "./validation.js";
import { sendAuthError, sendInvalid } from "./send-auth-error.js";

const credentialsBody = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: { email: { type: "string" }, password: { type: "string" } },
};

const refreshBody = {
  type: "object",
  additionalProperties: false,
  required: ["refreshToken"],
  properties: { refreshToken: { type: "string", minLength: 1 } },
};

export function registerAuthRoutes(app: FastifyInstance, deps: IdentityDeps): void {
  // 禁止 request.log / reply.log，禁止把 request.body 交给 logger。
  app.post("/auth/register", { schema: { body: credentialsBody } }, async (request, reply) => {
    const body = request.body as { email: string; password: string };
    const parsed = parseCredentials(body);
    if ("message" in parsed) return sendInvalid(reply, parsed.message);
    const result = await registerUser(deps, parsed);
    if (!result.ok) return sendAuthError(reply, result);
    return reply.code(201).send(result.body);
  });

  app.post("/auth/login", { schema: { body: credentialsBody } }, async (request, reply) => {
    const body = request.body as { email: string; password: string };
    const parsed = parseCredentials(body);
    if ("message" in parsed) return sendInvalid(reply, parsed.message);
    const result = await loginUser(deps, parsed);
    if (!result.ok) return sendAuthError(reply, result);
    return reply.code(200).send(result.body);
  });

  app.post("/auth/refresh", { schema: { body: refreshBody } }, async (request, reply) => {
    const body = request.body as { refreshToken: string };
    const result = await refreshSession(deps, body.refreshToken);
    if (!result.ok) return sendAuthError(reply, result);
    return reply.code(200).send(result.body);
  });

  app.post("/auth/logout", { schema: { body: refreshBody } }, async (request, reply) => {
    const body = request.body as { refreshToken: string };
    await logoutSession(deps, body.refreshToken);
    return reply.code(204).send();
  });
}
