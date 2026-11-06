import { parseDurationSeconds } from "../auth/config.js";

export type StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  signedUrlTtlSeconds: number;
};

const MAX_TTL_SECONDS = 604_800;

export function loadStorageConfig(env: NodeJS.ProcessEnv): StorageConfig {
  return {
    endpoint: parseEndpoint(env.S3_ENDPOINT),
    region: requiredText(env.S3_REGION, "S3_REGION"),
    bucket: requiredText(env.S3_BUCKET, "S3_BUCKET"),
    accessKeyId: requiredText(env.S3_ACCESS_KEY_ID, "S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredText(env.S3_SECRET_ACCESS_KEY, "S3_SECRET_ACCESS_KEY"),
    forcePathStyle: parseForcePathStyle(env.S3_FORCE_PATH_STYLE),
    signedUrlTtlSeconds: parseTtl(env.S3_SIGNED_URL_TTL),
  };
}

function requiredText(value: string | undefined, name: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`${name} 缺失`);
  return trimmed;
}

function parseEndpoint(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error("S3_ENDPOINT 缺失");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("S3_ENDPOINT 无效");
  }
  if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("S3_ENDPOINT 无效");
  }
  return trimmed;
}

function parseForcePathStyle(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === "false") return false;
  if (trimmed === "true") return true;
  throw new Error("S3_FORCE_PATH_STYLE 无效");
}

function parseTtl(value: string | undefined): number {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return 900;
  let seconds: number;
  try {
    seconds = parseDurationSeconds(trimmed);
  } catch {
    throw new Error("S3_SIGNED_URL_TTL 无效");
  }
  if (seconds > MAX_TTL_SECONDS) throw new Error("S3_SIGNED_URL_TTL 超过 7 天");
  return seconds;
}

export function productionStoragePlaceholderMessage(env: NodeJS.ProcessEnv): string | null {
  if ((env.NODE_ENV?.trim() ?? "") !== "production") return null;
  const bucket = env.S3_BUCKET?.trim() ?? "";
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim() ?? "";
  if (bucket === "YOUR_BUCKET_NAME" || accessKeyId === "YOUR_ACCESS_KEY" || secretAccessKey === "YOUR_SECRET_KEY") {
    return "对象存储配置仍是占位符";
  }
  return null;
}
