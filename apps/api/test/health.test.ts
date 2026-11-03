import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";

test("GET /health 返回 ok", async () => {
  const app = await buildApp({
    logger: false,
    config: {
      jwtSecret: "x".repeat(32),
      pepper: "y".repeat(32),
      accessTtlSeconds: 900,
      refreshTtlSeconds: 2_592_000,
      databaseUrl: "postgres://photo:unused@127.0.0.1:1/none",
    },
  });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  await app.close();
});
