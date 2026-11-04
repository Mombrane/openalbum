import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import pg from "pg";
import {
  registerApiKeyRoutes,
  registerAuthRoutes,
  registerErrorHandler,
  registerHealthRoute,
  registerMeRoute,
  registerPhotoRoutes,
} from "./interfaces/index.js";
import type { Clock } from "./domain/identity/ports.js";
import type { ObjectStorage } from "./domain/library/ports.js";
import { loadAuthConfig, type AuthConfig } from "./gateways/auth/config.js";
import { SystemClock } from "./gateways/auth/system-clock.js";
import { createFakeObjectStorage } from "./gateways/storage/fake-object-storage.js";
import { authLoggerOptions } from "./interfaces/http/auth-logger.js";
import { authLogFromFastify, createIdentityDeps } from "./wire-identity.js";
import { createLibraryDeps, libraryLogFromFastify } from "./wire-library.js";

export type BuildAppOptions = {
  logger?: boolean | FastifyServerOptions["logger"];
  config?: AuthConfig;
  clock?: Clock;
  pool?: pg.Pool;
  storage?: ObjectStorage;
  signedUrlTtlSeconds?: number;
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
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const identity = await createIdentityDeps({ config, clock, pool, log: authLogFromFastify(app.log) });
  const storage = options.storage ?? createFakeObjectStorage();
  const signedUrlTtlSeconds = options.signedUrlTtlSeconds ?? 900;
  const library = createLibraryDeps({
    pool,
    storage,
    signedUrlTtlSeconds,
    log: libraryLogFromFastify(app.log),
  });
  registerErrorHandler(app);
  registerHealthRoute(app);
  registerAuthRoutes(app, identity);
  registerMeRoute(app, identity);
  registerApiKeyRoutes(app, identity);
  registerPhotoRoutes(app, identity, library, clock);
  app.addHook("onClose", async () => {
    if (ownsPool) await pool.end();
  });
  return app;
}
