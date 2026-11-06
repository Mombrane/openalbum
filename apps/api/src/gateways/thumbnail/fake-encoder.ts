import { ThumbnailEncodeError } from "../../domain/library/pipeline.js";
import type { ThumbnailEncoder } from "../../domain/library/ports.js";

export function createFakeThumbnailEncoder(options?: { fail?: boolean; bytes?: Buffer }): ThumbnailEncoder & { calls: number } {
  let calls = 0;
  const body = options?.bytes ?? Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  return {
    get calls() {
      return calls;
    },
    async encode() {
      calls += 1;
      if (options?.fail) throw new ThumbnailEncodeError();
      return { bytes: Buffer.from(body), contentType: "image/jpeg" };
    },
  };
}
