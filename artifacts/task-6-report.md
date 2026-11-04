# Task 6 报告：列表、详情、PATCH 与删除用例

## 状态

**DONE**

## 范围

新增 `list-photos.ts`、`get-photo.ts`、`patch-photo.ts`、`delete-photo.ts` 与 `library-photos.test.ts`（6 项 serial，覆盖 brief 1–6）。`adapters/index.ts` 导出四个用例及 Task 5 符号。`abort-locked.ts` 增加 `storageFailed` 布尔，避免与 `"storage_error"` 字面量比较的 TS 问题。未改 `messages.ts`、未接 HTTP。

## TDD

| 阶段 | 结果 |
|------|------|
| RED | 无 `listPhotos` 时测试失败 |
| GREEN | `library-photos.test.ts` 6/6；与 upload 联跑 20/20（需 `--test-concurrency=1`）；`npm test` 76/76；`tsc --noEmit` 通过 |

**测试修正：** 分页用例中「先完成 / 后完成」与 `createUpload` 的 `photoId`/`sessionId` 发号顺序一致——变量名 `older`/`newer` 按 `created_at` 排序，而非完成调用顺序。

## 行为要点

- `listPhotos`：`limit+1` 键集分页；签发失败整页 `storageError()`。
- `deletePhoto`：先 `deleteOwned`（异常 → `deleteIncomplete()`）；再尽力 `deleteObject`（含 `thumbKey`）；对象失败只记「删除对象失败」，仍 204。
- 跨 owner：详情/PATCH/删除一律 404「未找到」。

## 提交

| SHA | 说明 |
|-----|------|
| `ee9b5ff` | feat: 实现照片列表、详情、修改与删除 |

## 关注点

- Brief Step 4 若省略 `--test-concurrency=1`，两测试文件会并行抢库导致假失败；仓库 `npm test` 已固定并发为 1。
- `deleteOwned` 抛错路径未单独造集成用例（brief 未要求）；逻辑已实现并消费 `deleteIncomplete()`。

## 后续

Task 7 接线 HTTP 与 `buildApp`；Task 6 不再扩展。
