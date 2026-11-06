import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const apiRoot = path.join(repoRoot, "apps/api");
const boundaryScriptPath = path.join(repoRoot, "scripts/check-layer-boundaries.mjs");

async function readAllTypeScriptSources(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  let combined = "";
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      combined += await readAllTypeScriptSources(full);
    } else if (entry.name.endsWith(".ts")) {
      combined += await readFile(full, "utf8");
    }
  }
  return combined;
}

test("个人库 domain 与 adapters 源码边界", async () => {
  const domainSource = await readAllTypeScriptSources(path.join(apiRoot, "src/domain/library"));
  const libraryAdapters = await readAllTypeScriptSources(path.join(apiRoot, "src/adapters/library"));
  const pipelineAdapters = await readAllTypeScriptSources(path.join(apiRoot, "src/adapters/pipeline"));
  const markers = ["@aws-sdk/", "aws-sdk", "minio", "sharp", "exifr", "undici"] as const;

  for (const marker of markers) {
    assert.equal(domainSource.includes(marker), false, `domain/library 不得出现 ${marker}`);
    assert.equal(libraryAdapters.includes(marker), false, `adapters/library 不得出现 ${marker}`);
    assert.equal(pipelineAdapters.includes(marker), false, `adapters/pipeline 不得出现 ${marker}`);
  }

  assert.equal(/Date\.now|new Date\(\)/.test(domainSource), false, "domain/library 不得直接读取系统时钟");
  assert.equal(domainSource.includes("domain/identity"), false, "domain/library 不得引用 identity 包");
  for (const source of [libraryAdapters, pipelineAdapters]) {
    assert.equal(/\/dao/.test(source), false, "adapters 不得 import dao");
    assert.equal(/\/gateways/.test(source), false, "adapters 不得 import gateways");
  }

  const boundaryScript = await readFile(boundaryScriptPath, "utf8");
  assert.equal(boundaryScript.includes('"aws-sdk"'), true);
  assert.equal(boundaryScript.includes('"minio"'), true);
  assert.equal(boundaryScript.includes("@aws-sdk/"), true);
  assert.equal(boundaryScript.includes('"sharp"'), true);
  assert.equal(boundaryScript.includes('"exifr"'), true);
});

test("检索领域不引用照片库，适配层不跨到 DAO 或网关", async () => {
  const searchDomain = await readAllTypeScriptSources(path.join(apiRoot, "src/domain/search"));
  const searchAdapters = await readAllTypeScriptSources(path.join(apiRoot, "src/adapters/search"));
  const libraryAdapters = await readAllTypeScriptSources(path.join(apiRoot, "src/adapters/library"));
  for (const marker of ["domain/library", "domain/identity", "domain/album", "/dao", "/gateways", "fastify", "undici"]) {
    assert.equal(searchDomain.includes(marker), false, marker);
  }
  assert.equal(searchDomain.includes('from "pg"'), false);
  assert.equal(searchDomain.includes("node:http"), false);
  assert.equal(searchDomain.includes("node:https"), false);
  assert.equal(/\/dao/.test(searchAdapters), false);
  assert.equal(/\/gateways/.test(searchAdapters), false);
  assert.equal(searchAdapters.includes("embeddingInput"), false);
  assert.equal(libraryAdapters.includes("adapters/search"), false);
  const logger = await readFile(path.join(apiRoot, "src/interfaces/http/auth-logger.ts"), "utf8");
  for (const path of ["req.body", "embedding", "originalUrl", "thumbUrl"]) {
    assert.equal(logger.includes(`"${path}"`), true, path);
  }
  assert.equal(logger.includes("photos[*].score"), false);
});
