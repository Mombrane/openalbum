import { buildApp } from "./app.js";
import type { EmbedGateway } from "./domain/library/ports.js";
import { loadAuthConfig } from "./gateways/auth/config.js";
import { loadApiEmbedConfig } from "./gateways/embed/config.js";
import { createS3ObjectStorage } from "./gateways/storage/s3-object-storage.js";
import { loadStorageConfig, productionStoragePlaceholderMessage } from "./gateways/storage/config.js";

const config = loadAuthConfig(process.env);

let storageConfig: ReturnType<typeof loadStorageConfig>;
try {
  storageConfig = loadStorageConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : "对象存储配置无效");
  process.exit(1);
}

/** production S3 占位符退出文案：对象存储配置仍是占位符 */
const storagePlaceholder = productionStoragePlaceholderMessage(process.env);
if (storagePlaceholder) {
  console.error(storagePlaceholder);
  process.exit(1);
}

const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "0.0.0.0";

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`PORT 无效：${process.env.PORT}`);
}

const storage = createS3ObjectStorage(storageConfig);

const embedLoaded = loadApiEmbedConfig(process.env);
if (!embedLoaded.ok) {
  console.error(embedLoaded.message);
  process.exit(embedLoaded.exitCode);
}

let embed: EmbedGateway | undefined;
let embedModel: string | undefined;
if (embedLoaded.config.kind === "disabled") {
  console.error("嵌入配置仍是占位符，语义检索不可用");
} else {
  embed = embedLoaded.config.gateway;
  embedModel = embedLoaded.config.model;
}

const app = await buildApp({
  config,
  storage,
  signedUrlTtlSeconds: storageConfig.signedUrlTtlSeconds,
  embed,
  embedModel,
});

if (embedLoaded.config.kind === "fake") app.log.info("嵌入网关使用假实现");
if (embedLoaded.config.kind === "http") app.log.info("嵌入网关使用 HTTP");

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error({ url: "startup" }, error instanceof Error ? error.message : "启动失败");
  process.exit(1);
}
