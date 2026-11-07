import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runWorkerLoop } from "../src/adapters/pipeline/worker-loop.js";
import type { WorkerControl } from "../src/adapters/pipeline/deps.js";

test("停止后不再领取，并释放仍在执行的任务", async () => {
  const control: WorkerControl = { stopped: false, inflight: new Map() };
  const limits: number[] = [];
  let sleeps = 0;
  let released = 0;
  await runWorkerLoop({
    pollMs: 10,
    concurrency: 2,
    now: () => new Date("2030-01-01T00:00:00.000Z"),
    sleep: async () => {
      sleeps += 1;
    },
    runOnce: async (_now, limit) => {
      limits.push(limit);
      control.stopped = true;
    },
    releaseUnfinished: async () => {
      released += 1;
    },
    control,
  });
  assert.deepEqual(limits, [2]);
  assert.equal(sleeps, 0);
  assert.equal(released, 1);
});

test("worker 源码不监听端口，生产入口检查对象存储占位符", async () => {
  const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  const api = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const unit = await readFile(new URL("../../../deploy/systemd/photo-worker.service.example", import.meta.url), "utf8");
  assert.equal(worker.includes(".listen("), false);
  assert.equal(worker.includes("SIGTERM"), true);
  assert.equal(worker.includes("SIGINT"), true);
  assert.equal(worker.includes("60000"), true);
  assert.equal(api.includes("对象存储配置仍是占位符"), true);
  assert.equal(api.includes("VISION_"), false);
  assert.equal(api.includes("PIPELINE_"), false);
  assert.equal(api.includes("loadApiEmbedConfig"), true);
  assert.equal(api.includes("嵌入配置仍是占位符，语义检索不可用"), true);
  assert.match(unit, /dist\/worker\.js/);
  assert.equal(unit.includes("PORT"), false);
});
