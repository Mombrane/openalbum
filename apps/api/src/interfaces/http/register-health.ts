import type { FastifyInstance } from "fastify";

/** 存活探针。不访问数据库、对象存储或领域对象。 */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/health", async () => {
    return { status: "ok" };
  });
}
