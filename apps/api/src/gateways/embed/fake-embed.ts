import type { EmbedGateway } from "../../domain/library/ports.js";
import { deterministicEmbedding } from "./deterministic.js";

export type FakeEmbedOptions = {
  dimensions?: number;
  failuresBeforeSuccess?: number;
  reject?: boolean;
  nan?: boolean;
  values?: number[];
};

export function createFakeEmbedGateway(options: FakeEmbedOptions = {}): EmbedGateway & { calls: number } {
  let calls = 0;
  const dimensions = options.dimensions ?? 1536;
  const failures = options.failuresBeforeSuccess ?? 0;
  return {
    get calls() {
      return calls;
    },
    async embed(input) {
      calls += 1;
      if (calls <= failures) return { ok: false, kind: "embed_unavailable" };
      if (options.reject) return { ok: false, kind: "embed_rejected" };
      if (options.values) return { ok: true, values: options.values.slice() };
      const values = deterministicEmbedding(input.text, dimensions);
      if (options.nan) values[0] = Number.NaN;
      return { ok: true, values };
    },
  };
}
