/** 检索上下文（Phase 4）：关键词与向量召回。 */
export const SEARCH_CONTEXT = "search" as const;

export {
  decodeKeywordCursor,
  decodeSemanticCursor,
  encodeKeywordCursor,
  encodeSemanticCursor,
  isScoreText,
} from "./cursor.js";
export type { KeywordCursor, SemanticCursor } from "./cursor.js";
export type { SearchHit, SearchKeywordInput, SearchPhoto, SearchPort, SearchSemanticInput } from "./ports.js";
export { keywordPattern, parseSearchBody } from "./query.js";
export type { ParsedSearch, SearchParseFailure } from "./query.js";
