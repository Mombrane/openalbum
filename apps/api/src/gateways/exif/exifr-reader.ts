import exifr from "exifr";
import type { ExifReader } from "../../domain/library/ports.js";
import { parseExifTimestamp, parseGpsPair } from "./parse.js";

export function createExifrReader(): ExifReader {
  return {
    async read(bytes) {
      try {
        const tags = (await exifr.parse(bytes, { reviveValues: false })) as Record<string, unknown> | undefined;
        const gps = (await exifr.gps(bytes)) as { latitude?: unknown; longitude?: unknown } | null;
        const takenAt = parseExifTimestamp(
          tags?.DateTimeOriginal ?? tags?.CreateDate,
          tags?.OffsetTimeOriginal ?? tags?.OffsetTime ?? tags?.OffsetTimeDigitized,
        );
        const pair = parseGpsPair(gps?.latitude, gps?.longitude);
        return { takenAt, latitude: pair.latitude, longitude: pair.longitude };
      } catch {
        return { takenAt: null, latitude: null, longitude: null };
      }
    },
  };
}
