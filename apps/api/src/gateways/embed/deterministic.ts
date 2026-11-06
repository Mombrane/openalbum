import { createHash } from "node:crypto";

export function deterministicEmbedding(text: string, dimensions: number): number[] {
  const values: number[] = [];
  let counter = 0;
  while (values.length < dimensions) {
    const digest = createHash("sha256").update(`${text}\0${counter}`).digest();
    for (let index = 0; index + 3 < digest.length && values.length < dimensions; index += 4) {
      const unit = digest.readUInt32BE(index) / 0xffffffff;
      values.push(Math.round((unit * 2 - 1) * 1_000_000) / 1_000_000);
    }
    counter += 1;
  }
  return values;
}
