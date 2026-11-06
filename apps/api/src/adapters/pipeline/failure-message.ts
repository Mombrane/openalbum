import type { PipelineErrorCode } from "../../domain/library/pipeline.js";

export function pipelineFailureMessage(code: PipelineErrorCode): string {
  switch (code) {
    case "storage":
    case "original_missing":
      return "对象存储失败";
    case "thumbnail_failed":
      return "缩略图失败";
    case "vision_unavailable":
    case "vision_rejected":
      return "视觉调用失败";
    case "embed_unavailable":
    case "embed_rejected":
      return "嵌入调用失败";
    case "dimension_mismatch":
    case "invalid_embedding":
      return "维度不一致";
  }
}
