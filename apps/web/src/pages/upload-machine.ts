import { NETWORK_MESSAGE, visibleMessage } from "../copy";

const MAX_BYTE_SIZE = 33554432;

const CONTENT_TYPE_WHITELIST = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/x-canon-cr2",
  "image/x-nikon-nef",
  "image/x-sony-arw",
  "image/x-adobe-dng",
]);

const EXTENSION_TO_TYPE: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".cr2": "image/x-canon-cr2",
  ".nef": "image/x-nikon-nef",
  ".arw": "image/x-sony-arw",
  ".dng": "image/x-adobe-dng",
};

export const UPLOAD_CLOSED_MESSAGE = "上传已结束";
export const UPLOAD_CANCELLED_MESSAGE = "已取消上传";
export const UPLOAD_COMPLETING_MESSAGE = "上传正在完成";
export const UNSUPPORTED_TYPE_MESSAGE = "不支持的文件类型";

export type UploadFailureInput = {
  network: boolean;
  status: number | null;
  code: string | null;
  serverMessage: string | null;
};

export type UploadAction =
  | { kind: "closed" }
  | { kind: "enter-auto-complete" }
  | { kind: "finish-via-complete" }
  | { kind: "button"; label: "重新上传"; action: "restart" }
  | { kind: "button"; label: "重试分片"; action: "retry-part" }
  | { kind: "button"; label: "继续完成"; action: "complete" }
  | { kind: "button"; label: "重试"; action: "complete" | "retry-part-then-complete" | "abort" };

export function contentTypeForFile(type: string, name: string): string | null {
  const stripped = type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (stripped !== "" && CONTENT_TYPE_WHITELIST.has(stripped)) {
    return stripped;
  }
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = name.slice(dot).toLowerCase();
  return EXTENSION_TO_TYPE[ext] ?? null;
}

export function validateFileSize(
  size: number,
): { ok: true } | { ok: false; message: "文件大小须为 1 字节到 32 MiB" } {
  if (size < 1 || size > MAX_BYTE_SIZE) {
    return { ok: false, message: "文件大小须为 1 字节到 32 MiB" };
  }
  return { ok: true };
}

export function onCompleting(
  attemptsLeft: number,
):
  | { kind: "schedule"; delayMs: 1000; attemptsLeft: number }
  | { kind: "button" } {
  if (attemptsLeft <= 0) {
    return { kind: "button" };
  }
  return { kind: "schedule", delayMs: 1000, attemptsLeft: attemptsLeft - 1 };
}

export function uploadFailureVisibleMessage(
  _step: "create" | "part" | "complete" | "abort",
  failure: UploadFailureInput,
): string {
  if (failure.network) {
    return NETWORK_MESSAGE;
  }
  if (failure.status === null) {
    return NETWORK_MESSAGE;
  }
  return visibleMessage({
    status: failure.status,
    code: failure.code,
    serverMessage: failure.serverMessage,
    audience: "general",
  });
}

function isClosedFailure(failure: UploadFailureInput): boolean {
  if (failure.network || failure.status === null) return false;
  if (failure.status === 404) return true;
  return failure.status === 409 && failure.code === "upload_closed";
}

export function uploadFailure(
  step: "create" | "part" | "complete" | "abort",
  failure: UploadFailureInput,
): UploadAction {
  if (step === "create") {
    return { kind: "button", label: "重新上传", action: "restart" };
  }

  if (step === "part") {
    if (failure.network) {
      return { kind: "button", label: "重试分片", action: "retry-part" };
    }
    if (failure.status === 409 && failure.code === "upload_completing") {
      return { kind: "enter-auto-complete" };
    }
    if (failure.status === 409 && failure.code === "upload_completed") {
      return { kind: "finish-via-complete" };
    }
    if (isClosedFailure(failure)) {
      return { kind: "closed" };
    }
    if (failure.status === 500 && failure.code === "storage_error") {
      return { kind: "button", label: "重试分片", action: "retry-part" };
    }
    return { kind: "button", label: "重试", action: "retry-part-then-complete" };
  }

  if (step === "complete") {
    if (failure.network) {
      return { kind: "button", label: "重试", action: "complete" };
    }
    if (failure.status === 409 && failure.code === "upload_completing") {
      return { kind: "enter-auto-complete" };
    }
    if (
      failure.status === 500 &&
      failure.serverMessage !== null &&
      failure.serverMessage === "上传未能完成"
    ) {
      return { kind: "button", label: "继续完成", action: "complete" };
    }
    if (isClosedFailure(failure)) {
      return { kind: "closed" };
    }
    return { kind: "button", label: "重试", action: "complete" };
  }

  if (failure.status === 409 && failure.code === "upload_completing") {
    return { kind: "enter-auto-complete" };
  }
  if (failure.status === 409 && failure.code === "upload_completed") {
    return { kind: "finish-via-complete" };
  }
  return { kind: "button", label: "重试", action: "abort" };
}
