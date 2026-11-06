import type { MetadataPatch } from "./model.js";

export type PhotoStatus = "processing" | "ready" | "failed";
export type PipelineStep = "exif" | "thumbnail" | "vision" | "embed" | "done";
export type JobType = "process_photo" | "reembed";
export type JobStatus = "pending" | "running" | "done" | "failed";
export type PipelineErrorCode =
  | "storage"
  | "original_missing"
  | "thumbnail_failed"
  | "vision_unavailable"
  | "vision_rejected"
  | "embed_unavailable"
  | "embed_rejected"
  | "dimension_mismatch"
  | "invalid_embedding";

export const PIPELINE_LEASE_MS = 600_000;
export const PIPELINE_MAX_ATTEMPTS = 5;
const VISION_DESCRIPTION_MAX = 4000;
const VISION_TAG_MAX = 64;
const VISION_TAG_LIMIT = 32;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RETRYABLE = new Set<PipelineErrorCode>(["storage", "vision_unavailable", "embed_unavailable"]);

export class ThumbnailEncodeError extends Error {
  constructor() {
    super("thumbnail encode failed");
    this.name = "ThumbnailEncodeError";
  }
}

export type ExifReading = {
  takenAt: Date | null;
  latitude: number | null;
  longitude: number | null;
};

export type ExifFill = {
  takenAt?: Date;
  latitude?: number;
  longitude?: number;
};

export function parsePhotoStatus(value: string): PhotoStatus {
  if (value === "processing" || value === "ready" || value === "failed") return value;
  throw new Error("照片状态无效");
}

export function parseJobStep(payload: unknown): PipelineStep {
  if (typeof payload !== "object" || payload === null) throw new Error("任务载荷无效");
  const step = (payload as { step?: unknown }).step;
  if (step === "exif" || step === "thumbnail" || step === "vision" || step === "embed" || step === "done") {
    return step;
  }
  throw new Error("任务载荷无效");
}

export function exifFill(
  photo: { takenAt: Date | null; latitude: number | null; longitude: number | null },
  reading: ExifReading,
): ExifFill {
  const fill: ExifFill = {};
  if (photo.takenAt === null && reading.takenAt instanceof Date && !Number.isNaN(reading.takenAt.getTime())) {
    fill.takenAt = reading.takenAt;
  }
  const latitude = reading.latitude;
  const longitude = reading.longitude;
  if (
    photo.latitude === null &&
    photo.longitude === null &&
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  ) {
    fill.latitude = latitude;
    fill.longitude = longitude;
  }
  return fill;
}

function forbiddenControls(value: string, allowTabAndNewline: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x7f) return true;
    if (code >= 0x20) continue;
    if (allowTabAndNewline && (code === 0x09 || code === 0x0a)) continue;
    return true;
  }
  return false;
}

function trimOuterSpaces(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 0x20) end -= 1;
  return value.slice(start, end);
}

function truncateUtf16(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const tail = value.charCodeAt(end - 1);
  if (tail >= 0xd800 && tail <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

export function normalizeVisionDescription(value: string | null): string | null {
  if (value === null) return null;
  if (forbiddenControls(value, true)) return null;
  const trimmed = trimOuterSpaces(value);
  if (trimmed.length === 0) return null;
  return truncateUtf16(trimmed, VISION_DESCRIPTION_MAX);
}

export function normalizeVisionTags(tags: string[]): string[] {
  const normalized: string[] = [];
  for (const item of tags) {
    if (typeof item !== "string" || forbiddenControls(item, false)) continue;
    const trimmed = item.trim();
    if (trimmed.length < 1 || trimmed.length > VISION_TAG_MAX) continue;
    if (!normalized.includes(trimmed)) normalized.push(trimmed);
    if (normalized.length === VISION_TAG_LIMIT) break;
  }
  return normalized;
}

function descriptionEmpty(value: string | null): boolean {
  return value === null || value.length === 0;
}

export function shouldCallVision(photo: { description: string | null; tags: string[] }): boolean {
  return descriptionEmpty(photo.description) || photo.tags.length === 0;
}

export function visionWrite(
  photo: { description: string | null; tags: string[] },
  normalized: { description: string | null; tags: string[] },
): { description: string | null; tags: string[] } {
  return {
    description: descriptionEmpty(photo.description) ? normalized.description : null,
    tags: photo.tags.length === 0 ? normalized.tags : [],
  };
}

export function embeddingInput(photo: { description: string | null; tags: string[] }): string {
  const lines: string[] = [];
  if (!descriptionEmpty(photo.description) && photo.description !== null) lines.push(photo.description);
  if (photo.tags.length > 0) lines.push(photo.tags.join(", "));
  if (lines.length === 0) return "photo";
  return lines.join("\n");
}

export function checkEmbedding(
  values: number[],
  dimensions: number,
): { ok: true } | { ok: false; code: "dimension_mismatch" | "invalid_embedding" } {
  if (values.length !== dimensions) return { ok: false, code: "dimension_mismatch" };
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return { ok: false, code: "invalid_embedding" };
  }
  return { ok: true };
}

export function failureDisposition(
  code: PipelineErrorCode,
  attempts: number,
): { outcome: "retry"; delayMs: number } | { outcome: "terminal" } {
  if (!RETRYABLE.has(code) || attempts >= PIPELINE_MAX_ATTEMPTS) return { outcome: "terminal" };
  const seconds = Math.min(30 * 2 ** (attempts - 1), 900);
  return { outcome: "retry", delayMs: seconds * 1000 };
}

export function semanticChanged(
  current: { description: string | null; tags: string[] },
  patch: MetadataPatch,
): boolean {
  if ("description" in patch && (patch.description ?? null) !== current.description) return true;
  if ("tags" in patch) {
    const next = patch.tags ?? [];
    if (next.length !== current.tags.length) return true;
    for (let index = 0; index < next.length; index += 1) {
      if (next[index] !== current.tags[index]) return true;
    }
  }
  return false;
}

export function thumbObjectKey(userId: string, photoId: string): string {
  if (!UUID.test(userId) || !UUID.test(photoId)) throw new Error("对象键标识不合法");
  return `owners/${userId}/photos/${photoId}/thumb`;
}
