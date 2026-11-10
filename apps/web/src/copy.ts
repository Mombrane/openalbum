export const LOADING = "正在加载";
export const NETWORK_MESSAGE = "网络不可用，请重试";
export const SESSION_EXPIRED = "登录已失效";
export const SEARCH_NOT_READY = "检索接口尚未就绪";
export const ALBUM_NOT_READY = "共享册接口尚未接通。";

const ALLOWED_MESSAGES = new Set<string>([
  "请求不合法",
  "邮箱格式不正确",
  "密码长度须为 8 到 128",
  "名称不合法",
  "标识不合法",
  "未授权",
  "邮箱或密码错误",
  "当前凭证不能执行该操作",
  "该邮箱已注册",
  "未找到",
  "不支持的文件类型",
  "文件大小须为 1 字节到 32 MiB",
  "分片不合法",
  "描述不合法",
  "标签不合法",
  "地点不合法",
  "拍摄时间不合法",
  "经纬度须成对出现",
  "经纬度超出范围",
  "上传已结束",
  "上传正在完成",
  "上传已完成",
  "文件超过 32 MiB",
  "对象存储不可用",
  "上传未能完成",
  "删除未能完成",
  "修改未能完成",
  "照片不在失败状态",
  "查询为空",
  "查询过长",
  "时间范围不合法",
  "嵌入被拒绝",
  "嵌入暂不可用",
  "服务器错误",
]);

const SEARCH_MESSAGES = new Set<string>([
  "未授权",
  "请求不合法",
  "查询为空",
  "查询过长",
  "标签不合法",
  "拍摄时间不合法",
  "时间范围不合法",
  "嵌入被拒绝",
  "嵌入暂不可用",
  "对象存储不可用",
  "服务器错误",
]);

export function fallbackMessage(status: number): string {
  switch (status) {
    case 400:
      return "请求不合法";
    case 401:
      return "未授权";
    case 403:
      return "当前凭证不能执行该操作";
    case 404:
      return "未找到";
    case 409:
      return "请求冲突";
    case 413:
      return "文件超过 32 MiB";
    case 500:
      return "服务器错误";
    case 502:
      return "嵌入被拒绝";
    case 503:
      return "嵌入暂不可用";
    default:
      return "服务器错误";
  }
}

export function visibleMessage(input: {
  status: number;
  code: string | null;
  serverMessage: string | null;
  audience: "general" | "login" | "search";
}): string {
  if (input.audience === "login" && input.status === 401 && input.code === "invalid_credentials") {
    return "邮箱或密码错误";
  }
  const allowed = input.audience === "search" ? SEARCH_MESSAGES : ALLOWED_MESSAGES;
  if (input.serverMessage !== null && allowed.has(input.serverMessage)) return input.serverMessage;
  return fallbackMessage(input.status);
}

const RETRYABLE = new Set(["storage", "vision_unavailable", "embed_unavailable"]);

const ERROR_CODE_TEXT: Record<string, string> = {
  original_missing: "原图缺失",
  thumbnail_failed: "缩略图失败",
  vision_rejected: "描述被拒绝",
  embed_rejected: "嵌入被拒绝",
  dimension_mismatch: "向量维度不符",
  invalid_embedding: "向量无效",
};

export function statusText(status: string, errorCode: string | null): string {
  if (status === "ready") return "已就绪";
  if (errorCode !== null && RETRYABLE.has(errorCode)) {
    return status === "failed" ? "处理失败，可以重试" : "处理中，将自动重试";
  }
  if (errorCode !== null && ERROR_CODE_TEXT[errorCode] !== undefined) return ERROR_CODE_TEXT[errorCode];
  if (status === "processing" && errorCode === null) return "处理中";
  return "处理未完成";
}

export function formatByteSize(byteSize: number): string {
  if (byteSize >= 1048576) {
    const value = Math.round((byteSize / 1048576) * 10) / 10;
    return `${value.toFixed(1)} MiB`;
  }
  if (byteSize >= 1024) return `${Math.round(byteSize / 1024)} KiB`;
  return `${byteSize} 字节`;
}

export function formatLocalMinute(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day} ${hour}:${minute}`;
}

export function formatScore(score: number): string {
  return String(score);
}

export function photoAlt(description: string | null): string {
  if (description !== null && description.trim() !== "") return description.trim();
  return "照片";
}
