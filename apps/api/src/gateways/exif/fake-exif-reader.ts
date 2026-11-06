import type { ExifReading } from "../../domain/library/pipeline.js";
import type { ExifReader } from "../../domain/library/ports.js";

export function createFakeExifReader(
  reading: ExifReading = { takenAt: null, latitude: null, longitude: null },
): ExifReader & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async read() {
      calls += 1;
      return {
        takenAt: reading.takenAt ? new Date(reading.takenAt.getTime()) : null,
        latitude: reading.latitude,
        longitude: reading.longitude,
      };
    },
  };
}
