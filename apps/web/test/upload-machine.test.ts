import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NETWORK_MESSAGE } from "../src/copy.ts";
import {
  UPLOAD_CLOSED_MESSAGE,
  UPLOAD_COMPLETING_MESSAGE,
  contentTypeForFile,
  onCompleting,
  uploadFailure,
  uploadFailureVisibleMessage,
  validateFileSize,
  type UploadFailureInput,
} from "../src/pages/upload-machine.ts";

const http = (
  status: number,
  code: string | null = null,
  serverMessage: string | null = null,
): UploadFailureInput => ({
  network: false,
  status,
  code,
  serverMessage,
});

const net: UploadFailureInput = {
  network: true,
  status: null,
  code: null,
  serverMessage: null,
};

test('contentTypeForFile：MIME 去参数后白名单优先于扩展名', () => {
  assert.equal(contentTypeForFile("image/jpeg; charset=binary", "a.txt"), "image/jpeg");
});

test("contentTypeForFile：扩展名映射（大小写不敏感）", () => {
  assert.equal(contentTypeForFile("", "photo.JPEG"), "image/jpeg");
  assert.equal(contentTypeForFile("", "x.cr2"), "image/x-canon-cr2");
  assert.equal(contentTypeForFile("", "a.nef"), "image/x-nikon-nef");
  assert.equal(contentTypeForFile("", "a.ARW"), "image/x-sony-arw");
  assert.equal(contentTypeForFile("", "scan.dng"), "image/x-adobe-dng");
  assert.equal(contentTypeForFile("", "a.png"), "image/png");
  assert.equal(contentTypeForFile("", "a.webp"), "image/webp");
  assert.equal(contentTypeForFile("", "a.heic"), "image/heic");
  assert.equal(contentTypeForFile("", "a.heif"), "image/heif");
  assert.equal(contentTypeForFile("", "a.jpg"), "image/jpeg");
  assert.equal(contentTypeForFile("", "a.jpeg"), "image/jpeg");
});

test("contentTypeForFile：无法识别返回 null", () => {
  assert.equal(contentTypeForFile("application/pdf", "doc.pdf"), null);
  assert.equal(contentTypeForFile("", "file.xyz"), null);
});

test("validateFileSize 边界", () => {
  assert.deepEqual(validateFileSize(0), {
    ok: false,
    message: "文件大小须为 1 字节到 32 MiB",
  });
  assert.deepEqual(validateFileSize(33554433), {
    ok: false,
    message: "文件大小须为 1 字节到 32 MiB",
  });
  assert.deepEqual(validateFileSize(1), { ok: true });
  assert.deepEqual(validateFileSize(33554432), { ok: true });
});

test("onCompleting 自动完成调度", () => {
  assert.deepEqual(onCompleting(3), { kind: "schedule", delayMs: 1000, attemptsLeft: 2 });
  assert.deepEqual(onCompleting(2), { kind: "schedule", delayMs: 1000, attemptsLeft: 1 });
  assert.deepEqual(onCompleting(1), { kind: "schedule", delayMs: 1000, attemptsLeft: 0 });
  assert.deepEqual(onCompleting(0), { kind: "button" });
});

test("uploadFailure create：网络或 500 → 重新上传", () => {
  assert.deepEqual(uploadFailure("create", net), {
    kind: "button",
    label: "重新上传",
    action: "restart",
  });
  assert.deepEqual(uploadFailure("create", http(500)), {
    kind: "button",
    label: "重新上传",
    action: "restart",
  });
  assert.deepEqual(uploadFailure("create", http(400, "invalid", "请求不合法")), {
    kind: "button",
    label: "重新上传",
    action: "restart",
  });
});

test("uploadFailure part：网络或 storage_error → 重试分片", () => {
  assert.deepEqual(uploadFailure("part", net), {
    kind: "button",
    label: "重试分片",
    action: "retry-part",
  });
  assert.deepEqual(uploadFailure("part", http(500, "storage_error", "对象存储不可用")), {
    kind: "button",
    label: "重试分片",
    action: "retry-part",
  });
});

