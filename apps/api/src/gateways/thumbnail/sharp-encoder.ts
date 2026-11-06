import sharp from "sharp";
import { ThumbnailEncodeError } from "../../domain/library/pipeline.js";
import type { ThumbnailEncoder } from "../../domain/library/ports.js";

export function createSharpThumbnailEncoder(): ThumbnailEncoder {
  return {
    async encode(bytes) {
      try {
        const encoded = await sharp(bytes, { failOn: "error" })
          .rotate()
          .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        return { bytes: encoded, contentType: "image/jpeg" };
      } catch (error) {
        if (error instanceof ThumbnailEncodeError) throw error;
        throw new ThumbnailEncodeError();
      }
    },
  };
}
