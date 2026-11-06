/** 嵌入网关占位（Phase 3 调用外部向量 API）。 */
export const EMBED_GATEWAY = "embed" as const;

export {
  API_EMBED_DISABLED_MESSAGE,
  EMBED_VECTOR_DIMENSIONS,
  embedCredentialsArePlaceholder,
  loadApiEmbedConfig,
  loadPipelineConfig,
} from "./config.js";
export type { ApiEmbedConfig, ApiEmbedConfigResult, PipelineConfig, PipelineConfigResult } from "./config.js";
export { deterministicEmbedding } from "./deterministic.js";
export { createFakeEmbedGateway } from "./fake-embed.js";
export type { FakeEmbedOptions } from "./fake-embed.js";
export { createHttpEmbedGateway } from "./http-embed.js";
export type { EmbedHttpConfig } from "./http-embed.js";
