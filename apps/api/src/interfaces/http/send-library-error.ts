import type { FastifyReply } from "fastify";
import type { LibraryError, LibraryResult } from "../../adapters/library/messages.js";

export function sendLibraryError(reply: FastifyReply, error: LibraryError) {
  return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
}

export function sendLibraryResult<T>(reply: FastifyReply, result: LibraryResult<T>) {
  if (!result.ok) return sendLibraryError(reply, result);
  if (result.status === 204) return reply.code(204).send();
  return reply.code(result.status).send(result.body);
}
