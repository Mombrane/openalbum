import pg from "pg";
import { runOnce } from "./adapters/pipeline/run-once.js";
import { runWorkerLoop } from "./adapters/pipeline/worker-loop.js";
import type { WorkerControl } from "./adapters/pipeline/deps.js";
import { loadAuthConfig } from "./gateways/auth/config.js";
import { loadPipelineConfig } from "./gateways/embed/config.js";
import { createExifrReader } from "./gateways/exif/exifr-reader.js";
import { createS3ObjectStorage } from "./gateways/storage/s3-object-storage.js";
import { loadStorageConfig, productionStoragePlaceholderMessage } from "./gateways/storage/config.js";
import { createSharpThumbnailEncoder } from "./gateways/thumbnail/sharp-encoder.js";
import { createModelGateways, createPipelineDeps, createPipelineLogger } from "./wire-pipeline.js";

const auth = loadAuthConfig(process.env);
let storageConfig: ReturnType<typeof loadStorageConfig>;
try {
  storageConfig = loadStorageConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : "对象存储配置无效");
  process.exit(1);
}
const storagePlaceholder = productionStoragePlaceholderMessage(process.env);
if (storagePlaceholder) {
  console.error(storagePlaceholder);
  process.exit(1);
}
const pipeline = loadPipelineConfig(process.env);
if (!pipeline.ok) {
  console.error(pipeline.message);
  process.exit(pipeline.exitCode);
}

const pool = new pg.Pool({ connectionString: auth.databaseUrl });
const log = createPipelineLogger((line) => {
  console.log(line);
});
const models = createModelGateways(pipeline.config, log);
const deps = createPipelineDeps({
  pool,
  storage: createS3ObjectStorage(storageConfig),
  exif: createExifrReader(),
  thumbnail: createSharpThumbnailEncoder(),
  vision: models.vision,
  embed: models.embed,
  log,
  visionModel: models.visionModel,
  embedModel: models.embedModel,
  embedDimensions: models.embedDimensions,
});
const control: WorkerControl = { stopped: false, inflight: new Map() };
let stopRequested = false;

async function releaseUnfinished(now: Date): Promise<void> {
  for (const [jobId, lockedAt] of control.inflight) {
    await deps.store.releaseRunning({ jobId, lockedAt, now });
  }
  control.inflight.clear();
}

const loop = runWorkerLoop({
  pollMs: pipeline.config.pollMs,
  concurrency: pipeline.config.concurrency,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  runOnce: (now, limit) => runOnce(deps, now, limit, control),
  releaseUnfinished,
  control,
});

async function requestStop(): Promise<void> {
  if (stopRequested) return;
  stopRequested = true;
  control.stopped = true;
  await Promise.race([loop, new Promise((resolve) => setTimeout(resolve, 60000))]);
  await releaseUnfinished(new Date());
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void requestStop();
});
process.on("SIGINT", () => {
  void requestStop();
});

await loop;
await pool.end();
