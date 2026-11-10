import type { Photo } from "../api";

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

export function validateDescription(
  raw: string,
): { ok: true; description: string | null } | { ok: false; message: "描述不合法" } {
  if (forbiddenControls(raw, true)) {
    return { ok: false, message: "描述不合法" };
  }
  const trimmed = trimOuterSpaces(raw);
  if (trimmed.length === 0) return { ok: true, description: null };
  if (trimmed.length > 4000) return { ok: false, message: "描述不合法" };
  return { ok: true, description: trimmed };
}

export function validateLocation(
  raw: string,
): { ok: true; locationText: string | null } | { ok: false; message: "地点不合法" } {
  if (forbiddenControls(raw, true)) {
    return { ok: false, message: "地点不合法" };
  }
  const trimmed = trimOuterSpaces(raw);
  if (trimmed.length === 0) return { ok: true, locationText: null };
  if (trimmed.length > 500) return { ok: false, message: "地点不合法" };
  return { ok: true, locationText: trimmed };
}

export function validateTags(
  raw: string[],
): { ok: true; tags: string[] } | { ok: false; message: "标签不合法" } {
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || forbiddenControls(item, false)) {
      return { ok: false, message: "标签不合法" };
    }
    const trimmed = item.trim();
    if (trimmed.length < 1) continue;
    if (trimmed.length > 64) return { ok: false, message: "标签不合法" };
    if (!tags.includes(trimmed)) tags.push(trimmed);
  }
  if (tags.length > 32) return { ok: false, message: "标签不合法" };
  return { ok: true, tags };
}

export function validateCoordinatePair(
  latitudeRaw: string,
  longitudeRaw: string,
):
  | { ok: true; latitude: number | null; longitude: number | null }
  | { ok: false; message: "经纬度须成对出现" | "经纬度超出范围" } {
  const latEmpty = latitudeRaw.trim() === "";
  const lonEmpty = longitudeRaw.trim() === "";
  if (latEmpty && lonEmpty) {
    return { ok: true, latitude: null, longitude: null };
  }
  if (latEmpty !== lonEmpty) {
    return { ok: false, message: "经纬度须成对出现" };
  }
  const latitude = Number(latitudeRaw);
  const longitude = Number(longitudeRaw);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, message: "经纬度超出范围" };
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { ok: false, message: "经纬度超出范围" };
  }
  return { ok: true, latitude, longitude };
}

export function takenAtFromLocalInput(
  value: string,
): { ok: true; takenAt: string | null } | { ok: false; message: "拍摄时间不合法" } {
  if (value === "") return { ok: true, takenAt: null };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, message: "拍摄时间不合法" };
  }
  return { ok: true, takenAt: date.toISOString() };
}

export type PhotoFormInput = {
  description: string;
  tags: string[];
  takenAtLocal: string;
  locationText: string;
  latitude: string;
  longitude: string;
};

export type PatchBody = {
  description: string | null;
  tags: string[];
  takenAt: string | null;
  locationText: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type PhotoMetadataBaseline = Pick<
  Photo,
  "description" | "tags" | "takenAt" | "locationText" | "latitude" | "longitude"
>;

function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function descriptionEqual(a: string | null, b: string | null): boolean {
  return a === b;
}

export function buildPatch(
  input: PhotoFormInput,
  original: PhotoMetadataBaseline,
):
  | {
      ok: true;
      body: PatchBody;
      descriptionChanged: boolean;
      tagsChanged: boolean;
    }
  | { ok: false; message: string } {
  const description = validateDescription(input.description);
  if (!description.ok) return description;
  const tags = validateTags(input.tags);
  if (!tags.ok) return tags;
  const takenAt = takenAtFromLocalInput(input.takenAtLocal);
  if (!takenAt.ok) return takenAt;
  const locationText = validateLocation(input.locationText);
  if (!locationText.ok) return locationText;
  const coords = validateCoordinatePair(input.latitude, input.longitude);
  if (!coords.ok) return coords;

  const body: PatchBody = {
    description: description.description,
    tags: tags.tags,
    takenAt: takenAt.takenAt,
    locationText: locationText.locationText,
    latitude: coords.latitude,
    longitude: coords.longitude,
  };

  const descriptionChanged = !descriptionEqual(body.description, original.description);
  const tagsChanged = !tagsEqual(body.tags, original.tags);

  return { ok: true, body, descriptionChanged, tagsChanged };
}

export function saveNotice(
  status: string,
  descriptionChanged: boolean,
  tagsChanged: boolean,
): string {
  if (status === "ready" && (descriptionChanged || tagsChanged)) {
    return "已保存。描述或标签变更后会重新嵌入，状态保持已就绪。";
  }
  return "已保存";
}

export function takenAtToLocalInput(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
