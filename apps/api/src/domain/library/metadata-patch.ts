import type { MetadataPatch } from "./model.js";

const ALLOWED = new Set(["description", "tags", "takenAt", "locationText", "latitude", "longitude"]);
const TAKEN_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

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

function textField(value: unknown, max: number): string | null | "invalid" {
  if (value === null) return null;
  if (typeof value !== "string") return "invalid";
  if (forbiddenControls(value, true)) return "invalid";
  const trimmed = trimOuterSpaces(value);
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) return "invalid";
  return trimmed;
}

export function normalizeMetadataPatch(body: Record<string, unknown>): { ok: true; patch: MetadataPatch } | { ok: false; message: string } {
  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) return { ok: false, message: "请求不合法" };
  }
  const patch: MetadataPatch = {};
  if ("description" in body) {
    const description = textField(body.description, 4000);
    if (description === "invalid") return { ok: false, message: "描述不合法" };
    patch.description = description;
  }
  if ("tags" in body) {
    if (!Array.isArray(body.tags) || body.tags.length > 32) return { ok: false, message: "标签不合法" };
    const tags: string[] = [];
    for (const item of body.tags) {
      if (typeof item !== "string" || forbiddenControls(item, false)) return { ok: false, message: "标签不合法" };
      const trimmed = item.trim();
      if (trimmed.length < 1 || trimmed.length > 64) return { ok: false, message: "标签不合法" };
      if (!tags.includes(trimmed)) tags.push(trimmed);
    }
    patch.tags = tags;
  }
  if ("takenAt" in body) {
    if (body.takenAt === null) {
      patch.takenAt = null;
    } else if (typeof body.takenAt !== "string" || !TAKEN_AT.test(body.takenAt)) {
      return { ok: false, message: "拍摄时间不合法" };
    } else {
      const takenAt = new Date(body.takenAt);
      if (Number.isNaN(takenAt.getTime())) return { ok: false, message: "拍摄时间不合法" };
      patch.takenAt = takenAt;
    }
  }
  if ("locationText" in body) {
    const locationText = textField(body.locationText, 500);
    if (locationText === "invalid") return { ok: false, message: "地点不合法" };
    patch.locationText = locationText;
  }
  const hasLatitude = "latitude" in body;
  const hasLongitude = "longitude" in body;
  if (hasLatitude !== hasLongitude) return { ok: false, message: "经纬度须成对出现" };
  if (hasLatitude && hasLongitude) {
    const latitude = body.latitude;
    const longitude = body.longitude;
    if (latitude === null && longitude === null) {
      patch.latitude = null;
      patch.longitude = null;
    } else if (typeof latitude !== "number" || typeof longitude !== "number") {
      return { ok: false, message: "经纬度须成对出现" };
    } else if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return { ok: false, message: "请求不合法" };
    } else if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return { ok: false, message: "经纬度超出范围" };
    } else {
      patch.latitude = latitude;
      patch.longitude = longitude;
    }
  }
  return { ok: true, patch };
}
