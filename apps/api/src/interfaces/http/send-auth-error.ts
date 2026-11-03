import type { FastifyReply } from "fastify";
import type { AuthError } from "../../adapters/identity/messages.js";

export function sendAuthError(reply: FastifyReply, error: AuthError) {
  return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
}

export function sendInvalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: { code: "validation_error", message } });
}
