/** 嵌入网关占位（Phase 3 调用外部向量 API）。 */
export const EMBED_GATEWAY = "embed" as const;

export { loadPipelineConfig, EMBED_VECTOR_DIMENSIONS } from "./config.js";
export type { PipelineConfig, PipelineConfigResult } from "./config.js";
export { deterministicEmbedding } from "./deterministic.js";
export { createFakeEmbedGateway } from "./fake-embed.js";
export type { FakeEmbedOptions } from "./fake-embed.js";
export { createHttpEmbedGateway } from "./http-embed.js";
export type { EmbedHttpConfig } from "./http-embed.js";
