import { buildApp } from "./app.js";
import { loadAuthConfig } from "./gateways/auth/config.js";
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
const app = await buildApp({
  config,
  storage,
  signedUrlTtlSeconds: storageConfig.signedUrlTtlSeconds,
});

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error({ url: "startup" }, error instanceof Error ? error.message : "启动失败");
  process.exit(1);
}
