import assert from "node:assert/strict";
import test from "node:test";
import { createFakeObjectStorage, createStorageGate } from "../src/gateways/storage/fake-object-storage.js";

const now = new Date("2026-11-04T02:31:00.000Z");

test("假存储覆盖分片、拼字节、中止缺失视为成功，并签发不含密钥的 URL", async () => {
  const storage = createFakeObjectStorage();
  const created = await storage.createMultipartUpload({ key: "owners/u/photos/p/original", contentType: "image/jpeg" });
  const first = await storage.uploadPart({ key: "owners/u/photos/p/original", uploadId: created.uploadId, partNumber: 1, body: Buffer.from("aa") });
  const second = await storage.uploadPart({ key: "owners/u/photos/p/original", uploadId: created.uploadId, partNumber: 1, body: Buffer.from("bbb") });
  assert.notEqual(first.etag, second.etag);
  await storage.completeMultipartUpload({
    key: "owners/u/photos/p/original",
    uploadId: created.uploadId,
    parts: [{ partNumber: 1, etag: second.etag }],
  });
  assert.equal(storage.completedBytes("owners/u/photos/p/original")?.toString(), "bbb");
  assert.deepEqual(await storage.headObject({ key: "owners/u/photos/p/original" }), { byteSize: 3 });
  await storage.abortMultipartUpload({ key: "owners/u/photos/p/original", uploadId: created.uploadId });
  const signed = await storage.presignGet({ key: "missing", expiresInSeconds: 900, now });
  assert.equal(signed.url.startsWith("http://storage.invalid/get?"), true);
  assert.equal(signed.url.includes("SECRET"), false);
  assert.equal(signed.expiresAt.toISOString(), "2026-11-04T02:46:00.000Z");
  await storage.deleteObject({ key: "owners/u/photos/p/original" });
  assert.deepEqual(storage.deletedKeys, ["owners/u/photos/p/original"]);
  await storage.deleteObject({ key: "owners/u/photos/p/original" });
});

test("complete 栅栏在进入时已经能被观察，失败删除仍记录键", async () => {
  const storage = createFakeObjectStorage();
  const created = await storage.createMultipartUpload({ key: "k", contentType: "image/jpeg" });
  await storage.uploadPart({ key: "k", uploadId: created.uploadId, partNumber: 1, body: Buffer.from("z") });
  const gate = createStorageGate();
  storage.blockComplete(gate);
  const pending = storage.completeMultipartUpload({ key: "k", uploadId: created.uploadId, parts: [{ partNumber: 1, etag: "x" }] });
  await gate.entered;
  assert.equal(storage.completeCalls, 1);
  gate.release();
  await pending;
  storage.failDelete = true;
  await assert.rejects(storage.deleteObject({ key: "k" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AccessDenied");
    return true;
  });
  assert.deepEqual(storage.deletedKeys, ["k"]);
});
