/** 视觉网关占位（Phase 3 调用外部描述 / 标签 API）。 */
export const VISION_GATEWAY = "vision" as const;

export { createFakeVisionGateway } from "./fake-vision.js";
export type { FakeVisionOptions } from "./fake-vision.js";
export { createHttpVisionGateway } from "./http-vision.js";
export type { VisionHttpConfig } from "./http-vision.js";
