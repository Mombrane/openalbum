import type { FastifyServerOptions } from "fastify";

const REDACT = {
  paths: [
    "req.body",
    "req.headers.authorization",
    "body",
    "password",
    "refreshToken",
    "secret",
    "accessToken",
    "originalUrl",
    "photo.originalUrl",
    "photos[*].originalUrl",
    "thumbUrl",
    "photo.thumbUrl",
    "photos[*].thumbUrl",
    "dataBase64",
    "embedding",
  ],
  censor: "[Redacted]",
};

export function authLoggerOptions(
  logger: boolean | FastifyServerOptions["logger"] | undefined,
): FastifyServerOptions["logger"] {
  if (logger === false) return false;
  const base = logger === true || logger === undefined ? {} : logger;
  return {
    ...base,
    redact: REDACT,
    serializers: {
      ...base.serializers,
      req(request: unknown) {
        const incoming = request as { method?: string; url?: string };
        return { method: incoming.method, url: incoming.url?.split("?")[0] };
      },
      res(reply: unknown) {
        const outgoing = reply as { statusCode?: number };
        return { statusCode: outgoing.statusCode };
      },
    },
  };
}
