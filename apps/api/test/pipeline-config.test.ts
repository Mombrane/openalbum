import assert from "node:assert/strict";
import test from "node:test";
import { EMBED_VECTOR_DIMENSIONS, loadPipelineConfig } from "../src/gateways/embed/config.js";
import { createFakeEmbedGateway } from "../src/gateways/embed/fake-embed.js";
import { createHttpEmbedGateway } from "../src/gateways/embed/http-embed.js";
import { createHttpVisionGateway } from "../src/gateways/vision/http-vision.js";
import { productionStoragePlaceholderMessage } from "../src/gateways/storage/config.js";

function pipelineEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PIPELINE_POLL_MS: "",
    PIPELINE_CONCURRENCY: "",
    VISION_PROVIDER: "http",
    VISION_API_BASE_URL: "https://vision.example.com",
    VISION_API_KEY: "real-vision",
    VISION_MODEL: "vision-model",
    VISION_TIMEOUT_MS: "",
    EMBED_PROVIDER: "http",
    EMBED_API_BASE_URL: "https://embed.example.com",
    EMBED_API_KEY: "real-embed",
    EMBED_MODEL: "embed-model",
    EMBED_TIMEOUT_MS: "",
    EMBED_DIMENSIONS: "1536",
    ...overrides,
  };
}

test("1536 与空白轮询通过，错误维度和过短轮询拒绝", () => {
  assert.equal(EMBED_VECTOR_DIMENSIONS, 1536);
  const ok = loadPipelineConfig(pipelineEnv());
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.config.pollMs, 2000);
  assert.equal(ok.config.concurrency, 2);
  assert.equal(ok.config.vision.kind, "http");
  assert.equal(ok.config.embed.dimensions, 1536);
  if (ok.config.vision.kind === "http") assert.equal(ok.config.vision.timeoutMs, 60_000);
  if (ok.config.embed.kind === "http") assert.equal(ok.config.embed.timeoutMs, 30_000);
  assert.equal(loadPipelineConfig(pipelineEnv({ EMBED_DIMENSIONS: "" })).ok && false, false);
  assert.equal((loadPipelineConfig(pipelineEnv({ EMBED_DIMENSIONS: "" })) as { message?: string }).message, "EMBED_DIMENSIONS 缺失");
  assert.equal((loadPipelineConfig(pipelineEnv({ EMBED_DIMENSIONS: "abc" })) as { message?: string }).message, "EMBED_DIMENSIONS 无效");
  assert.equal((loadPipelineConfig(pipelineEnv({ EMBED_DIMENSIONS: "768" })) as { message?: string }).message, "EMBED_DIMENSIONS 与向量列不一致");
  assert.equal((loadPipelineConfig(pipelineEnv({ PIPELINE_POLL_MS: "50" })) as { message?: string }).message, "PIPELINE_POLL_MS 无效");
});

test("非 production 的视觉占位符用假网关，production 退出且文案不含密钥", () => {
  const fake = loadPipelineConfig(pipelineEnv({ VISION_API_KEY: "YOUR_VISION_API_KEY" }));
  assert.equal(fake.ok, true);
  if (fake.ok) assert.equal(fake.config.vision.kind, "fake");
  const prod = loadPipelineConfig(pipelineEnv({ NODE_ENV: "production", VISION_API_KEY: "YOUR_VISION_API_KEY" }));
  assert.equal(prod.ok, false);
  if (!prod.ok) {
    assert.equal(prod.message, "视觉配置仍是占位符");
    assert.equal(prod.exitCode, 1);
    assert.equal(prod.message.includes("YOUR_VISION_API_KEY"), false);
  }
  const userinfo = loadPipelineConfig(pipelineEnv({ VISION_API_BASE_URL: "https://user:pass@vision.example.com" }));
  assert.equal(userinfo.ok, false);
  if (!userinfo.ok) {
    assert.equal(userinfo.message, "VISION_API_BASE_URL 无效");
    assert.equal(userinfo.message.includes("user"), false);
    assert.equal(userinfo.message.includes("pass"), false);
  }
});

