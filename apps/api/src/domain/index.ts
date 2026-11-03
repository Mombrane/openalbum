/**
 * 领域层入口。
 *
 * 只能依赖本目录和语言标准库。
 * 禁止引用 interfaces、adapters、gateways、dao，以及 Fastify、pg、S3、HTTP 客户端。
 */
export { IDENTITY_CONTEXT } from "./identity/index.js";
export { LIBRARY_CONTEXT } from "./library/index.js";
export { ALBUM_CONTEXT } from "./album/index.js";
export { SEARCH_CONTEXT } from "./search/index.js";