test("uploadFailure part：409 upload_completing / upload_completed / closed / 404", () => {
  assert.deepEqual(uploadFailure("part", http(409, "upload_completing", "上传正在完成")), {
    kind: "enter-auto-complete",
  });
  assert.deepEqual(uploadFailure("part", http(409, "upload_completed", "上传已完成")), {
    kind: "finish-via-complete",
  });
  assert.deepEqual(uploadFailure("part", http(409, "upload_closed", "上传已结束")), {
    kind: "closed",
  });
  assert.deepEqual(uploadFailure("part", http(404)), { kind: "closed" });
});

test("uploadFailure part：其它 HTTP → 重试（重传分片后完成）", () => {
  assert.deepEqual(uploadFailure("part", http(500, null, "服务器错误")), {
    kind: "button",
    label: "重试",
    action: "retry-part-then-complete",
  });
  assert.deepEqual(uploadFailure("part", http(500, "other", "对象存储不可用")), {
    kind: "button",
    label: "重试",
    action: "retry-part-then-complete",
  });
});

test("uploadFailure complete：409 upload_completing → enter-auto-complete", () => {
  assert.deepEqual(uploadFailure("complete", http(409, "upload_completing", "上传正在完成")), {
    kind: "enter-auto-complete",
  });
});

test("uploadFailure complete：500 上传未能完成 → 继续完成", () => {
  assert.deepEqual(
    uploadFailure("complete", http(500, null, "上传未能完成")),
    { kind: "button", label: "继续完成", action: "complete" },
  );
  assert.deepEqual(
    uploadFailure("complete", http(500, null, " 上传未能完成 ")),
    { kind: "button", label: "重试", action: "complete" },
  );
});

test("uploadFailure complete：网络 → 重试完成", () => {
  const action = uploadFailure("complete", net);
  assert.deepEqual(action, { kind: "button", label: "重试", action: "complete" });
  assert.equal(uploadFailureVisibleMessage("complete", net), NETWORK_MESSAGE);
});

test("uploadFailure complete：其它 500 → 重试完成", () => {
  assert.deepEqual(uploadFailure("complete", http(500, null, "对象存储不可用")), {
    kind: "button",
    label: "重试",
    action: "complete",
  });
});

test("uploadFailure complete：409 upload_closed 或 404 → closed", () => {
  assert.deepEqual(uploadFailure("complete", http(409, "upload_closed", "上传已结束")), {
    kind: "closed",
  });
  assert.deepEqual(uploadFailure("complete", http(404)), { kind: "closed" });
});

test("uploadFailure abort：409 upload_completing / upload_completed", () => {
  assert.deepEqual(uploadFailure("abort", http(409, "upload_completing", "上传正在完成")), {
    kind: "enter-auto-complete",
  });
  assert.notEqual(uploadFailure("abort", http(409, "upload_completing", "上传正在完成")).kind, "cancelled");
  assert.deepEqual(uploadFailure("abort", http(409, "upload_completed", "上传已完成")), {
    kind: "finish-via-complete",
  });
});

test("uploadFailure abort：网络或 500 → 重试中止", () => {
  assert.deepEqual(uploadFailure("abort", net), {
    kind: "button",
    label: "重试",
    action: "abort",
  });
  assert.deepEqual(uploadFailure("abort", http(500)), {
    kind: "button",
    label: "重试",
    action: "abort",
  });
});

test("固定可见句常量", () => {
  assert.equal(UPLOAD_CLOSED_MESSAGE, "上传已结束");
  assert.equal(UPLOAD_COMPLETING_MESSAGE, "上传正在完成");
});

test("upload.tsx 源码：单文件上传流程", async () => {
  const source = await readFile(new URL("../src/pages/upload.tsx", import.meta.url), "utf8");
  assert.match(source, /\bcreateUpload\b/);
  assert.match(source, /\bputPart\b/);
  assert.match(source, /\bcompleteUpload\b/);
  assert.match(source, /\babortUpload\b/);
  assert.match(source, /\bonCompleting\b/);
  assert.match(source, /正在创建上传/);
  assert.match(source, /正在上传/);
  assert.match(source, /正在完成/);
  assert.doesNotMatch(source, /\bmultiple\b/);
  assert.equal(source.includes("localStorage"), false);
  assert.equal(source.includes("sessionStorage"), false);
});

test("App.tsx 使用 UploadPage", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /\bUploadPage\b/);
});
