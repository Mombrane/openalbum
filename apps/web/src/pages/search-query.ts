import type { SearchRequestBody } from "../api.ts";
import { validateTags, takenAtFromLocalInput } from "./photo-form";

export type { SearchRequestBody };

export type SearchFormInput = {
  mode: "keyword" | "semantic";
  q: string;
  tags: string[];
  takenFromLocal: string;
  takenToLocal: string;
  cursor?: string;
};

export type SearchPlan =
  | { type: "disabled" }
  | {
      type: "error";
      message:
        | "查询为空"
        | "查询过长"
        | "标签不合法"
        | "拍摄时间不合法"
        | "时间范围不合法";
    }
  | { type: "send"; body: SearchRequestBody };

export function planSearchSubmit(enabled: boolean, input: SearchFormInput): SearchPlan {
  if (!enabled) {
    return { type: "disabled" };
  }

  const q = input.q.trim();
  if (q.length === 0) {
    return { type: "error", message: "查询为空" };
  }
  if (q.length > 500) {
    return { type: "error", message: "查询过长" };
  }

  const tagsResult = validateTags(input.tags);
  if (!tagsResult.ok) {
    return { type: "error", message: "标签不合法" };
  }

  const takenFrom = takenAtFromLocalInput(input.takenFromLocal);
  if (!takenFrom.ok) {
    return { type: "error", message: "拍摄时间不合法" };
  }
  const takenTo = takenAtFromLocalInput(input.takenToLocal);
  if (!takenTo.ok) {
    return { type: "error", message: "拍摄时间不合法" };
  }

  if (takenFrom.takenAt !== null && takenTo.takenAt !== null) {
    if (new Date(takenFrom.takenAt).getTime() > new Date(takenTo.takenAt).getTime()) {
      return { type: "error", message: "时间范围不合法" };
    }
  }

  const body: SearchRequestBody = {
    mode: input.mode,
    q,
    limit: 20,
  };

  if (tagsResult.tags.length > 0) {
    body.tags = tagsResult.tags;
  }
  if (takenFrom.takenAt !== null) {
    body.takenFrom = takenFrom.takenAt;
  }
  if (takenTo.takenAt !== null) {
    body.takenTo = takenTo.takenAt;
  }
  if (input.cursor !== undefined && input.cursor !== "") {
    body.cursor = input.cursor;
  }

  return { type: "send", body };
}
