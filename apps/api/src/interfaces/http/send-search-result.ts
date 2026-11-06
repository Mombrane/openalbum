import type { FastifyReply } from "fastify";
import type { SearchResult } from "../../adapters/search/messages.js";

export function sendSearchResult<T>(reply: FastifyReply, result: SearchResult<T>) {
  if (!result.ok) return reply.code(result.status).send({ error: { code: result.code, message: result.message } });
  return reply.code(result.status).send(result.body);
}
