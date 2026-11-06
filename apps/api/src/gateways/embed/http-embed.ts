import type { EmbedGateway } from "../../domain/library/ports.js";

export type EmbedHttpConfig = { baseUrl: string; apiKey: string; model: string; timeoutMs: number };

export function createHttpEmbedGateway(config: EmbedHttpConfig, fetchImpl: typeof fetch = fetch): EmbedGateway {
  return {
    async embed(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(`${config.baseUrl}/v1/embeddings`, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ model: config.model, input: input.text }),
        });
        return await classifyEmbed(response);
      } catch {
        return { ok: false, kind: "embed_unavailable" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function classifyEmbed(response: Response): Promise<Awaited<ReturnType<EmbedGateway["embed"]>>> {
  if (response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504) {
    return { ok: false, kind: "embed_unavailable" };
  }
  if (response.status !== 200) return { ok: false, kind: "embed_rejected" };
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, kind: "embed_rejected" };
  }
  if (typeof json !== "object" || json === null) return { ok: false, kind: "embed_rejected" };
  const embedding = (json as { embedding?: unknown }).embedding;
  if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) {
    return { ok: false, kind: "embed_rejected" };
  }
  return { ok: true, values: embedding };
}
