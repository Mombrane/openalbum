import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import type { StorageConfig } from "../src/gateways/storage/config.js";
import { createS3ObjectStorage, type S3CommandClient } from "../src/gateways/storage/s3-object-storage.js";

const config: StorageConfig = {
  endpoint: "https://s3.example.com",
  region: "ap-singapore",
  bucket: "album",
  accessKeyId: "AKID",
  secretAccessKey: "SECRET",
  forcePathStyle: true,
  signedUrlTtlSeconds: 900,
};

test("S3 适配按端口翻译命令，不把 SDK 异常 message 当作成功文本", async () => {
  const sent: string[] = [];
  const client: S3CommandClient = {
    async send(command) {
      sent.push(command.constructor.name);
      if (command.constructor.name === "AbortMultipartUploadCommand") {
        throw Object.assign(new Error("upload missing SECRET"), { name: "NoSuchUpload" });
      }
      if (command.constructor.name === "HeadObjectCommand") {
        throw Object.assign(new Error("The specified key does not exist: SECRET"), { name: "NotFound" });
      }
      if (command.constructor.name === "DeleteObjectCommand") {
        throw Object.assign(new Error("gone SECRET"), { name: "NotFound" });
      }
      return { UploadId: "up-1", ETag: '"etag-1"' };
    },
  };
  const presigned: string[] = [];
  const storage = createS3ObjectStorage(config, client, async (_command, options) => {
    presigned.push(String(options.expiresIn));
    return "https://s3.example.com/album/k?X-Amz-Signature=abc";
  });
  assert.deepEqual(await storage.createMultipartUpload({ key: "k", contentType: "image/jpeg" }), { uploadId: "up-1" });
  const part = await storage.uploadPart({ key: "k", uploadId: "up-1", partNumber: 1, body: Buffer.from("abc") });
  assert.equal(part.etag, '"etag-1"');
  assert.equal(part.byteSize, 3);
  await storage.completeMultipartUpload({ key: "k", uploadId: "up-1", parts: [{ partNumber: 1, etag: '"etag-1"' }] });
  await storage.abortMultipartUpload({ key: "k", uploadId: "missing" });
  assert.equal(await storage.headObject({ key: "missing" }), null);
  await storage.deleteObject({ key: "missing" });
  const now = new Date("2026-11-04T02:31:00.000Z");
  const signed = await storage.presignGet({ key: "owners/u/photos/p/original", expiresInSeconds: 900, now });
  assert.equal(signed.expiresAt.toISOString(), "2026-11-04T02:46:00.000Z");
  assert.equal(presigned[0], "900");
  assert.deepEqual(sent.slice(0, 3), ["CreateMultipartUploadCommand", "UploadPartCommand", "CompleteMultipartUploadCommand"]);
});

test("GetObject 与 PutObject 带 60 秒 abort，缺失对象返回空", async () => {
  const sent: Array<{ name: string; signal: boolean }> = [];
  const client: S3CommandClient = {
    async send(command, options) {
      sent.push({ name: command.constructor.name, signal: options?.abortSignal instanceof AbortSignal });
      if (command.constructor.name === "GetObjectCommand" && command.input.Key === "missing") {
        throw Object.assign(new Error("hidden SECRET"), { name: "NoSuchKey" });
      }
      if (command.constructor.name === "GetObjectCommand") return { Body: Buffer.from("bytes") };
      return {};
    },
  };
  const storage = createS3ObjectStorage(config, client, async () => "https://example.invalid/signed");
  const found = await storage.getObject({ key: "owners/u/photos/p/original" });
  assert.equal(found?.body.toString(), "bytes");
  assert.equal(found?.byteSize, 5);
  assert.equal(await storage.getObject({ key: "missing" }), null);
  await storage.putObject({ key: "owners/u/photos/p/thumb", contentType: "image/jpeg", body: Buffer.from("jpeg") });
  assert.deepEqual(sent.map((item) => item.name), ["GetObjectCommand", "GetObjectCommand", "PutObjectCommand"]);
  assert.equal(sent.every((item) => item.signal), true);
});

test("getObject 在读响应体时仍受截止约束", { timeout: 2000 }, async () => {
  const source = new Readable({ read() {} });
  source.push(Buffer.from("partial"));
  const destroyed: unknown[] = [];
  const destroy = source.destroy.bind(source);
  source.destroy = ((error?: Error) => {
    destroyed.push(error);
    return destroy(error);
  }) as typeof source.destroy;
  let bodyReadStarted = false;
  const read = new Promise<Uint8Array>((resolve, reject) => {
    const collector = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    source.pipe(collector);
    source.on("error", (error) => {
      collector.end();
      reject(error);
    });
    collector.on("error", reject);
    collector.on("finish", () => resolve(new Uint8Array()));
  });
  const collectorSettled = Promise.race([
    read.then(() => "settled", () => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 200)),
  ]);
  const client: S3CommandClient = {
    async send() {
      return {
        Body: Object.assign(source, {
          transformToByteArray() {
            bodyReadStarted = true;
            return read;
          },
        }),
      };
    },
  };
  const storage = createS3ObjectStorage(config, client, async () => "https://example.invalid/signed", 50);
  await assert.rejects(
    () => storage.getObject({ key: "owners/u/photos/p/original" }),
    (error: unknown) => (error as { name?: string }).name === "AbortError",
  );
  assert.equal(bodyReadStarted, true);
  assert.equal(destroyed.length, 1);
  assert.equal(destroyed[0] instanceof Error, true);
  assert.equal((destroyed[0] as { name?: string }).name, "AbortError");
  assert.equal(await collectorSettled, "settled");
});
