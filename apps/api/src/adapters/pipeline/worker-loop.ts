import type { WorkerControl } from "./deps.js";

export const SHUTDOWN_WAIT_MS = 60_000;

export async function runWorkerLoop(input: {
  pollMs: number;
  concurrency: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  runOnce: (now: Date, limit: number) => Promise<void>;
  releaseUnfinished: (now: Date) => Promise<void>;
  control: WorkerControl;
}): Promise<void> {
  while (!input.control.stopped) {
    const limit = input.concurrency - input.control.inflight.size;
    await input.runOnce(input.now(), limit);
    if (input.control.stopped) break;
    await input.sleep(input.pollMs);
  }
  await input.releaseUnfinished(input.now());
}
