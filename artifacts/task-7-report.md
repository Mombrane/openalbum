# Task 7 报告：HTTP 路由、组合根与日志红线

## 状态

**DONE**

## 范围

- `register-photos.ts`：个人库八类 HTTP 路由、`octet-stream` 解析器、`requirePrincipal` → `LibraryActor`
- `send-library-error.ts`、`wire-library.ts`（`createLibraryDeps` / `libraryLogFromFastify`）
- `app.ts`：可选 `storage` / `signedUrlTtlSeconds`，默认假存储 + 900s TTL
- `index.ts`：`loadStorageConfig` 失败 `console.error` + `exit(1)`，成功则 S3 注入 `buildApp`
- `error-handler.ts`：分片路由 413/400 特例；`auth-logger.ts`：`originalUrl` 三条 redact
- `validation.ts`：`parseUuid` 返回小写
- 测试：`personal-library.test.ts`（3 项）、`storage-startup.test.ts`（1 项）

未做设计 §10 全量 HTTP 验收（Task 8）。

## TDD

| 阶段 | 结果 |
|------|------|
| RED | 无路由时 POST `/photos/uploads` 为 404 |
| GREEN | 冒烟 4/4；brief Step 4 联跑通过；`npm test` **80/80**；`tsc --noEmit` 通过 |

## 提交

| SHA | 说明 |
|-----|------|
| （push 后填写） | feat: 接通个人库 HTTP 路由与存储组合根 |

## 关注点

- 分片 HTTP 成功为 **200**（用例返回 `part` 体），非 204。
- `storage-startup` 子进程 cwd 为仓库根；brief 联跑多文件时需 `--test-concurrency=1`（与 `npm test` 一致）。

## 后续

Task 8 扩展 `personal-library.test.ts` 设计 §10 断言。
