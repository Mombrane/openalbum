import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoute } from "./interfaces/index.js";

export type BuildAppOptions = {
  logger?: boolean;
};

/**
 * 组合根。后续阶段在这里装配适配层、DAO 与网关。
 * 业务路由仍从接口层进入，不在此写规则。
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  registerHealthRoute(app);
  return app;
}
