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
  const adaptersSource = await readAllTypeScriptSources(path.join(apiRoot, "src/adapters/library"));

  for (const marker of ["@aws-sdk/", "aws-sdk", "minio"] as const) {
    assert.equal(domainSource.includes(marker), false, `domain/library 不得出现对象存储 SDK 包名 ${marker}`);
    assert.equal(adaptersSource.includes(marker), false, `adapters/library 不得出现对象存储 SDK 包名 ${marker}`);
  }

  assert.equal(
    /Date\.now|new Date\(\)/.test(domainSource),
    false,
    "domain/library 不得直接读取系统时钟",
  );
  assert.equal(domainSource.includes("domain/identity"), false, "domain/library 不得引用 identity 包");
  assert.equal(/\/dao/.test(adaptersSource), false, "adapters/library 不得 import dao");
  assert.equal(/\/gateways/.test(adaptersSource), false, "adapters/library 不得 import gateways");

  const boundaryScript = await readFile(boundaryScriptPath, "utf8");
  assert.equal(boundaryScript.includes('"aws-sdk"'), true);
  assert.equal(boundaryScript.includes('"minio"'), true);
  assert.equal(boundaryScript.includes("@aws-sdk/"), true);
});
