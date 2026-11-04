# Task 9 报告：锁住领域层不得出现对象存储 SDK

## 状态

**DONE**

## 范围

新增 `apps/api/test/library-boundaries.test.ts`：递归扫描 `domain/library` 与 `adapters/library` 源码，断言无对象存储 SDK 包名字面量、domain 无 `Date.now`/`new Date()`、无 `domain/identity`、adapters 无 `/dao` 与 `/gateways` 路径；并校验 `check-layer-boundaries.mjs` 仍登记 `aws-sdk`、`minio`、`@aws-sdk/`。

`scripts/check-layer-boundaries.mjs` **未改动**（所需字符串已存在）。

设计 §10 第 12 条（分层边界）由本任务 + 既有 `npm test` 脚本覆盖。

## 验证

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npm test                    # 分层边界检查通过；94/94
npx tsc -p apps/api/tsconfig.json --noEmit
npm run build -w apps/api
```

## 提交

| SHA | 说明 |
|-----|------|
| （push 后填写） | test: 锁定个人库领域层不引用对象存储 SDK |

## 关注点

- 扫描规则禁止的是字面量 `new Date()`，带参数的 `new Date(iso)` 仍用于解析 PATCH/游标，符合注入时钟约束。

## 后续

Task 10 阶段状态与设计定稿标记。
