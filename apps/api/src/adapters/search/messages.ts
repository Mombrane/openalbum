export const SEARCH_MESSAGES = {
  invalidBody: "请求不合法",
  emptyQuery: "查询为空",
  queryTooLong: "查询过长",
  invalidTags: "标签不合法",
  invalidTime: "拍摄时间不合法",
  invalidRange: "时间范围不合法",
  embedRejected: "嵌入被拒绝",
  embedUnavailable: "嵌入暂不可用",
  storageError: "对象存储不可用",
  internalError: "服务器错误",
} as const;

export type SearchError = {
  ok: false;
  status: 400 | 500 | 502 | 503;
  code:
    | "validation_error"
    | "empty_query"
    | "query_too_long"
    | "embed_rejected"
    | "embed_unavailable"
    | "storage_error"
    | "internal_error";
  message: string;
};

export type SearchSuccess<T> = { ok: true; status: 200; body: T };
export type SearchResult<T> = SearchSuccess<T> | SearchError;

function error(status: SearchError["status"], code: SearchError["code"], message: string): SearchError {
  return { ok: false, status, code, message };
}

export function invalidBody(): SearchError {
  return error(400, "validation_error", SEARCH_MESSAGES.invalidBody);
}

export function emptyQuery(): SearchError {
  return error(400, "empty_query", SEARCH_MESSAGES.emptyQuery);
}

export function queryTooLong(): SearchError {
  return error(400, "query_too_long", SEARCH_MESSAGES.queryTooLong);
}

export function invalidTags(): SearchError {
  return error(400, "validation_error", SEARCH_MESSAGES.invalidTags);
}

export function invalidTime(): SearchError {
  return error(400, "validation_error", SEARCH_MESSAGES.invalidTime);
}

export function invalidRange(): SearchError {
  return error(400, "validation_error", SEARCH_MESSAGES.invalidRange);
}

export function embedRejected(): SearchError {
  return error(502, "embed_rejected", SEARCH_MESSAGES.embedRejected);
}

export function embedUnavailable(): SearchError {
  return error(503, "embed_unavailable", SEARCH_MESSAGES.embedUnavailable);
}

export function storageError(): SearchError {
  return error(500, "storage_error", SEARCH_MESSAGES.storageError);
}

export function internalError(): SearchError {
  return error(500, "internal_error", SEARCH_MESSAGES.internalError);
}
