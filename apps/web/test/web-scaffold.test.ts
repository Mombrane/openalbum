import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Vite 只做同源代理，不增加跨源变量", async () => {
  const source = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(source, /port:\s*43123/);
  assert.match(source, /target:\s*"http:\/\/127\.0\.0\.1:3000"/);
  assert.match(source, /replace\(\/\^\\\/api\/,\s*""\)/);
  assert.equal(source.includes("PUBLIC_BASE_URL"), false);
  assert.equal(source.includes("CORS_ORIGIN"), false);
  assert.equal(source.includes("VITE_"), false);
});

test("两个开关都是字面量 false，且不读环境", async () => {
  const source = await readFile(new URL("../src/features.ts", import.meta.url), "utf8");
  assert.match(source, /export const searchCallsEnabled = false;/);
  assert.match(source, /export const albumCallsEnabled = false;/);
  assert.equal(source.includes("import.meta.env"), false);
  assert.equal(source.includes("localStorage"), false);
});

test("网页不新增依赖，根测试脚本仍然只跑 API", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["react", "react-dom"]);
  for (const banned of ["playwright", "vitest", "@playwright/test", "jest", "jsdom", "happy-dom", "@testing-library/react"]) {
    assert.equal(Object.hasOwn(pkg.devDependencies, banned), false);
  }
  const root = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as {
    scripts: { test: string };
  };
  assert.equal(root.scripts.test, "node scripts/check-layer-boundaries.mjs && npm run test -w apps/api");
});

test("阶段 6 已开工且设计状态未被改掉", async () => {
  const phase = await readFile(new URL("../../../specs/phases/06-web-ui.md", import.meta.url), "utf8");
  assert.match(phase, /\*\*状态：\*\* in_progress/);
  assert.equal((phase.match(/- \[x\]/g) ?? []).length, 0);
  assert.ok((phase.match(/- \[ \]/g) ?? []).length >= 6);
  const spec = await readFile(new URL("../../../specs/SPEC.md", import.meta.url), "utf8");
  assert.match(spec, /\| 6 \|.*\| in_progress \|/);
  const design = await readFile(
    new URL("../../../docs/superpowers/specs/2026-11-06-openalbum-phase6-web-ui-design.md", import.meta.url),
    "utf8",
  );
  assert.match(design, /状态：已定稿（待实现）/);
});
