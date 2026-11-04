# Task 8 报告：设计 §10 HTTP 验收

## 状态

**DONE**

## 范围

扩展 `apps/api/test/personal-library.test.ts`：Task 7 冒烟保留，新增 §10 项 1–11、§10.13 completing 栅栏、附加 HTTP 边角（共 16 项 personal-library 测试）。

## §10 覆盖对照

| 设计 §10 | 用例名 | HTTP |
|----------|--------|------|
| 1 | §10.1 JWT 上传完成与列表 URL | ✓ |
| 2 | §10.2 API Key 全流程与 source 字段 | ✓ |
| 3 | §10.3 越权一律 404 | ✓ |
| 4 | §10.4 PATCH 字段与非法键 | ✓ |
| 5 | §10.5 删除与 failDelete 日志 | ✓ |
| 6 | §10.6 创建校验与 RAW 白名单 | ✓ |
| 7 | §10.7 分片完成规则 | ✓ |
| 8 | §10.8 覆盖分片字节 | ✓ |
| 9 | §10.9 中止与完成状态机 | ✓ |
| 10 | §10.10 过期分片触发中止 | ✓ |
| 11 | §10.11 列表 originalUrlExpiresAt TTL | ✓（解析表仍在 `storage-config.test.ts`） |
| 12 | — | Task 9 分层边界，本任务未写 |
| 13 | §10.13 完成进行中…409 | ✓ |
| 附加 | 附加 HTTP 边角 | ✓（413/分片类型/PUT+POST/路径与 query） |

## 生产修正（断言驱动）

1. `register-photos.ts`：`POST /photos/uploads` 在入用例前校验 `contentType` 为 string、`byteSize` 为整数，非此 →「请求不合法」。
2. `app.ts`：AJV `coerceTypes: false`，避免 `contentType: 123` 被强转为字符串绕过 schema。

## 测试说明

- §10.10 在 `clock` 拨过 `expiresAt` 后重新 `login` 换取有效 Access JWT（TTL 120s，与会话 24h 过期无关）。
- §10.5 使用带 `Writable` 日志的临时 `buildApp` 断言 redact。

## TDD

| 结果 |
|------|
| `personal-library.test.ts` 16/16 |
| `npm test` **93/93** |

## 提交

| SHA | 说明 |
|-----|------|
| `382c6de` | test: 覆盖个人库上传、越权与 completing 栅栏 |

## 后续

Task 9 分层边界扫描；Task 10 阶段状态。
