import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";

test("GET /health 返回 ok", async () => {
  const app = buildApp({ logger: false });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  await app.close();
});
