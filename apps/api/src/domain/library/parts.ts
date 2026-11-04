import { MAX_COMPLETE_PARTS, MAX_PHOTO_BYTES, MIN_NON_FINAL_PART_BYTES } from "./constants.js";
import type { PartSize } from "./model.js";

export function validatePartsForComplete(parts: PartSize[], declaredByteSize: number): "ok" | "invalid" {
  if (parts.length < 1 || parts.length > MAX_COMPLETE_PARTS) return "invalid";
  const sorted = [...parts].sort((left, right) => left.partNumber - right.partNumber);
  let sum = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const part = sorted[index];
    if (!part || part.partNumber !== index + 1) return "invalid";
    if (part.byteSize < 1 || part.byteSize > MAX_PHOTO_BYTES) return "invalid";
    const last = index === sorted.length - 1;
    if (!last && part.byteSize < MIN_NON_FINAL_PART_BYTES) return "invalid";
    sum += part.byteSize;
  }
  if (sum !== declaredByteSize || sum > MAX_PHOTO_BYTES) return "invalid";
  return "ok";
}
