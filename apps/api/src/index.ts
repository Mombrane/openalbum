import { buildApp } from "./app.js";
import { loadAuthConfig } from "./gateways/auth/config.js";

const config = loadAuthConfig(process.env);
const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "0.0.0.0";

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`PORT 无效：${process.env.PORT}`);
}

const app = await buildApp({ config });

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error({ url: "startup" }, error instanceof Error ? error.message : "启动失败");
  process.exit(1);
}