test("生产环境的对象存储占位符文案不含密钥", () => {
  assert.equal(
    productionStoragePlaceholderMessage({ NODE_ENV: "production", S3_BUCKET: "album", S3_ACCESS_KEY_ID: "YOUR_ACCESS_KEY", S3_SECRET_ACCESS_KEY: "secret" }),
    "对象存储配置仍是占位符",
  );
  const message = productionStoragePlaceholderMessage({ NODE_ENV: "production", S3_ACCESS_KEY_ID: "YOUR_ACCESS_KEY" });
  assert.equal(message?.includes("YOUR_ACCESS_KEY"), false);
  assert.equal(productionStoragePlaceholderMessage({ NODE_ENV: "test", S3_ACCESS_KEY_ID: "YOUR_ACCESS_KEY" }), null);
});

test("视觉与嵌入 HTTP 按状态码分类，假嵌入按文本稳定", async () => {
  const calls: Array<{ url: string; redirect: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), redirect: String(init?.redirect) });
    const url = String(input);
    if (url.endsWith("/missing")) return new Response("{}", { status: 200 });
    if (url.includes("/v1/describe")) {
      const status = calls.filter((item) => item.url.includes("/v1/describe")).length;
      if (status === 1) return new Response("{}", { status: 429 });
      if (status === 2) return new Response("{}", { status: 400 });
      if (status === 3) return new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } });
      if (status === 4) return new Response(JSON.stringify({ tags: [1] }), { status: 200 });
      return new Response(JSON.stringify({ description: "海边", tags: ["海"] }), { status: 200 });
    }
    return new Response(JSON.stringify({ embedding: [0.25, -0.5] }), { status: 200 });
  };
  const vision = createHttpVisionGateway(
    { baseUrl: "https://vision.example.com", apiKey: "real-vision", model: "vision-model", timeoutMs: 1000 },
    fetchImpl,
  );
  assert.deepEqual(await vision.describe({ model: "vision-model", contentType: "image/jpeg", bytes: Buffer.from("a") }), { ok: false, kind: "vision_unavailable" });
  assert.deepEqual(await vision.describe({ model: "vision-model", contentType: "image/jpeg", bytes: Buffer.from("a") }), { ok: false, kind: "vision_rejected" });
  assert.deepEqual(await vision.describe({ model: "vision-model", contentType: "image/jpeg", bytes: Buffer.from("a") }), { ok: false, kind: "vision_rejected" });
  assert.deepEqual(await vision.describe({ model: "vision-model", contentType: "image/jpeg", bytes: Buffer.from("a") }), { ok: false, kind: "vision_rejected" });
  assert.deepEqual(await vision.describe({ model: "vision-model", contentType: "image/jpeg", bytes: Buffer.from("a") }), { ok: true, description: "海边", tags: ["海"] });
  assert.equal(calls[0]?.redirect, "manual");
  assert.equal(calls[0]?.url.endsWith("/v1/describe"), true);
  const embed = createHttpEmbedGateway(
    { baseUrl: "https://embed.example.com", apiKey: "real-embed", model: "embed-model", timeoutMs: 1000 },
    fetchImpl,
  );
  assert.deepEqual(await embed.embed({ model: "embed-model", text: "海边" }), { ok: true, values: [0.25, -0.5] });
  const missing = createHttpEmbedGateway(
    { baseUrl: "https://embed.example.com/missing", apiKey: "real-embed", model: "embed-model", timeoutMs: 1000 },
    async () => new Response(JSON.stringify({}), { status: 200 }),
  );
  assert.deepEqual(await missing.embed({ model: "embed-model", text: "海边" }), { ok: false, kind: "embed_rejected" });
  const fake = createFakeEmbedGateway();
  const left = await fake.embed({ model: "embed-model", text: "海边" });
  const same = await fake.embed({ model: "embed-model", text: "海边" });
  const other = await fake.embed({ model: "embed-model", text: "湖边" });
  assert.equal(left.ok && same.ok && other.ok, true);
  if (left.ok && same.ok && other.ok) {
    assert.equal(left.values.length, 1536);
    assert.deepEqual(left.values, same.values);
    assert.notDeepEqual(left.values, other.values);
  }
  const nan = await createFakeEmbedGateway({ nan: true }).embed({ model: "embed-model", text: "海边" });
  assert.equal(nan.ok, true);
  if (nan.ok) {
    assert.equal(nan.values.length, 1536);
    assert.equal(Number.isNaN(nan.values[0]), true);
  }
});
