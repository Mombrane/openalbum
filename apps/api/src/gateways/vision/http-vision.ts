import type { VisionGateway } from "../../domain/library/ports.js";

export type VisionHttpConfig = { baseUrl: string; apiKey: string; model: string; timeoutMs: number };

export function createHttpVisionGateway(config: VisionHttpConfig, fetchImpl: typeof fetch = fetch): VisionGateway {
  return {
    async describe(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(`${config.baseUrl}/v1/describe`, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            image: { contentType: input.contentType, dataBase64: input.bytes.toString("base64") },
          }),
        });
        return await classifyVision(response);
      } catch {
        return { ok: false, kind: "vision_unavailable" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function classifyVision(response: Response): Promise<Awaited<ReturnType<VisionGateway["describe"]>>> {
  if (response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504) {
    return { ok: false, kind: "vision_unavailable" };
  }
  if (response.status !== 200) return { ok: false, kind: "vision_rejected" };
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, kind: "vision_rejected" };
  }
  if (typeof json !== "object" || json === null) return { ok: false, kind: "vision_rejected" };
  const record = json as { description?: unknown; tags?: unknown };
  const description = record.description === undefined ? null : record.description;
  const tags = record.tags === undefined ? [] : record.tags;
  if (description !== null && typeof description !== "string") return { ok: false, kind: "vision_rejected" };
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) return { ok: false, kind: "vision_rejected" };
  return { ok: true, description, tags };
}
