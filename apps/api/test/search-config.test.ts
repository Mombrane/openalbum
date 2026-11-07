import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadApiEmbedConfig, loadPipelineConfig } from "../src/gateways/embed/index.js";

function embedEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PIPELINE_POLL_MS: "1",
    PIPELINE_CONCURRENCY: "9",
    VISION_PROVIDER: "nope",
    EMBED_PROVIDER: "http",
    EMBED_API_BASE_URL: "https://embed.example.com",
    EMBED_API_KEY: "real-embed",
    EMBED_MODEL: "embed-model",
    EMBED_TIMEOUT_MS: "",
    EMBED_DIMENSIONS: "1536",
    ...overrides,
  };
}

function workerEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PIPELINE_POLL_MS: "",
    PIPELINE_CONCURRENCY: "",
    VISION_PROVIDER: "http",
    VISION_API_BASE_URL: "https://vision.example.com",
    VISION_API_KEY: "real-vision",
    VISION_MODEL: "vision-model",
    VISION_TIMEOUT_MS: "",
    EMBED_PROVIDER: "http",
    EMBED_API_BASE_URL: "https://embed.example.com",
    EMBED_API_KEY: "YOUR_EMBED_API_KEY",
    EMBED_MODEL: "embed-model",
    EMBED_TIMEOUT_MS: "",
    EMBED_DIMENSIONS: "1536",
    ...overrides,
  };
}

test("API 加载忽略视觉与轮询，维度错误沿用 Phase 3 文案", () => {
  const ok = loadApiEmbedConfig(embedEnv());
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.config.kind, "http");
    if (ok.config.kind === "http") {
      assert.equal(ok.config.model, "embed-model");
      assert.equal(ok.config.info, "嵌入网关使用 HTTP");
      assert.equal(ok.config.info.includes("embed.example.com"), false);
      assert.equal(ok.config.info.includes("embed-model"), false);
    }
  }
  assert.equal(loadApiEmbedConfig(embedEnv({ EMBED_DIMENSIONS: "" })).ok, false);
  const missing = loadApiEmbedConfig(embedEnv({ EMBED_DIMENSIONS: "" }));
  if (!missing.ok) assert.equal(missing.message, "EMBED_DIMENSIONS 缺失");
  const invalid = loadApiEmbedConfig(embedEnv({ EMBED_DIMENSIONS: "abc" }));
  if (!invalid.ok) assert.equal(invalid.message, "EMBED_DIMENSIONS 无效");
  const other = loadApiEmbedConfig(embedEnv({ EMBED_DIMENSIONS: "768" }));
  if (!other.ok) assert.equal(other.message, "EMBED_DIMENSIONS 与向量列不一致");
  const userinfo = loadApiEmbedConfig(embedEnv({ EMBED_API_BASE_URL: "https://user:pass@embed.example.com" }));
  assert.equal(userinfo.ok, false);
  if (!userinfo.ok) {
    assert.equal(userinfo.message, "EMBED_API_BASE_URL 无效");
    assert.equal(userinfo.message.includes("user"), false);
    assert.equal(userinfo.message.includes("pass"), false);
  }
});

test("非 production 占位得到假网关且不发请求", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls.push("fetch");
    throw new Error("不应该请求嵌入");
  };
  try {
    const loaded = loadApiEmbedConfig(embedEnv({ EMBED_API_KEY: "YOUR_EMBED_API_KEY", EMBED_MODEL: "   " }));
    assert.equal(loaded.ok, true);
    if (!loaded.ok || loaded.config.kind !== "fake") return;
    assert.equal(loaded.config.model, "fake");
    assert.equal(loaded.config.info, "嵌入网关使用假实现");
    const embedded = await loaded.config.gateway.embed({ model: loaded.config.model, text: "海边" });
    assert.equal(embedded.ok, true);
    if (embedded.ok) assert.equal(embedded.values.length, 1536);
    assert.deepEqual(calls, []);
    assert.equal(JSON.stringify(loaded.config.info).includes("YOUR_EMBED_API_KEY"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("production 占位禁用语义且不退出，worker 配置仍然退出", async () => {
  const api = loadApiEmbedConfig(embedEnv({ NODE_ENV: "production", EMBED_API_KEY: "YOUR_EMBED_API_KEY" }));
  assert.equal(api.ok, true);
  if (!api.ok) return;
  assert.equal(api.config.kind, "disabled");
  if (api.config.kind === "disabled") assert.equal(api.config.message, "嵌入配置仍是占位符，语义检索不可用");
  assert.equal("gateway" in api.config, false);
  const worker = loadPipelineConfig(workerEnv());
  assert.equal(worker.ok, false);
  if (!worker.ok) {
    assert.equal(worker.message, "嵌入配置仍是占位符");
    assert.equal(worker.exitCode, 1);
    assert.equal(worker.message.includes("语义检索不可用"), false);
  }
  const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  assert.equal(source.includes("loadPipelineConfig"), true);
  assert.equal(source.includes("语义检索不可用"), false);
});
