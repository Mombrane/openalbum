import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nextPollIds } from "../src/pages/library.tsx";

const FIVE_IDS = ["id-1", "id-2", "id-3", "id-4", "id-5"];

test("nextPollIds：5 个 id、offset 0 取前 4 个且 nextOffset 为 4", () => {
  const batch = nextPollIds(FIVE_IDS, 0);
  assert.deepEqual(batch.ids, ["id-1", "id-2", "id-3", "id-4"]);
  assert.equal(batch.nextOffset, 4);
});

test("nextPollIds：offset 4 时从第 5 个再绕回前 3 个", () => {
  const batch = nextPollIds(FIVE_IDS, 4);
  assert.deepEqual(batch.ids, ["id-5", "id-1", "id-2", "id-3"]);
  assert.equal(batch.nextOffset, (4 + 4) % FIVE_IDS.length);
});

test("nextPollIds：2 个 id 时全部返回且 nextOffset 为 0", () => {
  const two = ["alpha", "beta"];
  const batch = nextPollIds(two, 0);
  assert.deepEqual(batch.ids, two);
  assert.equal(batch.nextOffset, 0);
});

test("library.tsx 源码：listPhotos、document.hidden、5000ms、不含 photos/search", async () => {
  const source = await readFile(new URL("../src/pages/library.tsx", import.meta.url), "utf8");
  assert.match(source, /\blistPhotos\b/);
  assert.match(source, /document\.hidden/);
  assert.match(source, /\b5000\b/);
  assert.equal(source.includes("photos/search"), false);
  assert.equal(/\blimit\b/.test(source), false, "limit 只应通过 listPhotos（api 层）");
});
