import type { FastifyInstance } from "fastify";
import { MESSAGES } from "../../adapters/identity/messages.js";

const PART_UPLOAD_ROUTE = "/photos/uploads/:id/parts/:partNumber";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const validation = typeof error === "object" && error !== null && "validation" in error;
    if (validation) {
      return reply.code(400).send({ error: { code: "validation_error", message: MESSAGES.invalidBody } });
    }
    const routeUrl = request.routeOptions?.url;
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (routeUrl === PART_UPLOAD_ROUTE && code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({ error: { code: "payload_too_large", message: "文件超过 32 MiB" } });
    }
    if (routeUrl === PART_UPLOAD_ROUTE && code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.code(400).send({ error: { code: "validation_error", message: "分片不合法" } });
    }
    request.log.error({ url: request.url.split("?")[0] }, "请求失败");
    return reply.code(500).send({ error: { code: "internal_error", message: "服务器错误" } });
  });
}
