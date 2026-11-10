import assert from "node:assert/strict";
import test from "node:test";
import {
  fallbackMessage,
  formatByteSize,
  formatLocalMinute,
  formatScore,
  photoAlt,
  statusText,
  visibleMessage,
} from "../src/copy.ts";

test("兜底句按状态码，不展示自由文本", () => {
  assert.equal(fallbackMessage(400), "请求不合法");
  assert.equal(fallbackMessage(401), "未授权");
  assert.equal(fallbackMessage(403), "当前凭证不能执行该操作");
  assert.equal(fallbackMessage(404), "未找到");
  assert.equal(fallbackMessage(409), "请求冲突");
  assert.equal(fallbackMessage(413), "文件超过 32 MiB");
  assert.equal(fallbackMessage(500), "服务器错误");
  assert.equal(fallbackMessage(502), "嵌入被拒绝");
  assert.equal(fallbackMessage(503), "嵌入暂不可用");
  assert.equal(fallbackMessage(200), "服务器错误");
  assert.equal(fallbackMessage(418), "服务器错误");
});

test("允许列表逐字匹配，比较前不 trim", () => {
  assert.equal(
    visibleMessage({ status: 500, code: "internal_error", serverMessage: "上传未能完成", audience: "general" }),
    "上传未能完成",
  );
  assert.equal(
    visibleMessage({ status: 400, code: "validation_error", serverMessage: "查询为空 ", audience: "search" }),
    "请求不合法",
  );
});

test("搜索 validation_error 不收成同一句", () => {
  for (const message of ["请求不合法", "标签不合法", "拍摄时间不合法", "时间范围不合法"] as const) {
    assert.equal(
      visibleMessage({ status: 400, code: "validation_error", serverMessage: message, audience: "search" }),
      message,
    );
  }
  assert.equal(
    visibleMessage({ status: 400, code: "validation_error", serverMessage: "随便写的", audience: "search" }),
    "请求不合法",
  );
  assert.equal(
    visibleMessage({ status: 400, code: "validation_error", serverMessage: "查询为空", audience: "search" }),
    "查询为空",
  );
  assert.equal(
    visibleMessage({ status: 400, code: "query_too_long", serverMessage: "查询过长", audience: "search" }),
    "查询过长",
  );
  assert.equal(
    visibleMessage({ status: 502, code: "embed_rejected", serverMessage: "嵌入被拒绝", audience: "search" }),
    "嵌入被拒绝",
  );
  assert.equal(
    visibleMessage({ status: 503, code: "embed_unavailable", serverMessage: "嵌入暂不可用", audience: "search" }),
    "嵌入暂不可用",
  );
});

test("登录 401 invalid_credentials 固定为邮箱或密码错误", () => {
  assert.equal(
    visibleMessage({ status: 401, code: "invalid_credentials", serverMessage: "未授权", audience: "login" }),
    "邮箱或密码错误",
  );
});

test("处理状态有文字", () => {
  assert.equal(statusText("processing", null), "处理中");
  assert.equal(statusText("processing", "storage"), "处理中，将自动重试");
  assert.equal(statusText("processing", "vision_unavailable"), "处理中，将自动重试");
  assert.equal(statusText("processing", "embed_unavailable"), "处理中，将自动重试");
  assert.equal(statusText("failed", "storage"), "处理失败，可以重试");
  assert.equal(statusText("failed", "original_missing"), "原图缺失");
  assert.equal(statusText("failed", "thumbnail_failed"), "缩略图失败");
  assert.equal(statusText("failed", "vision_rejected"), "描述被拒绝");
  assert.equal(statusText("failed", "embed_rejected"), "嵌入被拒绝");
  assert.equal(statusText("failed", "dimension_mismatch"), "向量维度不符");
  assert.equal(statusText("failed", "invalid_embedding"), "向量无效");
  assert.equal(statusText("failed", "other"), "处理未完成");
  assert.equal(statusText("failed", null), "处理未完成");
  assert.equal(statusText("ready", "storage"), "已就绪");
});

test("字节与本地时间", () => {
  assert.equal(formatByteSize(1023), "1023 字节");
  assert.equal(formatByteSize(1024), "1 KiB");
  assert.equal(formatByteSize(1536), "2 KiB");
  assert.equal(formatByteSize(1048576), "1.0 MiB");
  assert.equal(formatByteSize(1572864), "1.5 MiB");
  const iso = "2026-11-10T00:30:00.000Z";
  const date = new Date(iso);
  const expected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  assert.equal(formatLocalMinute(iso), expected);
  assert.match(formatLocalMinute(iso), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("score 不二次舍入", () => {
  assert.equal(formatScore(1), "1");
  assert.equal(formatScore(0.333333), "0.333333");
  assert.equal(formatScore(-0.25), "-0.25");
});

test("图片替代文本", () => {
  assert.equal(photoAlt("  海边  "), "海边");
  assert.equal(photoAlt("   "), "照片");
  assert.equal(photoAlt(null), "照片");
});
