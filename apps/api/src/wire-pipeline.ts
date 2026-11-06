import pg from "pg";
import type { PipelineDeps, PipelineLog, PipelineLogFields } from "./adapters/pipeline/deps.js";
import { createPipelineStore } from "./dao/pipeline-store.js";
import type { EmbedGateway, ExifReader, ObjectStorage, ThumbnailEncoder, VisionGateway } from "./domain/library/ports.js";
import { createFakeEmbedGateway } from "./gateways/embed/fake-embed.js";
import { createHttpEmbedGateway } from "./gateways/embed/http-embed.js";
import type { PipelineConfig } from "./gateways/embed/config.js";
import { createFakeVisionGateway } from "./gateways/vision/fake-vision.js";
import { createHttpVisionGateway } from "./gateways/vision/http-vision.js";

const PIPELINE_LOG_KEYS = ["userId", "photoId", "objectKey", "jobId", "jobType", "step", "attempt", "errorCode", "errorName"] as const;

export function createPipelineLogger(write: (line: string) => void): PipelineLog {
  const emit = (level: "info" | "warn", message: string, fields: PipelineLogFields) => {
    const safe: Record<string, unknown> = { level, message };
    for (const key of PIPELINE_LOG_KEYS) {
      if (fields[key] !== undefined) safe[key] = fields[key];
    }
    write(JSON.stringify(safe));
  };
  return {
    info(message, fields) {
      emit("info", message, fields);
    },
    warn(message, fields) {
      emit("warn", message, fields);
    },
  };
}

export function createModelGateways(config: PipelineConfig, log: PipelineLog): {
  vision: VisionGateway;
  embed: EmbedGateway;
  visionModel: string;
  embedModel: string;
  embedDimensions: number;
} {
  const vision = config.vision.kind === "fake"
    ? createFakeVisionGateway({ description: "未配置视觉模型", tags: ["未配置"] })
    : createHttpVisionGateway(config.vision);
  log.info(config.vision.kind === "fake" ? "视觉网关使用假实现" : "视觉网关使用 HTTP", {});
  const embed = config.embed.kind === "fake"
    ? createFakeEmbedGateway({ dimensions: config.embed.dimensions })
    : createHttpEmbedGateway(config.embed);
  log.info(config.embed.kind === "fake" ? "嵌入网关使用假实现" : "嵌入网关使用 HTTP", {});
  return {
    vision,
    embed,
    visionModel: config.vision.model,
    embedModel: config.embed.model,
    embedDimensions: config.embed.dimensions,
  };
}

export function createPipelineDeps(input: {
  pool: pg.Pool;
  storage: ObjectStorage;
  exif: ExifReader;
  thumbnail: ThumbnailEncoder;
  vision: VisionGateway;
  embed: EmbedGateway;
  log: PipelineLog;
  visionModel: string;
  embedModel: string;
  embedDimensions: number;
}): PipelineDeps {
  return {
    store: createPipelineStore(input.pool),
    storage: input.storage,
    exif: input.exif,
    thumbnail: input.thumbnail,
    vision: input.vision,
    embed: input.embed,
    log: input.log,
    visionModel: input.visionModel,
    embedModel: input.embedModel,
    embedDimensions: input.embedDimensions,
  };
}
