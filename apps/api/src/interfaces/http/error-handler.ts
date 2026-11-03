import type { FastifyInstance } from "fastify";
import { MESSAGES } from "../../adapters/identity/messages.js";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const validation = typeof error === "object" && error !== null && "validation" in error;
    if (validation) {
      return reply.code(400).send({ error: { code: "validation_error", message: MESSAGES.invalidBody } });
    }
    request.log.error({ url: request.url.split("?")[0] }, "请求失败");
    return reply.code(500).send({ error: { code: "internal_error", message: "服务器错误" } });
  });
}
