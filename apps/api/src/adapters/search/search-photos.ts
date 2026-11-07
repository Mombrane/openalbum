import type { LibraryActor, Photo } from "../../domain/library/model.js";
import { checkEmbedding } from "../../domain/library/pipeline.js";
import {
  encodeKeywordCursor,
  encodeSemanticCursor,
  isScoreText,
  keywordPattern,
  parseSearchBody,
  type SearchHit,
  type SearchParseFailure,
  type SearchPhoto,
} from "../../domain/search/index.js";
import { toPhotoResponse, type PhotoResponse } from "../library/photo-response.js";
import type { SearchDeps } from "./deps.js";
import {
  embedRejected,
  embedUnavailable,
  emptyQuery,
  internalError,
  invalidBody,
  invalidRange,
  invalidTags,
  invalidTime,
  queryTooLong,
  storageError,
  type SearchResult,
} from "./messages.js";

export type SearchResponseBody = {
  photos: Array<PhotoResponse & { score: number | null }>;
  nextCursor: string | null;
};

function asPhoto(photo: SearchPhoto): Photo {
  return { ...photo, status: "ready" };
}

function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error && typeof error.name === "string") {
    return error.name;
  }
  return "Error";
}

function mapParseFailure(reason: SearchParseFailure): SearchResult<SearchResponseBody> {
  if (reason === "empty_query") return emptyQuery();
  if (reason === "query_too_long") return queryTooLong();
  if (reason === "invalid_tags") return invalidTags();
  if (reason === "invalid_time") return invalidTime();
  if (reason === "invalid_range") return invalidRange();
  return invalidBody();
}

async function finish(
  deps: SearchDeps,
  actor: LibraryActor,
  now: Date,
  mode: "keyword" | "semantic",
  hits: SearchHit[],
  limit: number,
): Promise<SearchResult<SearchResponseBody>> {
  const page = hits.slice(0, limit);
  const photos: SearchResponseBody["photos"] = [];
  for (const hit of page) {
    try {
      const base = await toPhotoResponse(deps.library, asPhoto(hit.photo), now);
      photos.push({ ...base, score: hit.scoreText === null ? null : Number(hit.scoreText) });
    } catch (error) {
      deps.library.log.warn("对象存储失败", {
        userId: actor.userId,
        photoId: hit.photo.id,
        objectKey: hit.photo.objectKey,
        errorName: errorName(error),
      });
      return storageError();
    }
  }
  const last = page.at(-1);
  const nextCursor =
    hits.length > limit && last
      ? mode === "keyword"
        ? encodeKeywordCursor(last.photo.createdAt, last.photo.id)
        : encodeSemanticCursor(last.scoreText ?? "", last.photo.id)
      : null;
  return { ok: true, status: 200, body: { photos, nextCursor } };
}

export async function searchPhotos(
  deps: SearchDeps,
  actor: LibraryActor,
  body: Record<string, unknown>,
  now: Date,
): Promise<SearchResult<SearchResponseBody>> {
  const parsed = parseSearchBody(body);
  if (!parsed.ok) return mapParseFailure(parsed.reason);
  const query = parsed.query;
  if (query.mode === "keyword") {
    const hits = await deps.port.searchKeyword({
      ownerId: actor.userId,
      pattern: keywordPattern(query.q),
      takenFrom: query.takenFrom,
      takenTo: query.takenTo,
      tags: query.tags,
      cursor: query.cursor,
      limit: query.limit + 1,
    });
    return finish(deps, actor, now, "keyword", hits, query.limit);
  }
  if (!deps.embed) {
    deps.log.warn("嵌入调用失败", { userId: actor.userId, mode: "semantic", errorCode: "embed_unavailable" });
    return embedUnavailable();
  }
  const model = deps.embedModel?.trim() ?? "";
  if (model.length === 0) {
    deps.log.warn("嵌入结果无效", { userId: actor.userId, mode: "semantic", errorCode: "invalid_embedding" });
    return embedRejected();
  }
  const embedded = await deps.embed.embed({ model, text: query.q });
  if (!embedded.ok) {
    deps.log.warn("嵌入调用失败", { userId: actor.userId, mode: "semantic", errorCode: embedded.kind });
    return embedded.kind === "embed_unavailable" ? embedUnavailable() : embedRejected();
  }
  const checked = checkEmbedding(embedded.values, 1536);
  if (!checked.ok) {
    deps.log.warn("嵌入结果无效", { userId: actor.userId, mode: "semantic", errorCode: checked.code });
    return embedRejected();
  }
  let hits: SearchHit[];
  try {
    hits = await deps.port.searchSemantic({
      ownerId: actor.userId,
      values: embedded.values,
      dimensions: 1536,
      takenFrom: query.takenFrom,
      takenTo: query.takenTo,
      tags: query.tags,
      cursor: query.cursor,
      limit: query.limit + 1,
    });
  } catch (error) {
    const name = errorName(error);
    if (name === "DimensionMismatch" || name === "InvalidEmbedding") {
      deps.log.warn("嵌入结果无效", {
        userId: actor.userId,
        mode: "semantic",
        errorCode: name === "DimensionMismatch" ? "dimension_mismatch" : "invalid_embedding",
      });
      return embedRejected();
    }
    deps.log.warn("服务器错误", { userId: actor.userId, mode: "semantic", errorCode: "internal_error" });
    return internalError();
  }
  for (const hit of hits) {
    if (hit.scoreText === null || !isScoreText(hit.scoreText)) {
      deps.log.warn("服务器错误", { userId: actor.userId, mode: "semantic", errorCode: "internal_error" });
      return internalError();
    }
  }
  return finish(deps, actor, now, "semantic", hits, query.limit);
}
