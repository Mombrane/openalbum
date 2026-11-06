import type { VisionGateway } from "../../domain/library/ports.js";

export type FakeVisionOptions = {
  description?: string | null;
  tags?: string[];
  failuresBeforeSuccess?: number;
  reject?: boolean;
  throwOnCall?: Error;
};

export function createFakeVisionGateway(options: FakeVisionOptions = {}): VisionGateway & { calls: number } {
  let calls = 0;
  const failures = options.failuresBeforeSuccess ?? 0;
  return {
    get calls() {
      return calls;
    },
    async describe() {
      calls += 1;
      if (options.throwOnCall && calls <= Math.max(failures, 1)) throw options.throwOnCall;
      if (calls <= failures) return { ok: false, kind: "vision_unavailable" };
      if (options.reject) return { ok: false, kind: "vision_rejected" };
      return { ok: true, description: options.description ?? "海边", tags: options.tags ?? ["海"] };
    },
  };
}
