import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { requireDatabaseUrl } from "./apply-schema.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

test("S3 TTL 超过 7 天时入口进程退出且不泄露密钥", async () => {
  const child = spawn("npx", ["tsx", "apps/api/src/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: requireDatabaseUrl(),
      JWT_SECRET: "test-jwt-secret-at-least-32-bytes",
      API_KEY_PEPPER: "test-pepper-at-least-32-bytes-ok",
      S3_ENDPOINT: "https://cos.ap-singapore.myqcloud.com",
      S3_REGION: "ap-singapore",
      S3_BUCKET: "album",
      S3_ACCESS_KEY_ID: "AKID",
      S3_SECRET_ACCESS_KEY: "SECRET",
      S3_SIGNED_URL_TTL: "8d",
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 5000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  assert.notEqual(exitCode, null, "进程应在 5 秒内退出");
  assert.equal(exitCode, 1);
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  assert.match(stderr, /S3_SIGNED_URL_TTL 超过 7 天/);
  assert.equal(stderr.includes("SECRET"), false);
});
