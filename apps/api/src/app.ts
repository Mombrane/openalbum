import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import pg from "pg";
import { registerAuthRoutes, registerErrorHandler, registerHealthRoute } from "./interfaces/index.js";
import type { Clock } from "./domain/identity/ports.js";
import { loadAuthConfig, type AuthConfig } from "./gateways/auth/config.js";
import { SystemClock } from "./gateways/auth/system-clock.js";
import { authLoggerOptions } from "./interfaces/http/auth-logger.js";
import { authLogFromFastify, createIdentityDeps } from "./wire-identity.js";

export type BuildAppOptions = {
  logger?: boolean | FastifyServerOptions["logger"];
  config?: AuthConfig;
  clock?: Clock;
  pool?: pg.Pool;
};

/**
 * 组合根。业务规则不写在这里。
 * 传入 pool 时，close 不结束该 pool。
 * 不在这里发 SQL；GET /health 不访问数据库。
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadAuthConfig(process.env);
  const clock = options.clock ?? new SystemClock();
  const pool = options.pool ?? new pg.Pool({ connectionString: config.databaseUrl });
  const ownsPool = options.pool === undefined;
  const app = Fastify({
    logger: authLoggerOptions(options.logger),
    ajv: { customOptions: { removeAdditional: false } },
  });
  const deps = await createIdentityDeps({ config, clock, pool, log: authLogFromFastify(app.log) });
  registerErrorHandler(app);
  registerHealthRoute(app);
  registerAuthRoutes(app, deps);
  app.addHook("onClose", async () => {
    if (ownsPool) await pool.end();
  });
  return app;
}
