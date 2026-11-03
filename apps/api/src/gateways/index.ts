/**
 * 网关层入口。
 *
 * 实现领域或应用定义的出站端口。不做业务判断，也不被接口层直接调用。
 */
export { STORAGE_GATEWAY } from "./storage/index.js";
export { VISION_GATEWAY } from "./vision/index.js";
export { EMBED_GATEWAY } from "./embed/index.js";
export { loadAuthConfig, parseDurationSeconds } from "./auth/config.js";
export type { AuthConfig } from "./auth/config.js";
