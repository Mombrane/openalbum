/** 必须与 schema.sql 的 vector(1536) 相同。 */
export const EMBED_VECTOR_DIMENSIONS = 1536;

const VISION_BASE_PLACEHOLDER = "https://YOUR_VISION_API_BASE";
const VISION_KEY_PLACEHOLDER = "YOUR_VISION_API_KEY";
const VISION_MODEL_PLACEHOLDER = "YOUR_VISION_MODEL";
const EMBED_BASE_PLACEHOLDER = "https://YOUR_EMBED_API_BASE";
const EMBED_KEY_PLACEHOLDER = "YOUR_EMBED_API_KEY";
const EMBED_MODEL_PLACEHOLDER = "YOUR_EMBED_MODEL";

export type HttpSide = { kind: "http"; baseUrl: string; apiKey: string; model: string; timeoutMs: number };
export type FakeSide = { kind: "fake"; model: string };
export type PipelineConfig = {
  pollMs: number;
  concurrency: number;
  vision: HttpSide | FakeSide;
  embed: (HttpSide | FakeSide) & { dimensions: 1536 };
};

export type PipelineConfigResult =
  | { ok: true; config: PipelineConfig }
  | { ok: false; exitCode: 1; message: string };

export function loadPipelineConfig(env: NodeJS.ProcessEnv): PipelineConfigResult {
  const pollMs = parseRange(env.PIPELINE_POLL_MS, 2000, 200, 60_000, "PIPELINE_POLL_MS 无效");
  if (typeof pollMs !== "number") return fail(pollMs);
  const concurrency = parseRange(env.PIPELINE_CONCURRENCY, 2, 1, 8, "PIPELINE_CONCURRENCY 无效");
  if (typeof concurrency !== "number") return fail(concurrency);
  const dimensions = parseDimensions(env.EMBED_DIMENSIONS);
  if (typeof dimensions !== "number") return fail(dimensions);
  const vision = parseSide(env, "VISION", {
    basePlaceholder: VISION_BASE_PLACEHOLDER,
    keyPlaceholder: VISION_KEY_PLACEHOLDER,
    modelPlaceholder: VISION_MODEL_PLACEHOLDER,
    timeoutEmpty: 60_000,
    providerInvalid: "VISION_PROVIDER 无效",
    baseInvalid: "VISION_API_BASE_URL 无效",
    modelInvalid: "VISION_MODEL 无效",
    timeoutInvalid: "VISION_TIMEOUT_MS 无效",
    placeholder: "视觉配置仍是占位符",
  });
  if ("ok" in vision) return vision;
  const embed = parseSide(env, "EMBED", {
    basePlaceholder: EMBED_BASE_PLACEHOLDER,
    keyPlaceholder: EMBED_KEY_PLACEHOLDER,
    modelPlaceholder: EMBED_MODEL_PLACEHOLDER,
    timeoutEmpty: 30_000,
    providerInvalid: "EMBED_PROVIDER 无效",
    baseInvalid: "EMBED_API_BASE_URL 无效",
    modelInvalid: "EMBED_MODEL 无效",
    timeoutInvalid: "EMBED_TIMEOUT_MS 无效",
    placeholder: "嵌入配置仍是占位符",
  });
  if ("ok" in embed) return embed;
  return {
    ok: true,
    config: {
      pollMs,
      concurrency,
      vision,
      embed: { ...embed, dimensions: EMBED_VECTOR_DIMENSIONS },
    },
  };
}

function fail(message: string): PipelineConfigResult {
  return { ok: false, exitCode: 1, message };
}

function parseRange(value: string | undefined, empty: number, min: number, max: number, invalid: string): number | string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return empty;
  if (!/^[0-9]+$/.test(trimmed)) return invalid;
  const number = Number(trimmed);
  if (!Number.isInteger(number) || number < min || number > max) return invalid;
  return number;
}

function parseDimensions(value: string | undefined): number | string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "EMBED_DIMENSIONS 缺失";
  if (!/^[0-9]+$/.test(trimmed)) return "EMBED_DIMENSIONS 无效";
  if (Number(trimmed) !== EMBED_VECTOR_DIMENSIONS) return "EMBED_DIMENSIONS 与向量列不一致";
  return EMBED_VECTOR_DIMENSIONS;
}

function parseSide(
  env: NodeJS.ProcessEnv,
  prefix: "VISION" | "EMBED",
  copy: {
    basePlaceholder: string;
    keyPlaceholder: string;
    modelPlaceholder: string;
    timeoutEmpty: number;
    providerInvalid: string;
    baseInvalid: string;
    modelInvalid: string;
    timeoutInvalid: string;
    placeholder: string;
  },
): HttpSide | FakeSide | PipelineConfigResult {
  const provider = env[`${prefix}_PROVIDER`]?.trim() ?? "";
  if (provider !== "" && provider !== "http") return fail(copy.providerInvalid);
  const baseUrl = stripTrailingSlashes(env[`${prefix}_API_BASE_URL`]?.trim() ?? "");
  if (baseUrl !== "" && !validHttpUrl(baseUrl)) return fail(copy.baseInvalid);
  const apiKey = env[`${prefix}_API_KEY`]?.trim() ?? "";
  const model = env[`${prefix}_MODEL`]?.trim() ?? "";
  if (model.length > 200) return fail(copy.modelInvalid);
  const timeout = parseRange(env[`${prefix}_TIMEOUT_MS`], copy.timeoutEmpty, 1000, 120_000, copy.timeoutInvalid);
  if (typeof timeout !== "number") return fail(timeout);
  const placeholder = baseUrl === "" || baseUrl === copy.basePlaceholder || apiKey === "" || apiKey === copy.keyPlaceholder || model === "" || model === copy.modelPlaceholder;
  if (placeholder) {
    if ((env.NODE_ENV?.trim() ?? "") === "production") return fail(copy.placeholder);
    return { kind: "fake", model: model === "" ? "fake" : model };
  }
  return { kind: "http", baseUrl, apiKey, model, timeoutMs: timeout };
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
