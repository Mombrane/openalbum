import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(repoRoot, "apps/api/src");

const layers = ["interfaces", "adapters", "domain", "gateways", "dao"];

const required = [
  "interfaces/index.ts",
  "interfaces/http/register-health.ts",
  "adapters/index.ts",
  "domain/index.ts",
  "domain/identity/index.ts",
  "domain/library/index.ts",
  "domain/album/index.ts",
  "domain/search/index.ts",
  "gateways/index.ts",
  "gateways/storage/index.ts",
  "gateways/vision/index.ts",
  "gateways/embed/index.ts",
  "dao/index.ts",
];

/** 各层禁止 import 的其他层。组合根（src/*.ts）不在此列。 */
const forbidLayers = {
  interfaces: ["dao", "gateways"],
  adapters: ["dao", "gateways", "interfaces"],
  domain: ["interfaces", "adapters", "gateways", "dao"],
  gateways: ["interfaces", "adapters", "dao"],
  dao: ["interfaces", "adapters", "gateways"],
};

const domainPackages = new Set([
  "fastify",
  "pg",
  "postgres",
  "mysql",
  "mysql2",
  "minio",
  "aws-sdk",
  "undici",
  "sharp",
  "exifr",
  "http",
  "https",
  "net",
  "argon2",
  "jose",
]);

const domainPrefixes = ["@fastify/", "@aws-sdk/", "@aws/", "node:http", "node:https", "node:net"];

const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"\n]+?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

async function listTypeScriptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function layerOf(file) {
  const relative = path.relative(srcRoot, file);
  return layers.find((layer) => relative === layer || relative.startsWith(`${layer}${path.sep}`));
}

function packageName(specifier) {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return `${scope}/${name}`;
  }
  return specifier.split("/")[0];
}

function domainForbidsPackage(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) {
    return domainPrefixes.some((prefix) => specifier.startsWith(prefix));
  }
  if (domainPrefixes.some((prefix) => specifier.startsWith(prefix))) {
    return true;
  }
  return domainPackages.has(packageName(specifier));
}

function specifiersOf(source) {
  const found = [];
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] || match[2] || match[3];
    if (specifier) found.push(specifier);
  }
  return found;
}

const violations = [];

for (const relative of required) {
  const full = path.join(srcRoot, relative);
  try {
    await readFile(full);
  } catch {
    violations.push(`缺少分层入口：apps/api/src/${relative}`);
  }
}

for (const file of await listTypeScriptFiles(srcRoot)) {
  const layer = layerOf(file);
  if (!layer) continue;

  const source = await readFile(file, "utf8");
  for (const specifier of specifiersOf(source)) {
    const where = path.relative(repoRoot, file);

    if (layer === "domain" && domainForbidsPackage(specifier)) {
      violations.push(`${where} 引用了基础设施模块 ${specifier}`);
    }

    if (!specifier.startsWith(".")) continue;

    const resolved = path.resolve(path.dirname(file), specifier);
    const targetLayer = layers.find((name) => {
      const root = path.join(srcRoot, name);
      return resolved === root || resolved.startsWith(root + path.sep);
    });
    if (targetLayer && forbidLayers[layer].includes(targetLayer)) {
      violations.push(`${where}（${layer}）引用了 ${targetLayer}：${specifier}`);
    }
  }
}

if (violations.length > 0) {
  console.error("分层边界检查失败：");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("分层边界检查通过");
