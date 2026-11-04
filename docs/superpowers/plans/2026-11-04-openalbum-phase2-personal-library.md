# OpenAlbum Phase 2 — 个人照片库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让主人本人以及持有其有效 API Key 的 Agent，通过服务端中转的 S3 multipart 上传原图，并列出、查看、修改允许的元数据、删除自己的照片。

**Architecture:** `domain/library` 只放模型、纯规则和端口，不接触 S3 SDK。适配层编排事务、时钟和端口：呼叫 `completeMultipartUpload` 之前先把 `upload_sessions.status` 提交为 `completing`，存储成功之后才 `INSERT photos`。DAO 用 `pg` 做 `SELECT … FOR UPDATE` 与会随连接断开而释放的 advisory lock。S3 客户端和内存假存储都只在 `gateways/storage`。组合根是 `apps/api/src/app.ts`、`apps/api/src/index.ts` 与 `apps/api/src/wire-library.ts`。

**Tech Stack:** Node/TS, Fastify, pg, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, docker postgres, node:test

## Global Constraints

下列约束每个任务都要遵守。数值与硬规则抄自 [`docs/superpowers/specs/2026-11-04-openalbum-phase2-personal-library-design.md`](../specs/2026-11-04-openalbum-phase2-personal-library-design.md) 与 [`specs/phases/02-personal-library.md`](../../../specs/phases/02-personal-library.md)。

- Node.js `>=20`。本阶段新的运行时依赖只有 `@aws-sdk/client-s3` 与 `@aws-sdk/s3-request-presigner`。不引入 busboy、minio 客户端、新的校验库或别的对象存储 SDK。
- 不改 `apps/web`。不实现 EXIF、缩略图、视觉模型、嵌入、`jobs` 入队、搜索、共享册、预签名客户端直传、限流器、魔数嗅探、列出会话、按内容去重、删除用户时的对象清理、双密钥、CDN。
- 上传是服务端中转的 S3 multipart：创建会话、上传分片、完成、中止。客户端不拿预签名上传 URL。进行中只写 `upload_sessions` 与 `upload_parts`。存储完成之后才 `INSERT photos`，`status` 为 `processing`。不改 `photos` 既有列，不写 `thumb_key` 与 `error_message`，不修改 `jobs`。
- 单文件、单片、累计字节上限都是 32 MiB，等于 `33554432`（32 × 1024 × 1024）。除最后一片外每一片至少 5 MiB，等于 `5242880`。完成时分片编号必须正好是 `1..n`，各片字节之和等于声明的 `byteSize`，最多 7 片。上传接口仍接受 `1` 到 `10000`。整个文件可以只有一片，该片允许小于 5 MiB。
- 内容类型白名单固定，trim 后把类型和子类型转成小写，拒绝带参数的值。只接受：`image/jpeg`、`image/png`、`image/webp`、`image/heic`、`image/heif`、`image/x-canon-cr2`、`image/x-nikon-nef`、`image/x-sony-arw`、`image/x-adobe-dng`。不做成环境变量，不读文件头。
- 对象键只有 `owners/{userId}/photos/{photoId}/original`。`userId` 与 `photoId` 是小写 UUID。键不以 `/` 开头，不含桶名。客户端不能指定键。`photos.id` 使用创建会话时预生成的同一个 UUID。应用生成 UUID；DDL 里的 `gen_random_uuid()` 只作兜底。
- 会话寿命固定 24 小时，用注入的时钟计算 `expires_at = now + 24h`。不新增会话寿命环境变量，不读 `Date.now()`。没有后台扫表。
- 签名 GET 的 TTL 来自 `S3_SIGNED_URL_TTL`。省略或空白时为 `15m`（900 秒）。语法复用 `parseDurationSeconds`：正整数加 `s`、`m` 或 `d`。大于 7 天（`604800` 秒）拒绝启动。未注入存储时 `buildApp` 的 TTL 使用 900 秒。本阶段不读取 `S3_PUBLIC_BASE_URL`。
- 生产必填：`S3_ENDPOINT`（绝对 `http` 或 `https` URL，拒绝 userinfo）、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`。`S3_FORCE_PATH_STYLE` 只接受 `true` 或 `false`，省略或空白时为 `false`。非法配置时进程退出，不监听。错误文案只点名变量，不回显密钥或 endpoint 里的用户信息。固定句包括：`S3_SECRET_ACCESS_KEY 缺失`、`S3_SIGNED_URL_TTL 无效`、`S3_SIGNED_URL_TTL 超过 7 天`。
- 删除先删 `photos` 行并提交，再尽力 `deleteObject`。`thumb_key` 非空时缩略图也尽力删。对象删除失败只记日志，HTTP 仍是 204。行删除失败时不调用对象删除，返回 500 `internal_error`，文案「删除未能完成」。
- PATCH 只能改 `description`、`tags`、`taken_at`、`location_text`、`latitude`、`longitude`。出现 `contentType`、`objectKey`、`status`、`byteSize`、`id` 或其他未列出字段：400「请求不合法」。本阶段不因 PATCH 改变 `processing`，不入队。
- 已认证但不是主人，或 id 不存在：404 `not_found`，文案「未找到」。不使用 403 表示「这是别人的照片」。两种 `credentialKind` 在库路由上等价。`source_key_id` 仅在 `api_key` 时写 `credentialId`，密码会话写 `NULL`。
- 路径 UUID 匹配 `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`（大小写不敏感）。不匹配时 400「标识不合法」。写进数据库的 UUID 使用小写。`GET /photos/uploads` 这种非 UUID 落到 `GET /photos/:id` 时同样是 400「标识不合法」，不是 404。
- 校验失败的 `message` 只报告第一个问题，且只使用这些固定句：「请求不合法」「标识不合法」「不支持的文件类型」「文件大小须为 1 字节到 32 MiB」「分片不合法」「描述不合法」「标签不合法」「地点不合法」「拍摄时间不合法」「经纬度须成对出现」「经纬度超出范围」。另加状态文案：「未授权」「未找到」「上传已结束」「上传正在完成」「上传已完成」「文件超过 32 MiB」「对象存储不可用」「上传未能完成」「删除未能完成」。
- 错误体只有 `{ "error": { "code", "message" } }`。JSON 用 camelCase。入参用 Fastify JSON Schema，`additionalProperties` 为 false。分片正文是 `application/octet-stream` 原始字节，不是 `multipart/form-data`。该路由 `bodyLimit` 为 `33554432`。只有这条路由把请求体超限映射为 413 `payload_too_large`。其他路由保持现有错误处理。
- **completing 栅栏：** 持锁校验通过后，先把会话写成 `completing` 并提交，释放行锁，然后才拿互斥并呼叫 `completeMultipartUpload`。`completing` 在呼叫 `completeMultipartUpload` 之前对其他连接可见。此期间分片与中止返回 409 `upload_completing`，文案「上传正在完成」，不调用对象存储，不改分片行。`completing` 即使过了 `expires_at` 也不 Abort。另一完成请求拿不到该会话的存储互斥时，返回同一个 409，不发起第二次存储调用。互斥用 PostgreSQL session advisory lock（`pg_try_advisory_lock` / `pg_advisory_unlock`），连接断开即释放。完成路径在持有行锁期间不呼叫 `completeMultipartUpload`。分片路径可以在持有行锁期间呼叫 `uploadPart`。过期中止与客户端中止可以在行锁内呼叫 `abortMultipartUpload`，因为那不是 `completeMultipartUpload`，而且必须避免中止过程中收下新的分片。
- 对象存储失败且本文没有把这次失败定义成成功时：500 `storage_error`，文案「对象存储不可用」。对象已经完成但照片行没写上：500 `internal_error`，文案「上传未能完成」。客户端重试完成时不得再创建一遍对象。`abortMultipartUpload` 遇到 upload 已不存在视为成功。`deleteObject` 遇到对象已不存在视为成功。`headObject` 不存在则返回空。
- 响应正文、日志和错误对象都不得出现：`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`JWT_SECRET`、`API_KEY_PEPPER`、`Authorization` 头、Access JWT、Refresh Token、API Key 明文、签名 URL 的查询串（`originalUrl` 整段都不要记）、分片原始字节、S3 SDK 异常的 `message`。日志只许带 `userId`、`photoId`、`objectKey`、`uploadSessionId`、`partNumber`、`byteSize`、`reason`（`client` 或 `expired`）、错误的 `name`，另加一条静态中文。把 `originalUrl` 补进现有日志 redact 路径。身份测试要求的那些 redact 路径保持不动。
- 领域层不 import `fastify`、`pg`、`@aws-sdk/*`、`aws-sdk`、`minio`，也不 import `domain/identity`。适配层源码不得出现 `from ".../dao"` 或 `from ".../gateways"`。接口层不 import `dao`、`gateways`，不写归属判断，不访问 SQL，不调用 S3 SDK。假存储只放在 `gateways/storage`，假 URL 使用 `http://storage.invalid/get`，查询参数只带对象键和过期时间。
- `buildApp` 未传入 `storage` 时使用内存假存储，不读取 `S3_ACCESS_KEY_ID` 与 `S3_SECRET_ACCESS_KEY`，也不为这件事打日志。身份测试与 `GET /health` 不注入存储，必须仍能构造应用。个人库测试必须显式注入同一个假存储实例。
- 新测试放在 `apps/api/test/`，使用 `node:test` 与真实 PostgreSQL。缺少 `DATABASE_URL` 时失败，不跳过。`npm test` 已是 `node scripts/check-layer-boundaries.mjs && npm run test -w apps/api`，且 API 测试 `--test-concurrency=1`。不要改回并行。
- 按任务编号顺序执行。后一个任务假设前一个任务已经提交。不要提前实现后续任务的路由。
- 实现本计划时，子代理使用 Composer 2.5，不使用 fast 模式。
- 设计文件开头的「状态：已定稿（待实现）」不要改。阶段状态只按本计划 Task 1 与 Task 10 更新。

**开工前阅读：**

- `docs/superpowers/specs/2026-11-04-openalbum-phase2-personal-library-design.md`
- `specs/phases/02-personal-library.md`
- `specs/SPEC.md`
- `apps/api/src/app.ts`
- `apps/api/src/wire-identity.ts`
- `apps/api/src/domain/library/index.ts`
- `apps/api/src/gateways/storage/index.ts`
- `apps/api/src/gateways/auth/config.ts`
- `apps/api/src/interfaces/http/error-handler.ts`
- `apps/api/src/interfaces/http/auth-logger.ts`
- `scripts/check-layer-boundaries.mjs`
- `deploy/db/schema.sql`
- `deploy/env.example`

**开工前命令：** 下文所有命令都在仓库根目录执行。

```bash
npm install
docker compose up -d
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
```

---

## File Structure

| 路径 | 职责 |
|------|------|
| `deploy/db/schema.sql` | 在个人库段 `photos` 索引之后追加 `upload_sessions` 与 `upload_parts`。不改 `photos` 列 |
| `deploy/env.example` | 增加 `S3_SIGNED_URL_TTL=15m` 与默认值、语法、7 天上限注释 |
| `deploy/README.md` | 补一句 Phase 2 的表、TTL 与「不读取 `S3_PUBLIC_BASE_URL`」 |
| `specs/SPEC.md` | Task 1 把阶段 2 改为 `in_progress`；只有 Task 10 改为 `done` |
| `specs/phases/02-personal-library.md` | Task 1 把状态改为 `in_progress` 且不勾验收；只有 Task 10 改为 `done` 并勾上验收 |
| `apps/api/package.json` | 增加两个 AWS SDK 依赖。锁文件一起提交 |
| `apps/api/src/domain/library/constants.ts` | `33554432`、`5242880`、7 片、10000、24 小时 |
| `apps/api/src/domain/library/model.ts` | 照片、会话、分片、主体、补丁类型 |
| `apps/api/src/domain/library/content-type.ts` | 白名单与 `normalizeContentType` |
| `apps/api/src/domain/library/object-key.ts` | `photoObjectKey` |
| `apps/api/src/domain/library/parts.ts` | `validatePartsForComplete` |
| `apps/api/src/domain/library/metadata-patch.ts` | `normalizeMetadataPatch` |
| `apps/api/src/domain/library/visibility.ts` | `isVisiblePhoto` |
| `apps/api/src/domain/library/cursor.ts` | 游标与 `parsePhotoLimit` |
| `apps/api/src/domain/library/ports.ts` | `PhotoRepository`、`UploadSessionRepository`、`ObjectStorage`、`LibraryLog` |
| `apps/api/src/domain/library/index.ts` | 领域桶导出。保留 `LIBRARY_CONTEXT` |
| `apps/api/src/gateways/storage/config.ts` | `loadStorageConfig`。复用 `parseDurationSeconds` |
| `apps/api/src/gateways/storage/fake-object-storage.ts` | 内存假存储与 `createStorageGate` |
| `apps/api/src/gateways/storage/s3-object-storage.ts` | S3 SDK 适配。SDK 类型不得泄漏到领域 |
| `apps/api/src/gateways/storage/index.ts` | 导出网关。保留 `STORAGE_GATEWAY` |
| `apps/api/src/gateways/index.ts` | 再导出存储配置、假存储和 S3 工厂 |
| `apps/api/src/dao/photo-repository.ts` | 列表、详情、PATCH、删除。`byte_size` 从字符串收成 number |
| `apps/api/src/dao/upload-session-repository.ts` | 会话、分片、`FOR UPDATE`、`completing`、advisory lock、完成插入 |
| `apps/api/src/dao/index.ts` | 导出两个仓储 |
| `apps/api/src/adapters/library/messages.ts` | 固定文案与 `LibraryResult` |
| `apps/api/src/adapters/library/deps.ts` | `LibraryDeps` 六个字段：`photos`、`sessions`、`storage`、`ids`、`signedUrlTtlSeconds`、`log` |
| `apps/api/src/adapters/library/error-name.ts` | 只取 `error.name` |
| `apps/api/src/adapters/library/photo-response.ts` | `PhotoResponse` 与签发 |
| `apps/api/src/adapters/library/create-upload.ts` | 清扫、创建 multipart、插入会话 |
| `apps/api/src/adapters/library/upload-part.ts` | 锁内上传分片 |
| `apps/api/src/adapters/library/complete-upload.ts` | completing 栅栏与插入照片 |
| `apps/api/src/adapters/library/abort-upload.ts` | 中止 |
| `apps/api/src/adapters/library/list-photos.ts` | 键集分页 |
| `apps/api/src/adapters/library/get-photo.ts` | 详情 |
| `apps/api/src/adapters/library/patch-photo.ts` | 元数据补丁 |
| `apps/api/src/adapters/library/delete-photo.ts` | 先行后对象 |
| `apps/api/src/adapters/index.ts` | 导出库用例 |
| `apps/api/src/interfaces/http/register-photos.ts` | 八个路由。签名 `(app, identity, library, clock)` |
| `apps/api/src/interfaces/http/send-library-error.ts` | 库错误体。不放宽身份用的 `AuthError` |
| `apps/api/src/interfaces/http/error-handler.ts` | 仅分片路由映射 413 与非法媒体类型 |
| `apps/api/src/interfaces/http/auth-logger.ts` | redact 补上 `originalUrl`，保留原路径 |
| `apps/api/src/interfaces/index.ts` | 导出 `registerPhotoRoutes` |
| `apps/api/src/wire-library.ts` | `createLibraryDeps` 返回上述 `LibraryDeps`。禁止移入五层目录 |
| `apps/api/src/app.ts` | 可选 `storage` 与 `signedUrlTtlSeconds` |
| `apps/api/src/index.ts` | 先 `loadStorageConfig`，失败则退出 |
| `apps/api/test/upload-schema.test.ts` | DDL 与 env 示例 |
| `apps/api/test/library-domain.test.ts` | 纯规则 |
| `apps/api/test/storage-config.test.ts` | TTL 与启动拒绝 |
| `apps/api/test/fake-storage.test.ts` | 假存储行为 |
| `apps/api/test/s3-storage.test.ts` | 用桩客户端断言命令，不连接真实 S3 |
| `apps/api/test/library-dao.test.ts` | 仓储、`FOR UPDATE`、advisory lock、bigint |
| `apps/api/test/library-upload.test.ts` | 创建、分片、completing、中止 |
| `apps/api/test/library-photos.test.ts` | 列表、PATCH、删除与签名 |
| `apps/api/test/personal-library.test.ts` | 设计 §10 的 HTTP 验收 |
| `apps/api/test/library-boundaries.test.ts` | 领域源码不出现 S3 SDK 与 `Date.now` |

不创建 `apps/web` 下的文件，不新增预签名上传路由，不新增限流模块。

---

### Task 1: upload_sessions DDL、签名 TTL 示例与阶段开工

**Files:**
- Modify: `deploy/db/schema.sql`
- Modify: `deploy/env.example`
- Modify: `deploy/README.md`
- Modify: `specs/SPEC.md`
- Modify: `specs/phases/02-personal-library.md`
- Test: `apps/api/test/upload-schema.test.ts`

**Interfaces:**
- Consumes: 现有 `applySchema` 会执行整个 `deploy/db/schema.sql`
- Produces: 表 `upload_sessions`、`upload_parts` 与索引 `idx_upload_sessions_owner_status`。`photos` 列保持不变。环境示例出现 `S3_SIGNED_URL_TTL=15m`

- [ ] **Step 1: 写会失败的结构测试**

创建 `apps/api/test/upload-schema.test.ts`：

```typescript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";

const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });

test.before(async () => {
  await applySchema(pool);
});

test.after(async () => {
  await pool.end();
});

test("个人库上传表带 completing 状态与 32 MiB 约束", async () => {
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name IN ('upload_sessions', 'upload_parts')
     ORDER BY table_name`,
  );
  assert.deepEqual(tables.rows.map((row) => row.table_name), ["upload_parts", "upload_sessions"]);

  const constraints = await pool.query(
    `SELECT conname FROM pg_constraint
     WHERE conname IN (
       'upload_sessions_status',
       'upload_sessions_byte_size',
       'upload_parts_part_number',
       'upload_parts_byte_size'
     )
     ORDER BY conname`,
  );
  assert.deepEqual(constraints.rows.map((row) => row.conname), [
    "upload_parts_byte_size",
    "upload_parts_part_number",
    "upload_sessions_byte_size",
    "upload_sessions_status",
  ]);

  const status = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def
     FROM pg_constraint WHERE conname = 'upload_sessions_status'`,
  );
  assert.match(String(status.rows[0].def), /completing/);

  const index = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_upload_sessions_owner_status'`,
  );
  assert.equal(index.rowCount, 1);

  const photoColumns = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'photos' AND column_name IN ('thumb_key', 'error_message', 'object_key')
     ORDER BY column_name`,
  );
  assert.deepEqual(photoColumns.rows.map((row) => row.column_name), ["error_message", "object_key", "thumb_key"]);
});

test("env 示例声明签名 TTL 的默认值与 7 天上限", async () => {
  const example = await readFile(new URL("../../../deploy/env.example", import.meta.url), "utf8");
  assert.match(example, /^S3_SIGNED_URL_TTL=15m$/m);
  assert.match(example, /省略或空白时为 15m/);
  assert.match(example, /大于 7 天（604800 秒）/);
  const readme = await readFile(new URL("../../../deploy/README.md", import.meta.url), "utf8");
  assert.match(readme, /S3_SIGNED_URL_TTL/);
  assert.match(readme, /不读取 `S3_PUBLIC_BASE_URL`/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/upload-schema.test.ts
```

Expected: 退出码非 0。`relation "upload_sessions" does not exist` 或断言找不到 `S3_SIGNED_URL_TTL=15m`。

- [ ] **Step 3: 追加 DDL、示例与开工状态**

把下面的 SQL 原样追加到 `deploy/db/schema.sql` 里 `idx_photos_status` 那一行之后、嵌入段之前：

```sql
-- 进行中的原图上传。对象存储完成之后才插入 photos。
-- status: open | completing | completed | aborted
CREATE TABLE IF NOT EXISTS upload_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id             UUID NOT NULL UNIQUE,
  object_key           TEXT NOT NULL,
  content_type         TEXT NOT NULL,
  byte_size            BIGINT NOT NULL,
  s3_upload_id         TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open',
  object_completed_at  TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT upload_sessions_status CHECK (status IN ('open', 'completing', 'completed', 'aborted')),
  CONSTRAINT upload_sessions_byte_size CHECK (byte_size >= 1 AND byte_size <= 33554432)
);

CREATE TABLE IF NOT EXISTS upload_parts (
  upload_session_id UUID NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_number       INT NOT NULL,
  etag              TEXT NOT NULL,
  byte_size         BIGINT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_session_id, part_number),
  CONSTRAINT upload_parts_part_number CHECK (part_number >= 1 AND part_number <= 10000),
  CONSTRAINT upload_parts_byte_size CHECK (byte_size >= 1 AND byte_size <= 33554432)
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_owner_status
  ON upload_sessions(owner_id, status, expires_at);
```

在 `deploy/env.example` 的 `S3_FORCE_PATH_STYLE=false` 之后、`S3_PUBLIC_BASE_URL` 之前插入：

```text
# 签名 GET 的有效期。省略或空白时为 15m。语法与 JWT_TTL 相同（正整数加 s、m 或 d）。大于 7 天（604800 秒）时进程拒绝启动。
S3_SIGNED_URL_TTL=15m
```

在 `deploy/README.md` 里「Phase 1 的 `schema.sql` 在身份段增加 `refresh_tokens`。」那段之后追加：

```markdown
Phase 2 在 `schema.sql` 的个人库段追加 `upload_sessions` 与 `upload_parts`。签名 GET 的有效期是 `S3_SIGNED_URL_TTL`，默认 `15m`，语法与 `JWT_TTL` 相同，超过 7 天时进程拒绝启动。本阶段不读取 `S3_PUBLIC_BASE_URL`。
```

`specs/SPEC.md` 阶段 2 那一行改为：

```markdown
| 2 | [phases/02-personal-library.md](phases/02-personal-library.md) | in_progress | 个人照片增删改查与对象存储 |
```

`specs/phases/02-personal-library.md` 的状态行改为：

```markdown
**状态：** in_progress
```

不要勾选验收框。不要改设计文件的「状态：已定稿（待实现）」。不要改 `photos` 的列。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/upload-schema.test.ts
```

Expected: 退出码 0，`# fail 0`。

- [ ] **Step 5: Commit**

```bash
git add deploy/db/schema.sql deploy/env.example deploy/README.md specs/SPEC.md specs/phases/02-personal-library.md apps/api/test/upload-schema.test.ts
git commit -m "feat: 增加上传会话表与签名 URL 有效期"
```

---

### Task 2: 领域模型、白名单、分片规则、补丁与端口

**Files:**
- Create: `apps/api/src/domain/library/constants.ts`
- Create: `apps/api/src/domain/library/model.ts`
- Create: `apps/api/src/domain/library/content-type.ts`
- Create: `apps/api/src/domain/library/object-key.ts`
- Create: `apps/api/src/domain/library/parts.ts`
- Create: `apps/api/src/domain/library/metadata-patch.ts`
- Create: `apps/api/src/domain/library/visibility.ts`
- Create: `apps/api/src/domain/library/cursor.ts`
- Create: `apps/api/src/domain/library/ports.ts`
- Modify: `apps/api/src/domain/library/index.ts`
- Test: `apps/api/test/library-domain.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `MAX_PHOTO_BYTES = 33554432`
  - `MIN_NON_FINAL_PART_BYTES = 5242880`
  - `MAX_COMPLETE_PARTS = 7`
  - `MAX_PART_NUMBER = 10000`
  - `UPLOAD_TTL_MS = 86_400_000`
  - `CONTENT_TYPES` 为 Global Constraints 里的九个字符串
  - `normalizeContentType(raw: string): string | null`
  - `photoObjectKey(userId: string, photoId: string): string`
  - `validatePartsForComplete(parts: PartSize[], declaredByteSize: number): "ok" | "invalid"`
  - `PartSize = { partNumber: number; byteSize: number }`
  - `normalizeMetadataPatch(body: Record<string, unknown>): { ok: true; patch: MetadataPatch } | { ok: false; message: string }`
  - `MetadataPatch = { description?: string | null; tags?: string[]; takenAt?: Date | null; locationText?: string | null; latitude?: number | null; longitude?: number | null }`
  - `isVisiblePhoto(photo: { ownerId: string } | null, userId: string): boolean`
  - `encodePhotoCursor(createdAt: Date, id: string): string`
  - `decodePhotoCursor(raw: string): { createdAt: Date; id: string } | null`
  - `parsePhotoLimit(raw: string | undefined): number | "invalid"`
  - `LibraryActor = { userId: string; credentialKind: "password_session" | "api_key"; credentialId: string }`
  - `ObjectStorage`、`PhotoRepository`、`UploadSessionRepository`、`LibraryLog` 的方法签名以本任务 `ports.ts` 为准

- [ ] **Step 1: 写会失败的纯规则测试**

创建 `apps/api/test/library-domain.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { CONTENT_TYPES, normalizeContentType } from "../src/domain/library/content-type.js";
import { MAX_PHOTO_BYTES, MIN_NON_FINAL_PART_BYTES } from "../src/domain/library/constants.js";
import { decodePhotoCursor, encodePhotoCursor, parsePhotoLimit } from "../src/domain/library/cursor.js";
import { normalizeMetadataPatch } from "../src/domain/library/metadata-patch.js";
import { photoObjectKey } from "../src/domain/library/object-key.js";
import { validatePartsForComplete } from "../src/domain/library/parts.js";
import { isVisiblePhoto } from "../src/domain/library/visibility.js";

const USER = "11111111-1111-4111-8111-111111111111";
const PHOTO = "22222222-2222-4222-8222-222222222222";

test("白名单接受九种类型，拒绝参数、空格写法以外的大小写已折叠", () => {
  assert.deepEqual([...CONTENT_TYPES], [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/x-canon-cr2",
    "image/x-nikon-nef",
    "image/x-sony-arw",
    "image/x-adobe-dng",
  ]);
  assert.equal(normalizeContentType(" Image/JPEG "), "image/jpeg");
  assert.equal(normalizeContentType("image/heic"), "image/heic");
  assert.equal(normalizeContentType("image/x-adobe-dng"), "image/x-adobe-dng");
  assert.equal(normalizeContentType("image/jpeg; charset=binary"), null);
  assert.equal(normalizeContentType("image/gif"), null);
  assert.equal(MAX_PHOTO_BYTES, 33_554_432);
  assert.equal(MIN_NON_FINAL_PART_BYTES, 5_242_880);
});

test("对象键使用小写 UUID，拒绝桶名和前导斜杠", () => {
  assert.equal(photoObjectKey(USER, PHOTO), `owners/${USER}/photos/${PHOTO}/original`);
  assert.equal(photoObjectKey(USER, PHOTO).startsWith("/"), false);
  assert.throws(() => photoObjectKey(USER.toUpperCase(), PHOTO), /对象键标识不合法/);
});

test("分片完成规则", () => {
  assert.equal(validatePartsForComplete([{ partNumber: 1, byteSize: 10 }], 10), "ok");
  assert.equal(
    validatePartsForComplete(
      [
        { partNumber: 1, byteSize: MIN_NON_FINAL_PART_BYTES },
        { partNumber: 2, byteSize: 10 },
      ],
      MIN_NON_FINAL_PART_BYTES + 10,
    ),
    "ok",
  );
  assert.equal(
    validatePartsForComplete(
      [
        { partNumber: 2, byteSize: 10 },
        { partNumber: 1, byteSize: MIN_NON_FINAL_PART_BYTES },
      ],
      MIN_NON_FINAL_PART_BYTES + 10,
    ),
    "ok",
  );
  assert.equal(validatePartsForComplete([{ partNumber: 1, byteSize: 40 }, { partNumber: 2, byteSize: 60 }], 100), "invalid");
  assert.equal(validatePartsForComplete([{ partNumber: 1, byteSize: 10 }], 11), "invalid");
  assert.equal(validatePartsForComplete([{ partNumber: 1, byteSize: 10 }, { partNumber: 3, byteSize: 10 }], 20), "invalid");
  assert.equal(validatePartsForComplete([], 0), "invalid");
  const eight = Array.from({ length: 8 }, (_, index) => ({ partNumber: index + 1, byteSize: MIN_NON_FINAL_PART_BYTES }));
  assert.equal(validatePartsForComplete(eight, 8 * MIN_NON_FINAL_PART_BYTES), "invalid");
});

test("元数据补丁按固定顺序拒绝，并规范化合法字段", () => {
  const illegal = normalizeMetadataPatch({ contentType: "image/png", description: "x" });
  assert.deepEqual(illegal, { ok: false, message: "请求不合法" });
  assert.deepEqual(normalizeMetadataPatch({ description: "  \u0001  " }), { ok: false, message: "描述不合法" });
  assert.deepEqual(normalizeMetadataPatch({ description: "  海边\n\t " }), { ok: true, patch: { description: "海边\n\t" } });
  assert.deepEqual(normalizeMetadataPatch({ description: "   " }), { ok: true, patch: { description: null } });
  assert.deepEqual(normalizeMetadataPatch({ description: "a".repeat(4001) }), { ok: false, message: "描述不合法" });
  assert.deepEqual(normalizeMetadataPatch({ tags: null }), { ok: false, message: "标签不合法" });
  assert.deepEqual(normalizeMetadataPatch({ tags: [" 海 ", "海", "山"] }), { ok: true, patch: { tags: ["海", "山"] } });
  assert.deepEqual(normalizeMetadataPatch({ tags: [] }), { ok: true, patch: { tags: [] } });
  assert.deepEqual(normalizeMetadataPatch({ tags: ["a\n"] }), { ok: false, message: "标签不合法" });
  assert.deepEqual(normalizeMetadataPatch({ takenAt: "2026-11-04" }), { ok: false, message: "拍摄时间不合法" });
  assert.deepEqual(normalizeMetadataPatch({ takenAt: null }).ok, true);
  const taken = normalizeMetadataPatch({ takenAt: "2026-11-04T02:31:00.000Z" });
  assert.equal(taken.ok, true);
  if (taken.ok) assert.equal(taken.patch.takenAt?.toISOString(), "2026-11-04T02:31:00.000Z");
  assert.deepEqual(normalizeMetadataPatch({ locationText: "  " }), { ok: true, patch: { locationText: null } });
  assert.deepEqual(normalizeMetadataPatch({ locationText: "x".repeat(501) }), { ok: false, message: "地点不合法" });
  assert.deepEqual(normalizeMetadataPatch({ latitude: 1 }), { ok: false, message: "经纬度须成对出现" });
  assert.deepEqual(normalizeMetadataPatch({ latitude: null, longitude: 1 }), { ok: false, message: "经纬度须成对出现" });
  assert.deepEqual(normalizeMetadataPatch({ latitude: null, longitude: null }), {
    ok: true,
    patch: { latitude: null, longitude: null },
  });
  assert.deepEqual(normalizeMetadataPatch({ latitude: 91, longitude: 0 }), { ok: false, message: "经纬度超出范围" });
  assert.deepEqual(normalizeMetadataPatch({ latitude: -90, longitude: 180 }), {
    ok: true,
    patch: { latitude: -90, longitude: 180 },
  });
  assert.deepEqual(normalizeMetadataPatch({}).ok && normalizeMetadataPatch({}).patch, { ok: true, patch: {} }.patch);
});

test("不可见照片与分页游标", () => {
  assert.equal(isVisiblePhoto(null, USER), false);
  assert.equal(isVisiblePhoto({ ownerId: PHOTO }, USER), false);
  assert.equal(isVisiblePhoto({ ownerId: USER }, USER), true);
  assert.equal(parsePhotoLimit(undefined), 50);
  assert.equal(parsePhotoLimit("1"), 1);
  assert.equal(parsePhotoLimit("100"), 100);
  assert.equal(parsePhotoLimit("01"), "invalid");
  assert.equal(parsePhotoLimit("0"), "invalid");
  assert.equal(parsePhotoLimit("101"), "invalid");
  const createdAt = new Date("2026-11-04T02:31:00.000Z");
  const encoded = encodePhotoCursor(createdAt, PHOTO);
  assert.equal(encoded.includes("="), false);
  assert.deepEqual(decodePhotoCursor(encoded), { createdAt, id: PHOTO });
  assert.equal(decodePhotoCursor(`${encoded}=`), null);
  assert.equal(decodePhotoCursor("not-base64url"), null);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
npx tsx --test apps/api/test/library-domain.test.ts
```

Expected: 退出码非 0。模块 `content-type.js` 不存在。

- [ ] **Step 3: 写最小实现**

`apps/api/src/domain/library/constants.ts`：

```typescript
export const MAX_PHOTO_BYTES = 33_554_432;
export const MIN_NON_FINAL_PART_BYTES = 5_242_880;
export const MAX_COMPLETE_PARTS = 7;
export const MAX_PART_NUMBER = 10_000;
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
```

`apps/api/src/domain/library/model.ts`：

```typescript
export type LibraryActor = {
  userId: string;
  credentialKind: "password_session" | "api_key";
  credentialId: string;
};

export type UploadStatus = "open" | "completing" | "completed" | "aborted";

export type Photo = {
  id: string;
  ownerId: string;
  objectKey: string;
  thumbKey: string | null;
  contentType: string;
  byteSize: number;
  takenAt: Date | null;
  locationText: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  tags: string[];
  status: string;
  sourceUserId: string | null;
  sourceKeyId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MetadataPatch = {
  description?: string | null;
  tags?: string[];
  takenAt?: Date | null;
  locationText?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type UploadSession = {
  id: string;
  ownerId: string;
  photoId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  s3UploadId: string;
  status: UploadStatus;
  objectCompletedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type UploadPartRecord = {
  partNumber: number;
  etag: string;
  byteSize: number;
};

export type PartSize = { partNumber: number; byteSize: number };
```

`apps/api/src/domain/library/content-type.ts`：

```typescript
export const CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/x-canon-cr2",
  "image/x-nikon-nef",
  "image/x-sony-arw",
  "image/x-adobe-dng",
] as const;

const ALLOWED = new Set<string>(CONTENT_TYPES);

export function normalizeContentType(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.includes(";") || !ALLOWED.has(trimmed)) return null;
  return trimmed;
}
```

`apps/api/src/domain/library/object-key.ts`：

```typescript
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function photoObjectKey(userId: string, photoId: string): string {
  if (!UUID.test(userId) || !UUID.test(photoId)) {
    throw new Error("对象键标识不合法");
  }
  return `owners/${userId}/photos/${photoId}/original`;
}
```

`apps/api/src/domain/library/parts.ts`：

```typescript
import { MAX_COMPLETE_PARTS, MAX_PHOTO_BYTES, MIN_NON_FINAL_PART_BYTES } from "./constants.js";
import type { PartSize } from "./model.js";

export function validatePartsForComplete(parts: PartSize[], declaredByteSize: number): "ok" | "invalid" {
  if (parts.length < 1 || parts.length > MAX_COMPLETE_PARTS) return "invalid";
  const sorted = [...parts].sort((left, right) => left.partNumber - right.partNumber);
  let sum = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const part = sorted[index];
    if (!part || part.partNumber !== index + 1) return "invalid";
    if (part.byteSize < 1 || part.byteSize > MAX_PHOTO_BYTES) return "invalid";
    const last = index === sorted.length - 1;
    if (!last && part.byteSize < MIN_NON_FINAL_PART_BYTES) return "invalid";
    sum += part.byteSize;
  }
  if (sum !== declaredByteSize || sum > MAX_PHOTO_BYTES) return "invalid";
  return "ok";
}
```

`apps/api/src/domain/library/metadata-patch.ts`：

```typescript
import type { MetadataPatch } from "./model.js";

const ALLOWED = new Set(["description", "tags", "takenAt", "locationText", "latitude", "longitude"]);
const TAKEN_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function forbiddenControls(value: string, allowTabAndNewline: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x7f) return true;
    if (code >= 0x20) continue;
    if (allowTabAndNewline && (code === 0x09 || code === 0x0a)) continue;
    return true;
  }
  return false;
}

function textField(value: unknown, max: number): string | null | "invalid" {
  if (value === null) return null;
  if (typeof value !== "string") return "invalid";
  if (forbiddenControls(value, true)) return "invalid";
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) return "invalid";
  return trimmed;
}

export function normalizeMetadataPatch(body: Record<string, unknown>): { ok: true; patch: MetadataPatch } | { ok: false; message: string } {
  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) return { ok: false, message: "请求不合法" };
  }
  const patch: MetadataPatch = {};
  if ("description" in body) {
    const description = textField(body.description, 4000);
    if (description === "invalid") return { ok: false, message: "描述不合法" };
    patch.description = description;
  }
  if ("tags" in body) {
    if (!Array.isArray(body.tags) || body.tags.length > 32) return { ok: false, message: "标签不合法" };
    const tags: string[] = [];
    for (const item of body.tags) {
      if (typeof item !== "string" || forbiddenControls(item, false)) return { ok: false, message: "标签不合法" };
      const trimmed = item.trim();
      if (trimmed.length < 1 || trimmed.length > 64) return { ok: false, message: "标签不合法" };
      if (!tags.includes(trimmed)) tags.push(trimmed);
    }
    patch.tags = tags;
  }
  if ("takenAt" in body) {
    if (body.takenAt === null) {
      patch.takenAt = null;
    } else if (typeof body.takenAt !== "string" || !TAKEN_AT.test(body.takenAt)) {
      return { ok: false, message: "拍摄时间不合法" };
    } else {
      const takenAt = new Date(body.takenAt);
      if (Number.isNaN(takenAt.getTime())) return { ok: false, message: "拍摄时间不合法" };
      patch.takenAt = takenAt;
    }
  }
  if ("locationText" in body) {
    const locationText = textField(body.locationText, 500);
    if (locationText === "invalid") return { ok: false, message: "地点不合法" };
    patch.locationText = locationText;
  }
  const hasLatitude = "latitude" in body;
  const hasLongitude = "longitude" in body;
  if (hasLatitude !== hasLongitude) return { ok: false, message: "经纬度须成对出现" };
  if (hasLatitude && hasLongitude) {
    const latitude = body.latitude;
    const longitude = body.longitude;
    if (latitude === null && longitude === null) {
      patch.latitude = null;
      patch.longitude = null;
    } else if (typeof latitude !== "number" || typeof longitude !== "number") {
      return { ok: false, message: "经纬度须成对出现" };
    } else if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return { ok: false, message: "请求不合法" };
    } else if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return { ok: false, message: "经纬度超出范围" };
    } else {
      patch.latitude = latitude;
      patch.longitude = longitude;
    }
  }
  return { ok: true, patch };
}
```

`apps/api/src/domain/library/visibility.ts`：

```typescript
export function isVisiblePhoto(photo: { ownerId: string } | null, userId: string): boolean {
  return photo !== null && photo.ownerId === userId;
}
```

`apps/api/src/domain/library/cursor.ts`：

```typescript
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const LIMIT = /^(?:[1-9][0-9]?|100)$/;

export function parsePhotoLimit(raw: string | undefined): number | "invalid" {
  if (raw === undefined) return 50;
  if (!LIMIT.test(raw)) return "invalid";
  return Number(raw);
}

export function encodePhotoCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}\n${id}`, "utf8").toString("base64url");
}

export function decodePhotoCursor(raw: string): { createdAt: Date; id: string } | null {
  if (raw.includes("=") || raw.length === 0) return null;
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const splitAt = text.indexOf("\n");
  if (splitAt <= 0) return null;
  const createdAtRaw = text.slice(0, splitAt);
  const id = text.slice(splitAt + 1);
  if (!INSTANT.test(createdAtRaw) || !UUID.test(id)) return null;
  const createdAt = new Date(createdAtRaw);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: id.toLowerCase() };
}
```

`apps/api/src/domain/library/ports.ts`：

```typescript
import type { LibraryActor, MetadataPatch, Photo, UploadPartRecord, UploadSession, UploadStatus } from "./model.js";

export type ObjectStorage = {
  createMultipartUpload(input: { key: string; contentType: string }): Promise<{ uploadId: string }>;
  uploadPart(input: { key: string; uploadId: string; partNumber: number; body: Buffer }): Promise<{ etag: string; byteSize: number }>;
  completeMultipartUpload(input: {
    key: string;
    uploadId: string;
    parts: { partNumber: number; etag: string }[];
  }): Promise<void>;
  abortMultipartUpload(input: { key: string; uploadId: string }): Promise<void>;
  headObject(input: { key: string }): Promise<{ byteSize: number } | null>;
  deleteObject(input: { key: string }): Promise<void>;
  presignGet(input: { key: string; expiresInSeconds: number; now: Date }): Promise<{ url: string; expiresAt: Date }>;
};

export type PhotoRepository = {
  findById(id: string): Promise<Photo | null>;
  listOwned(input: { ownerId: string; limit: number; cursor: { createdAt: Date; id: string } | null }): Promise<Photo[]>;
  updateOwned(id: string, ownerId: string, patch: MetadataPatch, updatedAt: Date): Promise<Photo | null>;
  deleteOwned(id: string, ownerId: string): Promise<{ objectKey: string; thumbKey: string | null } | null>;
};

export type NewUploadSession = {
  id: string;
  ownerId: string;
  photoId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  s3UploadId: string;
  expiresAt: Date;
  createdAt: Date;
};

export type UploadSessionTx = {
  listParts(sessionId: string): Promise<UploadPartRecord[]>;
  upsertPart(sessionId: string, part: UploadPartRecord): Promise<void>;
  setCompleting(sessionId: string, now: Date): Promise<void>;
  markAborted(sessionId: string, now: Date): Promise<void>;
};

export type CompletionLock = { release(): Promise<void> };

export type InsertCompletedPhoto = {
  sessionId: string;
  photoId: string;
  ownerId: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sourceUserId: string;
  sourceKeyId: string | null;
  now: Date;
};

export type UploadSessionRepository = {
  insert(session: NewUploadSession): Promise<void>;
  listExpiredOpen(ownerId: string, now: Date): Promise<UploadSession[]>;
  transactById(id: string, mutate: (row: UploadSession | null, tx: UploadSessionTx) => Promise<void>): Promise<void>;
  tryCompletionLock(sessionId: string): Promise<CompletionLock | null>;
  markObjectCompleted(id: string, at: Date): Promise<void>;
  reopenIfNoObject(id: string, now: Date): Promise<"reopened" | "kept">;
  insertPhotoAndComplete(input: InsertCompletedPhoto): Promise<"inserted" | "exists">;
};

export type LibraryLogFields = {
  userId?: string;
  photoId?: string;
  objectKey?: string;
  uploadSessionId?: string;
  partNumber?: number;
  byteSize?: number;
  reason?: "client" | "expired";
  errorName?: string;
};

export type LibraryLog = {
  warn(message: string, fields: LibraryLogFields): void;
};

export type { LibraryActor, UploadStatus };
```

把 `apps/api/src/domain/library/index.ts` 换成：

```typescript
/** 照片库上下文（Phase 2–3）：个人照片、元数据、处理状态。 */
export const LIBRARY_CONTEXT = "library" as const;

export { CONTENT_TYPES, normalizeContentType } from "./content-type.js";
export { MAX_COMPLETE_PARTS, MAX_PART_NUMBER, MAX_PHOTO_BYTES, MIN_NON_FINAL_PART_BYTES, UPLOAD_TTL_MS } from "./constants.js";
export { decodePhotoCursor, encodePhotoCursor, parsePhotoLimit } from "./cursor.js";
export { normalizeMetadataPatch } from "./metadata-patch.js";
export { photoObjectKey } from "./object-key.js";
export { validatePartsForComplete } from "./parts.js";
export { isVisiblePhoto } from "./visibility.js";
export type {
  CompletionLock,
  InsertCompletedPhoto,
  LibraryLog,
  LibraryLogFields,
  NewUploadSession,
  ObjectStorage,
  PhotoRepository,
  UploadSessionRepository,
  UploadSessionTx,
} from "./ports.js";
export type {
  LibraryActor,
  MetadataPatch,
  PartSize,
  Photo,
  UploadPartRecord,
  UploadSession,
  UploadStatus,
} from "./model.js";
```

这些文件不得 import `domain/identity`、`fastify`、`pg` 或任何 AWS 包。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
npx tsx --test apps/api/test/library-domain.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 两者退出码都是 0。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/domain/library apps/api/test/library-domain.test.ts
git commit -m "feat: 添加个人库领域规则与端口"
```

---

### Task 3: 存储配置、内存假存储与 S3 适配

**Files:**
- Create: `apps/api/src/gateways/storage/config.ts`
- Create: `apps/api/src/gateways/storage/fake-object-storage.ts`
- Create: `apps/api/src/gateways/storage/s3-object-storage.ts`
- Modify: `apps/api/src/gateways/storage/index.ts`
- Modify: `apps/api/src/gateways/index.ts`
- Modify: `apps/api/package.json`
- Modify: `package-lock.json`
- Test: `apps/api/test/storage-config.test.ts`
- Test: `apps/api/test/fake-storage.test.ts`
- Test: `apps/api/test/s3-storage.test.ts`

**Interfaces:**
- Consumes: `ObjectStorage`、`parseDurationSeconds(value: string): number`
- Produces:
  - `StorageConfig = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean; signedUrlTtlSeconds: number }`
  - `loadStorageConfig(env: NodeJS.ProcessEnv): StorageConfig`
  - `createFakeObjectStorage(): FakeObjectStorage`
  - `createStorageGate(): StorageGate`
  - `createS3ObjectStorage(config: StorageConfig, client?: S3CommandClient): ObjectStorage`
  - `StorageGate = { entered: Promise<void>; signalEntered(): void; wait(): Promise<void>; release(): void }`
  - `S3CommandClient = { send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>> }`

- [ ] **Step 1: 写会失败的配置、假存储和命令映射测试**

创建 `apps/api/test/storage-config.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { loadStorageConfig } from "../src/gateways/storage/config.js";

const base = {
  S3_ENDPOINT: "https://cos.ap-singapore.myqcloud.com",
  S3_REGION: "ap-singapore",
  S3_BUCKET: "album",
  S3_ACCESS_KEY_ID: "AKID",
  S3_SECRET_ACCESS_KEY: "SECRET",
};

test("空白 TTL 与 15m 都是 900 秒，超过 7 天拒绝", () => {
  assert.equal(loadStorageConfig(base).signedUrlTtlSeconds, 900);
  assert.equal(loadStorageConfig({ ...base, S3_SIGNED_URL_TTL: "   " }).signedUrlTtlSeconds, 900);
  assert.equal(loadStorageConfig({ ...base, S3_SIGNED_URL_TTL: "15m" }).signedUrlTtlSeconds, 900);
  assert.equal(loadStorageConfig({ ...base, S3_SIGNED_URL_TTL: "7d" }).signedUrlTtlSeconds, 604_800);
  assert.throws(() => loadStorageConfig({ ...base, S3_SIGNED_URL_TTL: "604801s" }), /S3_SIGNED_URL_TTL 超过 7 天/);
  assert.throws(() => loadStorageConfig({ ...base, S3_SIGNED_URL_TTL: "8d" }), /S3_SIGNED_URL_TTL 超过 7 天/);
  assert.throws(() => loadStorageConfig({ ...base, S3_SIGNED_URL_TTL: "soon" }), /S3_SIGNED_URL_TTL 无效/);
});

test("缺密钥、非法 endpoint 与 path style 只点名变量", () => {
  assert.throws(() => loadStorageConfig({ ...base, S3_SECRET_ACCESS_KEY: " " }), /S3_SECRET_ACCESS_KEY 缺失/);
  assert.throws(() => loadStorageConfig({ ...base, S3_ENDPOINT: "https://key:secret@example.com" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "S3_ENDPOINT 无效");
    assert.equal(error.message.includes("secret"), false);
    assert.equal(error.message.includes("key"), false);
    return true;
  });
  assert.throws(() => loadStorageConfig({ ...base, S3_FORCE_PATH_STYLE: "TRUE" }), /S3_FORCE_PATH_STYLE 无效/);
  assert.equal(loadStorageConfig({ ...base, S3_FORCE_PATH_STYLE: "true" }).forcePathStyle, true);
  assert.equal(loadStorageConfig(base).forcePathStyle, false);
  const loaded = loadStorageConfig(base);
  assert.equal(Object.hasOwn(loaded, "publicBaseUrl"), false);
});
```

创建 `apps/api/test/fake-storage.test.ts`：

```typescript
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
```

创建 `apps/api/test/s3-storage.test.ts`：

```typescript
import assert from "node:assert/strict";
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
```

`AbortMultipartUploadCommand` 抛出 `name === "NoSuchUpload"` 时方法成功返回。`DeleteObjectCommand` 与 `HeadObjectCommand` 的 `NotFound` 按上面的断言处理。其他 `name` 必须原样抛出。测试不得读取 `error.message` 来做分支。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
npx tsx --test apps/api/test/storage-config.test.ts apps/api/test/fake-storage.test.ts apps/api/test/s3-storage.test.ts
```

Expected: 退出码非 0。`config.js` 或 `fake-object-storage.js` 不存在。

- [ ] **Step 3: 安装 SDK 并实现网关**

Run:

```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner -w apps/api
```

Expected: `apps/api/package.json` 的 `dependencies` 出现这两个包，`package-lock.json` 更新。不要加入 `minio` 或 `busboy`。

`apps/api/src/gateways/storage/config.ts`：

```typescript
import { parseDurationSeconds } from "../auth/config.js";

export type StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  signedUrlTtlSeconds: number;
};

const MAX_TTL_SECONDS = 604_800;

export function loadStorageConfig(env: NodeJS.ProcessEnv): StorageConfig {
  return {
    endpoint: parseEndpoint(env.S3_ENDPOINT),
    region: requiredText(env.S3_REGION, "S3_REGION"),
    bucket: requiredText(env.S3_BUCKET, "S3_BUCKET"),
    accessKeyId: requiredText(env.S3_ACCESS_KEY_ID, "S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredText(env.S3_SECRET_ACCESS_KEY, "S3_SECRET_ACCESS_KEY"),
    forcePathStyle: parseForcePathStyle(env.S3_FORCE_PATH_STYLE),
    signedUrlTtlSeconds: parseTtl(env.S3_SIGNED_URL_TTL),
  };
}

function requiredText(value: string | undefined, name: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`${name} 缺失`);
  return trimmed;
}

function parseEndpoint(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error("S3_ENDPOINT 缺失");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("S3_ENDPOINT 无效");
  }
  if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("S3_ENDPOINT 无效");
  }
  return trimmed;
}

function parseForcePathStyle(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === "false") return false;
  if (trimmed === "true") return true;
  throw new Error("S3_FORCE_PATH_STYLE 无效");
}

function parseTtl(value: string | undefined): number {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return 900;
  let seconds: number;
  try {
    seconds = parseDurationSeconds(trimmed);
  } catch {
    throw new Error("S3_SIGNED_URL_TTL 无效");
  }
  if (seconds > MAX_TTL_SECONDS) throw new Error("S3_SIGNED_URL_TTL 超过 7 天");
  return seconds;
}
```

`parseDurationSeconds` 失败时原来的文案会带上原始值。这里必须吞掉那个文案，改抛 `S3_SIGNED_URL_TTL 无效`。不要读取 `S3_PUBLIC_BASE_URL`。

`apps/api/src/gateways/storage/fake-object-storage.ts` 实现 `FakeObjectStorage implements ObjectStorage`：

- `createMultipartUpload` 生成 `uploadId`，按它保存 `{ key, contentType, parts: Map<number, Buffer> }`。
- `uploadPart` 覆盖同一 `partNumber` 的字节。返回的 `etag` 必须随覆盖变化，`byteSize` 等于 `body.length`。
- `completeMultipartUpload` 先 `completeCalls += 1`。若 `blockComplete` 设过栅栏，先 `signalEntered()` 再 `await wait()`。然后按传入的 `parts` 顺序拼接字节，存到按 key 保存的已完成对象，并删掉这次 multipart 记录。找不到 upload 时抛 `Object.assign(new Error("hidden"), { name: "NoSuchUpload" })`，`message` 可以是任意文本，调用方不得记录它。
- `abortMultipartUpload` 在 upload 已不存在时直接返回。存在时只删 multipart 记录，不删已完成对象。`abortCount += 1`。
- `headObject` 有已完成对象则返回 `{ byteSize }`，否则 `null`。
- `deleteObject` 先把 key 推入 `deletedKeys`。`failDelete === true` 时抛 `name` 为 `AccessDenied` 的错误。否则删除已完成对象；对象本来就不存在也返回成功。
- `failAbort === true` 时，`abortMultipartUpload` 在 `abortCount += 1` 之后抛 `name` 为 `InternalError` 的错误。调用方只记 `error.name`。
- `presignGet` 不检查对象是否存在。`url` 为 `http://storage.invalid/get?key=${encodeURIComponent(key)}&exp=${Math.floor(expiresAt.getTime() / 1000)}`。`expiresAt = new Date(now.getTime() + expiresInSeconds * 1000)`。
- 另提供测试可见成员：`completeCalls`、`abortCount`、`deletedKeys`、`failDelete`、`failComplete`、`blockComplete(gate | null)`、`completedBytes(key): Buffer | null`。`failComplete === true` 时在栅栏放行后抛 `name` 为 `InternalError` 的错误，不写入已完成对象。

`createStorageGate`：

```typescript
export type StorageGate = {
  entered: Promise<void>;
  signalEntered(): void;
  wait(): Promise<void>;
  release(): void;
};

export function createStorageGate(): StorageGate {
  let signalEntered: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, signalEntered, wait, release };
}
```

`apps/api/src/gateways/storage/s3-object-storage.ts`：

```typescript
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage } from "../../domain/library/ports.js";
import type { StorageConfig } from "./config.js";

export type S3CommandClient = {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<Record<string, unknown>>;
};

export function createS3ObjectStorage(
  config: StorageConfig,
  client: S3CommandClient = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  }) as unknown as S3CommandClient,
  presign: (command: unknown, options: { expiresIn: number }) => Promise<string> = (command, options) =>
    getSignedUrl(client as never, command as never, options),
): ObjectStorage {
  const bucket = config.bucket;
  return {
    async createMultipartUpload(input) {
      const result = await client.send(new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: input.key,
        ContentType: input.contentType,
      }));
      if (typeof result.UploadId !== "string" || result.UploadId.length === 0) {
        throw Object.assign(new Error("hidden"), { name: "StorageError" });
      }
      return { uploadId: result.UploadId };
    },
    async uploadPart(input) {
      const result = await client.send(new UploadPartCommand({
        Bucket: bucket,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
        Body: input.body,
      }));
      if (typeof result.ETag !== "string") throw Object.assign(new Error("hidden"), { name: "StorageError" });
      return { etag: result.ETag, byteSize: input.body.length };
    },
    async completeMultipartUpload(input) {
      await client.send(new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: input.key,
        UploadId: input.uploadId,
        MultipartUpload: {
          Parts: input.parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }));
    },
    async abortMultipartUpload(input) {
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: input.key, UploadId: input.uploadId }));
      } catch (error) {
        if (!named(error, "NoSuchUpload")) throw error;
      }
    },
    async headObject(input) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: input.key }));
        return { byteSize: Number(result.ContentLength ?? 0) };
      } catch (error) {
        if (named(error, "NotFound")) return null;
        throw error;
      }
    },
    async deleteObject(input) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: input.key }));
      } catch (error) {
        if (!named(error, "NotFound")) throw error;
      }
    },
    async presignGet(input) {
      const url = await presign(new GetObjectCommand({ Bucket: bucket, Key: input.key }), {
        expiresIn: input.expiresInSeconds,
      });
      return { url, expiresAt: new Date(input.now.getTime() + input.expiresInSeconds * 1000) };
    },
  };
}

function named(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}
```

从 `@aws-sdk/client-s3` import `GetObjectCommand`。`expiresAt` 按注入的 `now` 计算。真实 SDK 的签名时钟仍是它自己的系统时钟；测试不连接真实 S3，不断言两者相同。`named` 只看 `name`，不读 `message`。

把 `gateways/storage/index.ts` 改为导出 `STORAGE_GATEWAY`、`loadStorageConfig`、`StorageConfig`、`createFakeObjectStorage`、`createStorageGate`、`FakeObjectStorage`、`createS3ObjectStorage`。`gateways/index.ts` 再导出这些符号。保留现有 auth 导出。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
npx tsx --test apps/api/test/storage-config.test.ts apps/api/test/fake-storage.test.ts apps/api/test/s3-storage.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 两者退出码都是 0。测试过程没有对 `s3.example.com` 或真实 COS 发起连接。

- [ ] **Step 5: Commit**

```bash
git add apps/api/package.json package-lock.json apps/api/src/gateways apps/api/test/storage-config.test.ts apps/api/test/fake-storage.test.ts apps/api/test/s3-storage.test.ts
git commit -m "feat: 添加对象存储配置、假存储与 S3 适配"
```

---

### Task 4: 照片与上传会话仓储

**Files:**
- Create: `apps/api/src/dao/photo-repository.ts`
- Create: `apps/api/src/dao/upload-session-repository.ts`
- Modify: `apps/api/src/dao/index.ts`
- Test: `apps/api/test/library-dao.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `PhotoRepository`、`UploadSessionRepository`、`UploadSession`、`Photo`
- Produces:
  - `createPhotoRepository(pool: pg.Pool): PhotoRepository`
  - `createUploadSessionRepository(pool: pg.Pool): UploadSessionRepository`
  - `tryCompletionLock` 使用 `pg_try_advisory_lock(int4, int4)`，连接保持到 `release`
  - `insertPhotoAndComplete` 在同一事务插入 `photos` 并把会话改为 `completed`
  - 读出的 `byteSize` 是 JavaScript `number`，不是字符串

- [ ] **Step 1: 写会失败的仓储测试**

创建 `apps/api/test/library-dao.test.ts`。沿用身份测试的 `serial` 助手、`applySchema`、`requireDatabaseUrl` 和 `TRUNCATE TABLE users CASCADE`。每个用例先插入一个用户。`byte_size` 用 `33554432` 边界内的整数。

断言这些行为：

1. `insert` 写入调用方给出的会话 id 与 photo id。随后 `transactById` 读到的 `byteSize` 满足 `typeof byteSize === "number"`，并且 `s3UploadId` 等于插入值。
2. `transactById` 里 `setCompleting` 提交后，另一条 `pool.query` 已经能看到 `status = 'completing'`。
3. 对同一会话连续两次 `tryCompletionLock`：第二次返回 `null`；第一次 `release()` 之后第三次拿到锁。释放后连接回到池里，测试结束可以 `pool.end()`。
4. `markObjectCompleted` 之后状态仍是 `completing`，`objectCompletedAt` 非空。接着 `reopenIfNoObject` 返回 `"kept"`，状态不变。另插一条没有 `object_completed_at` 的 `completing` 会话，`reopenIfNoObject` 返回 `"reopened"` 且状态变回 `open`。
5. `insertPhotoAndComplete` 在 `sourceKeyId: null` 时写出 `photos.status = 'processing'`、`tags = {}`、`thumb_key` 与 `error_message` 为空、`source_user_id` 为用户 id、`source_key_id` 为空，并把会话改为 `completed`。再调用一次返回 `"exists"`，照片仍然只有一行。
6. `listOwned` 只返回该 `ownerId`，顺序是 `created_at DESC, id DESC`。传入 `limit: 2` 与前一页最后一条的游标时，结果严格小于这对 `(createdAt, id)`。
7. `updateOwned` 只改传入字段。空补丁不要调用它。`deleteOwned` 对别人的 `ownerId` 返回 `null`，行还在；对主人返回 `{ objectKey, thumbKey }` 并且行消失。`thumbKey` 为 `null`。

测试里的 UUID 全部小写。缺少 `DATABASE_URL` 时让 `requireDatabaseUrl()` 抛错，不要 `skip`。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/library-dao.test.ts
```

Expected: 退出码非 0。`createUploadSessionRepository` 未导出。

- [ ] **Step 3: 实现两个仓储**

`createPhotoRepository` 用下面的列表 SQL。`$2` 与 `$3` 在没有游标时传 `null`。调用方传入的 `limit` 已经是「页面大小 + 1」，仓储不再加一。

```sql
SELECT id, owner_id, object_key, thumb_key, content_type, byte_size,
       taken_at, location_text, latitude, longitude, description, tags,
       status, source_user_id, source_key_id, created_at, updated_at
FROM photos
WHERE owner_id = $1
  AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
ORDER BY created_at DESC, id DESC
LIMIT $4
```

`node-pg` 把 `BIGINT` 读成字符串。映射函数必须 `Number(row.byte_size)`，并且在结果不是安全整数时抛错。`tags` 空数组保持 `[]`。

`updateOwned` 只 `SET` 补丁里出现的列，并总是把 `updated_at` 设为参数。`WHERE id = $1 AND owner_id = $2`。没有行则返回 `null`。

`deleteOwned`：

```sql
DELETE FROM photos
WHERE id = $1 AND owner_id = $2
RETURNING object_key, thumb_key
```

没有行则返回 `null`。不要在仓储里调用对象存储。

`createUploadSessionRepository.insert` 使用调用方的 id，状态字面量是 `'open'`，`object_completed_at` 写 `NULL`。`created_at` 与 `updated_at` 都用 `session.createdAt`，不要依赖 `now()`，否则测试时钟和过期时间会对不齐。

`listExpiredOpen`：

```sql
SELECT id, owner_id, photo_id, object_key, content_type, byte_size, s3_upload_id,
       status, object_completed_at, expires_at, created_at, updated_at
FROM upload_sessions
WHERE owner_id = $1
  AND status = 'open'
  AND object_completed_at IS NULL
  AND expires_at <= $2
```

`transactById` 照 `refresh-token-repository.ts` 的 `BEGIN` / `COMMIT` / `ROLLBACK` / `release` 写法。`SELECT … FOR UPDATE` 锁会话行。事务内的 `UploadSessionTx`：

- `listParts`：`ORDER BY part_number ASC`，`byteSize` 同样收成 number。
- `upsertPart`：`INSERT … ON CONFLICT (upload_session_id, part_number) DO UPDATE SET etag = EXCLUDED.etag, byte_size = EXCLUDED.byte_size, created_at = now()`。
- `setCompleting`：

```sql
UPDATE upload_sessions
SET status = 'completing', updated_at = $2
WHERE id = $1 AND status = 'open'
```

`rowCount` 不是 1 就抛错，让事务回滚。

- `markAborted`：

```sql
UPDATE upload_sessions
SET status = 'aborted', updated_at = $2
WHERE id = $1 AND status = 'open' AND object_completed_at IS NULL
```

`rowCount` 不是 1 就抛错。

`tryCompletionLock` 的互斥键来自会话 id（`sessionId`），不是 photo id。`completionLockKeys(sessionId)` 取该 UUID 的前 16 个十六进制字符。不要用会在事务结束时释放的 `pg_advisory_xact_lock`。

```typescript
export function completionLockKeys(sessionId: string): [number, number] {
  const hex = sessionId.replaceAll("-", "");
  const hi = Number.parseInt(hex.slice(0, 8), 16) | 0;
  const lo = Number.parseInt(hex.slice(8, 16), 16) | 0;
  return [hi, lo];
}
```

拿到 `pool.connect()` 后执行 `SELECT pg_try_advisory_lock($1::int4, $2::int4) AS locked`。结果不是 `true` 时立刻 `release()` 并返回 `null`。是 `true` 时返回的 `release` 先 `pg_advisory_unlock`，再在 `finally` 里归还连接。查询抛错时也要归还连接。

`markObjectCompleted`：

```sql
UPDATE upload_sessions
SET object_completed_at = $2, updated_at = $2
WHERE id = $1 AND object_completed_at IS NULL
```

不改 `status`。

`reopenIfNoObject`：

```sql
UPDATE upload_sessions
SET status = 'open', updated_at = $2
WHERE id = $1 AND status = 'completing' AND object_completed_at IS NULL
```

`rowCount === 1` 时返回 `"reopened"`，否则 `"kept"`。

`insertPhotoAndComplete` 使用同一个 client 的一个事务。插入：

```sql
INSERT INTO photos (
  id, owner_id, object_key, thumb_key, content_type, byte_size,
  taken_at, location_text, latitude, longitude, description, tags,
  status, source_user_id, source_key_id, error_message, created_at, updated_at
) VALUES (
  $1, $2, $3, NULL, $4, $5,
  NULL, NULL, NULL, NULL, NULL, '{}',
  'processing', $6, $7, NULL, $8, $8
)
```

参数依次是 `photoId`、`ownerId`、`objectKey`、`contentType`、`byteSize`、`sourceUserId`、`sourceKeyId`、`now`。唯一冲突（`code === "23505"`）时回滚并返回 `"exists"`。然后：

```sql
UPDATE upload_sessions
SET status = 'completed', updated_at = $2
WHERE id = $1
  AND status = 'completing'
  AND object_completed_at IS NOT NULL
```

只接受已经是 `completing` 的会话。仍为 `open` 时 `rowCount` 为 0，抛错并回滚，不要把它收成 `completed`。`rowCount` 不是 1 就抛错并回滚。成功则提交并返回 `"inserted"`。

从 `dao/index.ts` 导出这两个工厂。仓储文件可以 import 领域类型，不得 import `fastify`、`@aws-sdk/*` 或适配层。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/library-dao.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 两者退出码都是 0。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/dao apps/api/test/library-dao.test.ts
git commit -m "feat: 实现照片与上传会话仓储"
```

---

### Task 5: 创建、分片、完成与中止用例

**Files:**
- Create: `apps/api/src/adapters/library/messages.ts`
- Create: `apps/api/src/adapters/library/deps.ts`
- Create: `apps/api/src/adapters/library/error-name.ts`
- Create: `apps/api/src/adapters/library/photo-response.ts`
- Create: `apps/api/src/adapters/library/abort-locked.ts`
- Create: `apps/api/src/adapters/library/create-upload.ts`
- Create: `apps/api/src/adapters/library/upload-part.ts`
- Create: `apps/api/src/adapters/library/complete-upload.ts`
- Create: `apps/api/src/adapters/library/abort-upload.ts`
- Test: `apps/api/test/library-upload.test.ts`

**Interfaces:**
- Consumes: `ObjectStorage`、`UploadSessionRepository`、`PhotoRepository`、`LibraryLog`、`FakeObjectStorage`、`createStorageGate`
- Produces:
  - `LibraryDeps = { photos: PhotoRepository; sessions: UploadSessionRepository; storage: ObjectStorage; ids: { nextId(): string }; signedUrlTtlSeconds: number; log: LibraryLog }`
  - `LibraryResult<T> = { ok: true; status: 200 | 201 | 204; body: T } | { ok: false; status: 400 | 404 | 409 | 500; code: "validation_error" | "not_found" | "upload_closed" | "upload_completing" | "upload_completed" | "storage_error" | "internal_error"; message: string }`
  - `notFound`、`uploadClosed`、`uploadCompleting`、`uploadCompleted`、`badPart`、`storageError`、`uploadIncomplete`、`deleteIncomplete`、`unsupportedType`、`invalidSize`。`deleteIncomplete()` 为 500 `internal_error`，文案「删除未能完成」。Task 6 只消费它，不再改 `messages.ts`
  - `createUpload(deps: LibraryDeps, actor, input: { contentType: string; byteSize: number }, now): Promise<LibraryResult<{ upload: UploadSessionResponse }>>`
  - `uploadPart(deps, actor, input: { sessionId: string; partNumber: number; body: Buffer }, now): Promise<LibraryResult<{ part: { partNumber: number; etag: string; byteSize: number } }>>`
  - `completeUpload(deps, actor, sessionId: string, now): Promise<LibraryResult<{ photo: PhotoResponse }>>`
  - `abortUpload(deps, actor, sessionId: string, now): Promise<LibraryResult<undefined>>`
  - `UploadSessionResponse = { id: string; photoId: string; objectKey: string; contentType: string; byteSize: number; expiresAt: string; status: "open" }`
  - `PhotoResponse` 的字段与设计 §4.7 的 `photo` 对象一致，不包含 `objectKey`、`thumbKey`、`sourceUserId`、`sourceKeyId`、`errorMessage`
  - `errorName(error: unknown): string` 只返回 `name`，缺省 `"Error"`

- [ ] **Step 1: 写会失败的用例测试**

创建 `apps/api/test/library-upload.test.ts`。每个用例使用真实 PostgreSQL、`createFakeObjectStorage()`、`ManualClock` 和序列 id 生成器。`LibraryActor.credentialKind` 默认 `password_session`。直接调用用例函数，不经过 HTTP。

必须覆盖：

1. `contentType` 为 `image/gif` 且 `byteSize` 为 `0` 时，文案是「不支持的文件类型」，假存储的创建次数为 0。`image/jpeg` 且 `byteSize` 为 `0` 或 `33554433` 时，文案是「文件大小须为 1 字节到 32 MiB」。`image/heic` 与四种 RAW 都能创建会话。
2. 合法创建返回 201。`upload.objectKey` 等于 `owners/{userId}/photos/{photoId}/original`。`expiresAt` 等于 `now + 24h` 的 ISO 字符串。`photos` 没有该 `photoId`。`upload_sessions.status` 为 `open`。响应对象没有 `s3UploadId`。
3. 把一条已过期 `open` 会话的存储中止设为 `failAbort = true` 后再创建新会话：新会话仍然 201，旧会话保持 `open`，日志静态文案是「清扫中止失败」，日志文本不含 `error.message`。
4. 上传一片后完成：完成前没有 `photos` 行；完成后 201，`photo.status` 为 `processing`，`photos.id` 等于创建时的 `photoId`，`source_key_id` 为 `NULL`，`source_user_id` 为用户 id。`credentialKind === "api_key"` 的另一次完成把 `source_key_id` 写成 `credentialId`。
5. **completing 栅栏：** 假存储 `blockComplete(gate)`。调用 `completeUpload` 但先不 `release`。`gate.entered` 之后查询数据库，`status` 已经是 `completing`。此时 `uploadPart` 与 `abortUpload` 都返回 409，`code` 为 `upload_completing`，`message` 为「上传正在完成」。分片行的 `etag` 与 `byte_size` 不变。第二次 `completeUpload` 也返回同一个 409，且 `completeCalls` 仍是 1。这两次 409 必须在 `release()` 之前返回；用 2 秒超时包住，超时视为失败，说明行锁盖住了存储调用。`release()` 后第一次完成返回 201，并且照片行出现。
6. `failComplete = true` 时，完成后没有 `photos` 行，会话从 `completing` 回到 `open`。错误是 500 `storage_error`，「对象存储不可用」。
7. 两片里第一片只有 40 字节：完成返回 400「分片不合法」，状态保持 `open`，`completeCalls` 为 0。
8. 同一 `partNumber` 上传两次后完成，`completedBytes` 等于后一片的内容。
9. 完成后再次完成返回 200 和同一个 `photo.id`，`completeCalls` 不增加。完成后 `abortUpload` 返回 409 `upload_completed`。中止后再上传分片返回 409 `upload_closed`。
10. 把时钟拨过 `expiresAt` 再 `uploadPart`：`abortCount` 增加，会话变为 `aborted`，响应 409 `upload_closed`，`completedBytes` 仍是 `null`。

第 5 条的栅栏用例按这个形状写。`createOpenJpeg` 是本文件里的助手，调用 `createUpload` 并返回 `{ actor, sessionId, photoId }`。超时必须发生在 `release()` 之前。助手：

```typescript
function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 409 超时，行锁可能盖住了 completing")), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
```

栅栏用例：

```typescript
serial("completing 提交先于 completeMultipartUpload，期间分片与中止得到 409", async () => {
  const { actor, sessionId, photoId } = await createOpenJpeg(deps, now, 4);
  await uploadPart(deps, actor, { sessionId, partNumber: 1, body: Buffer.from("abcd") }, now);
  const before = await pool.query(
    "select etag, byte_size from upload_parts where upload_session_id = $1",
    [sessionId],
  );
  const gate = createStorageGate();
  storage.blockComplete(gate);
  const pending = completeUpload(deps, actor, sessionId, now);
  await gate.entered;
  const status = await pool.query("select status from upload_sessions where id = $1", [sessionId]);
  assert.equal(status.rows[0].status, "completing");
  const part = await withTimeout(
    uploadPart(deps, actor, { sessionId, partNumber: 1, body: Buffer.from("zzzz") }, now),
    2000,
  );
  const aborted = await withTimeout(abortUpload(deps, actor, sessionId, now), 2000);
  const again = await withTimeout(completeUpload(deps, actor, sessionId, now), 2000);
  for (const result of [part, aborted, again]) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 409);
      assert.equal(result.code, "upload_completing");
      assert.equal(result.message, "上传正在完成");
    }
  }
  const during = await pool.query(
    "select etag, byte_size from upload_parts where upload_session_id = $1",
    [sessionId],
  );
  assert.deepEqual(during.rows, before.rows);
  assert.equal(storage.completeCalls, 1);
  gate.release();
  const done = await pending;
  assert.equal(done.ok, true);
  if (done.ok) assert.equal(done.status, 201);
  const photos = await pool.query("select id from photos where id = $1", [photoId]);
  assert.equal(photos.rowCount, 1);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/library-upload.test.ts
```

Expected: 退出码非 0。`createUpload` 未定义。

- [ ] **Step 3: 实现用例**

`messages.ts` 导出 `LIBRARY_MESSAGES` 与 `LibraryResult`。固定文案使用 Global Constraints 那一组。提供 `notFound`、`uploadClosed`、`uploadCompleting`、`uploadCompleted`、`badPart`、`storageError`、`uploadIncomplete`、`deleteIncomplete`、`unsupportedType`、`invalidSize`。`deleteIncomplete` 与 `uploadIncomplete` 一样是 500 `internal_error`，文案分别是「删除未能完成」和「上传未能完成」。不要把 401 或 413 放进用例结果；那两档留在接口层。Task 6 调用 `deleteIncomplete()`，不要再改这个文件。

`error-name.ts` 只读 `name`。`deps.ts` 只依赖领域端口，不 import DAO 或网关。字段与 Task 7 的 `createLibraryDeps` 返回值一致；`ids` 由组合根注入，不在适配层自己生成：

```typescript
import type { LibraryLog, ObjectStorage, PhotoRepository, UploadSessionRepository } from "../../domain/library/ports.js";

export type LibraryDeps = {
  photos: PhotoRepository;
  sessions: UploadSessionRepository;
  storage: ObjectStorage;
  ids: { nextId(): string };
  signedUrlTtlSeconds: number;
  log: LibraryLog;
};
```

`photo-response.ts` 的 `toPhotoResponse(deps, photo, now)` 调用 `presignGet({ key: photo.objectKey, expiresInSeconds: deps.signedUrlTtlSeconds, now })`。`originalUrlExpiresAt` 用返回的 `expiresAt.toISOString()`。签发抛错时不要在这里吞掉。

`abort-locked.ts` 导出：

```typescript
export async function abortLocked(
  deps: LibraryDeps,
  actor: LibraryActor,
  sessionId: string,
  now: Date,
): Promise<"aborted" | "missing" | "completing" | "completed" | "storage_error">
```

在 `transactById` 里：

- 没有行，或 `ownerId` 不同：`"missing"`。不要调用存储。
- `completing`，或者 `open` 且 `objectCompletedAt` 已有值：`"completing"`。不要调用 `abortMultipartUpload`。
- `aborted`：`"aborted"`。不要再次调用存储。
- `completed`：`"completed"`。不要删除照片或对象。
- `open`：在这把行锁内调用 `abortMultipartUpload`。`error.name === "NoSuchUpload"` 视为成功。其他失败先 `log.warn("对象存储失败", { userId, photoId, objectKey, uploadSessionId, reason, errorName })`，`reason` 按 `expiresAt <= now` 取 `"expired"`，否则 `"client"`，然后把结果标成 `"storage_error"` 并抛出，让事务回滚、状态保持 `open`。成功后 `tx.markAborted`。

`create-upload.ts`：

1. `normalizeContentType` 失败则 `unsupportedType()`。随后检查 `byteSize` 是 `1` 到 `33554432` 的整数，否则 `invalidSize()`。顺序不能反过来。
2. `listExpiredOpen`。对每一行调用 `abortLocked`。列表查询或某一行中止失败时 `log.warn("清扫中止失败", …)`，`reason: "expired"`。失败不阻止本次创建。
3. `photoId` 与 `sessionId` 来自 `deps.ids.nextId()`。`objectKey` 来自 `photoObjectKey`。先 `createMultipartUpload`。存储失败：记「对象存储失败」，不插入，返回 `storageError()`。
4. 存储成功后再 `sessions.insert`。`expiresAt = new Date(now.getTime() + UPLOAD_TTL_MS)`。插入失败时尽力 `abortMultipartUpload`，记日志，返回 `storageError()`。不要把 `s3UploadId` 放进返回体。

`upload-part.ts` 先进入 `transactById`：

- 不是主人或不存在：`notFound()`。
- `completing`，或 `open` 且 `objectCompletedAt` 非空：`uploadCompleting()`。不调用 `uploadPart`，不写分片。
- `aborted`：`uploadClosed()`。
- `completed`：`uploadCompleted()`。
- `open` 且 `expiresAt <= now`：先结束这个事务，再 `abortLocked`。中止失败返回 `storageError()`；中止发现状态变成 `completing` 则返回 `uploadCompleting()`；否则返回 `uploadClosed()`。这次请求的字节不上传。
- `open` 且未过期：把同一编号的旧字节换成 `body.length` 后，若 `body.length < 1`、大于 `33554432`，或总和大于会话 `byteSize` 或 `33554432`，返回 `badPart()`，不调用存储。否则在这把行锁内 `storage.uploadPart`，再 `tx.upsertPart`。存储抛错则记「对象存储失败」并抛出，让事务回滚，不留分片行，对外返回 `storageError()`。

`complete-upload.ts` 是 completing 栅栏的唯一实现。事务内只做判断和 `setCompleting`，不调用 `completeMultipartUpload`：

- 不是主人或不存在：`notFound()`。
- `aborted`：`uploadClosed()`。
- `completed`：读 `photos`。可见则 `toPhotoResponse` 后返回 200；不可见返回 `notFound()`。不调用存储。
- `objectCompletedAt` 已有值：跳过存储，进入下面的插入步骤。
- `open` 且已过期且 `objectCompletedAt` 为空：事务内不改状态、不调用存储。事务提交后 `abortLocked`，再按分片路径的过期结果返回。不插入照片。
- `open` 且未过期：`validatePartsForComplete` 不是 `"ok"` 时返回 `badPart()`，状态保持 `open`，`completeCalls` 不会增加。通过后在同一事务 `setCompleting` 并提交。
- 已经是 `completing`：不再校验分片，不改分片行，使用锁内读到的分片。

提交并释放行锁之后，只有「需要呼叫存储」的分支才 `tryCompletionLock(session.id)`。拿不到锁就返回 `uploadCompleting()`，此时不得增加 `completeCalls`。拿到锁后，在 `finally` 里 `release()`。锁内：

1. 调用 `completeMultipartUpload`。分片按 `partNumber` 升序，ETag 用提交前读到的值。
2. 成功则 `markObjectCompleted(session.id, now)`。状态保持 `completing`。
3. 若 `error.name === "NoSuchUpload"`，再 `headObject`。`byteSize === session.byteSize` 时同样 `markObjectCompleted`。字节数不符，或 head 抛错，走失败分支。
4. 其他失败：`reopenIfNoObject`。返回 `"reopened"` 时记「对象存储失败」并返回 `storageError()`，不插入照片。返回 `"kept"` 时不得把会话退回 `open`，直接进入插入步骤。

插入步骤调用 `insertPhotoAndComplete`。调用前会话必须已经是 `completing`，并且 `object_completed_at` 已经写下。抛错时记「上传未能完成」并返回 `uploadIncomplete()`。返回 `"inserted"` 时响应 201；返回 `"exists"` 时若照片仍可见则 200，不可见则 `notFound()`。签发失败返回 `storageError()`，不删除已经插入的行。

`abort-upload.ts` 只调用 `abortLocked`：`"missing"` → 404，`"completing"` → 409 `upload_completing`，`"completed"` → 409 `upload_completed`，`"storage_error"` → 500 `storage_error`，`"aborted"` → `{ ok: true, status: 204, body: undefined }`。

这些文件不得出现 `from ".../dao"`、`from ".../gateways"`、`Date.now` 或无参数的 `new Date()`。`new Date(now.getTime() + UPLOAD_TTL_MS)` 可以使用。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/library-upload.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 两者退出码都是 0。栅栏用例在释放前就能收到 409，不需要等存储返回。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/adapters/library apps/api/test/library-upload.test.ts
git commit -m "feat: 实现上传会话的创建、分片、完成与中止"
```

---

### Task 6: 列表、详情、PATCH 与删除用例

**Files:**
- Create: `apps/api/src/adapters/library/list-photos.ts`
- Create: `apps/api/src/adapters/library/get-photo.ts`
- Create: `apps/api/src/adapters/library/patch-photo.ts`
- Create: `apps/api/src/adapters/library/delete-photo.ts`
- Modify: `apps/api/src/adapters/index.ts`
- Test: `apps/api/test/library-photos.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `LibraryDeps` 与 `deleteIncomplete()`（已在 `messages.ts` 导出）、`toPhotoResponse`、`MetadataPatch`、`encodePhotoCursor`、`isVisiblePhoto`
- Produces:
  - `listPhotos(deps, actor, query: { limit: number; cursor: { createdAt: Date; id: string } | null }, now): Promise<LibraryResult<{ photos: PhotoResponse[]; nextCursor: string | null }>>`
  - `getPhoto(deps, actor, photoId: string, now): Promise<LibraryResult<{ photo: PhotoResponse }>>`
  - `patchPhoto(deps, actor, photoId: string, patch: MetadataPatch, now): Promise<LibraryResult<{ photo: PhotoResponse }>>`
  - `deletePhoto(deps, actor, photoId: string): Promise<LibraryResult<undefined>>`

- [ ] **Step 1: 写会失败的照片用例测试**

创建 `apps/api/test/library-photos.test.ts`，直接调用 Task 5 的 `createUpload`、`uploadPart`、`completeUpload` 和本任务的四个函数。使用注入的假存储。覆盖：

1. 空库 `listPhotos` 返回 200、`photos: []`、`nextCursor: null`。
2. 用时钟先后完成两张照片。`limit: 1` 时第一页只有较新的那张，`nextCursor` 能被 `decodePhotoCursor` 解回它的 `createdAt` 与 `id`。用这个游标取第二页，只得到较旧的那张，`nextCursor` 为 `null`。另一位用户的 `createdAt` 与 id 拼成的游标不会返回第一位用户之外的行，也不会 404。
3. `signedUrlTtlSeconds` 为 900 时，`originalUrlExpiresAt` 等于 `now + 900 秒`。响应对象没有 `objectKey`、`sourceKeyId`、`sourceUserId`。
4. 空 `MetadataPatch` 不改变 `updated_at`。只写 `description` 时 `updated_at` 变为传入的 `now`，`content_type` 列不变。
5. `deletePhoto` 返回 204。行消失。`deletedKeys` 含 `objectKey`。把该行的 `thumb_key` 先改成非空再删另一张准备好的照片时，两个键都出现在 `deletedKeys`。`failDelete = true` 时响应仍是 204，行仍消失，日志含「删除对象失败」，不含错误对象的 `message`。
6. 其他 `userId` 调用详情、PATCH、删除都是 404「未找到」，并且 `deletedKeys` 不增加。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/library-photos.test.ts
```

Expected: 退出码非 0。`listPhotos` 未定义。

- [ ] **Step 3: 实现四个用例**

`listPhotos` 调用 `listOwned` 时把 `limit` 加 1。只把前 `query.limit` 行送去签发。任一签发失败就记「对象存储失败」并返回 `storageError()`，不返回缺 URL 的数组。有更多行时，`nextCursor` 用本页最后一条的 `createdAt` 与 `id` 调用 `encodePhotoCursor`，否则 `null`。

`getPhoto` 用 `findById` 加 `isVisiblePhoto`。不可见则 `notFound()`，不签发。可见则 `toPhotoResponse`。

`patchPhoto` 先做同样的可见性判断。`Object.keys(patch).length === 0` 时直接用原行签发，不调用 `updateOwned`。否则 `updateOwned(id, actor.userId, patch, now)`。仓储返回 `null` 则 404。

`deletePhoto` 先 `deleteOwned`。抛错时记「删除未能完成」并返回 `deleteIncomplete()`，不调用 `deleteObject`。返回 `null` 时 404，不调用 `deleteObject`。成功后对 `objectKey` 调用 `deleteObject`；`thumbKey` 非空时再调一次。对象删除抛错只记「删除对象失败」，响应仍是 204。不回插行，不中止 `upload_sessions`。

从 `adapters/index.ts` 导出这四个函数，以及 Task 5 的 `createUpload`、`uploadPart`、`completeUpload`、`abortUpload`、`LibraryDeps`、`PhotoResponse`。不要从适配层导出 DAO。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/library-photos.test.ts apps/api/test/library-upload.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 两者退出码都是 0。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/adapters apps/api/test/library-photos.test.ts
git commit -m "feat: 实现照片列表、详情、修改与删除"
```

---

### Task 7: HTTP 路由、组合根与日志红线

**Files:**
- Create: `apps/api/src/interfaces/http/register-photos.ts`
- Create: `apps/api/src/interfaces/http/send-library-error.ts`
- Create: `apps/api/src/wire-library.ts`
- Modify: `apps/api/src/interfaces/index.ts`
- Modify: `apps/api/src/interfaces/http/error-handler.ts`
- Modify: `apps/api/src/interfaces/http/auth-logger.ts`
- Modify: `apps/api/src/interfaces/http/validation.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/test/personal-library.test.ts`
- Test: `apps/api/test/storage-startup.test.ts`

**Interfaces:**
- Consumes: Task 5 与 Task 6 的用例、`requirePrincipal`、`parseUuid`、`parsePhotoLimit`、`decodePhotoCursor`、`normalizeMetadataPatch`、`loadStorageConfig`、`createS3ObjectStorage`、`createFakeObjectStorage`
- Produces:
  - `registerPhotoRoutes(app: FastifyInstance, identity: IdentityDeps, library: LibraryDeps, clock: { now(): Date }): void`
  - `createLibraryDeps({ pool, storage, signedUrlTtlSeconds, log }): LibraryDeps`。返回值的六个字段就是 Task 5 的 `LibraryDeps`：`photos` 与 `sessions` 由 `pool` 造出，`ids` 用现有 `createIdGenerator()`，其余三项原样传入
  - `BuildAppOptions` 增加可选 `storage?: ObjectStorage` 与 `signedUrlTtlSeconds?: number`
  - 未传 `storage` 时用 `createFakeObjectStorage()`，TTL 用 `900`
  - 生产入口先 `loadStorageConfig`，失败时 `console.error` 文案并 `process.exit(1)`，不调用 `listen`

- [ ] **Step 1: 写会失败的 HTTP 冒烟与启动测试**

创建 `apps/api/test/personal-library.test.ts`。复制身份集成测试的 `serial`、`ManualClock`、`testConfig` 和 `TRUNCATE TABLE users CASCADE`。`before` 里 `applySchema` 后：

```typescript
const storage = createFakeObjectStorage();
app = await buildApp({
  logger: false,
  config: testConfig,
  clock,
  pool,
  storage,
  signedUrlTtlSeconds: 900,
});
```

个人库测试必须把这个 `storage` 传进去，不能省略。再写两个用例：不带 `Authorization` 时 `POST /photos/uploads` 返回 401，正文是 `{ error: { code: "unauthorized", message: "未授权" } }`；主人注册后用 Access JWT 以 `{ contentType: "image/jpeg", byteSize: 4 }` 创建会话，上传 4 字节并完成，响应 201，`photo.status` 为 `"processing"`，JSON 里没有 `s3UploadId`。另加一个不使用 `serial` 的用例：删掉 `process.env.S3_SECRET_ACCESS_KEY` 后，不传 `storage` 调用 `buildApp`，`GET /health` 仍是 200，然后恢复环境变量并 `close()`。

创建 `apps/api/test/storage-startup.test.ts`：用 `spawn("npx", ["tsx", "apps/api/src/index.ts"])` 启动进程。环境里 JWT、pepper、`DATABASE_URL` 和五项 S3 必填都合法，`S3_SIGNED_URL_TTL=8d`，`PORT=0`。进程退出码为 1，stderr 含 `S3_SIGNED_URL_TTL 超过 7 天`，且不含 `SECRET`。5 秒还没退出就杀掉子进程并让测试失败。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/personal-library.test.ts apps/api/test/storage-startup.test.ts
```

Expected: 退出码非 0。创建上传实际是 404，或入口还没在监听前退出。

- [ ] **Step 3: 接上路由和组合根**

`parseUuid` 在正则通过后返回 `raw.toLowerCase()`。身份路由仍只接受 UUID。

`send-library-error.ts` 按 `error.status` 发送 `{ error: { code, message } }`。不要修改 `AuthError` 的状态联合。

`register-photos.ts` 的签名是 `registerPhotoRoutes(app, identity, library, clock)`。`identity` 是现有的 `IdentityDeps`，只交给 `requirePrincipal(identity, header)`，与 `registerMeRoute` 相同。`isPrincipal` 失败就 `sendAuthError`。成功后把 `Principal` 收成 `LibraryActor`（`userId`、`credentialKind`、`credentialId` 三字段同名同义）再交给库用例。库用例的第一个参数永远是 `library`，不是 `identity`。`now` 一律是 `clock.now()`。不要把 `RefreshTokenRepository` 传进库路由。

| 方法与路径 | 行为 |
|------------|------|
| `POST /photos/uploads` | body schema：`additionalProperties: false`，必填 `contentType` 字符串与 `byteSize` 整数，不设 minimum/maximum。然后 `createUpload` |
| `PUT` 与 `POST /photos/uploads/:id/parts/:partNumber` | `bodyLimit: 33554432`。`:id` 用 `parseUuid`。`:partNumber` 必须匹配 `^[1-9][0-9]{0,4}$` 且数值在 1 到 10000，否则 400「分片不合法」。`Content-Type` 不是 `application/octet-stream`、正文不是 `Buffer` 或长度为 0：400「分片不合法」。通过后 `uploadPart` |
| `POST /photos/uploads/:id/complete` 与 `.../abort` | 正文省略或 `{}` 才调用用例。数组、Buffer 或其他字段：400「请求不合法」 |
| `GET /photos` | query schema 只允许字符串 `limit` 与 `cursor`，`additionalProperties: false`。`parsePhotoLimit` 或 `decodePhotoCursor` 失败：400「请求不合法」。然后 `listPhotos` |
| `GET /photos/:id`、`PATCH /photos/:id`、`DELETE /photos/:id` | 先 `parseUuid`。PATCH 的 schema 用 `additionalProperties: false`，六个字段的 schema 不限制 JSON 类型，把整个对象交给 `normalizeMetadataPatch`。失败时用它的 `message`。成功则 `patchPhoto` |

在 `registerPhotoRoutes` 里注册一次解析器：

```typescript
app.addContentTypeParser(
  "application/octet-stream",
  { parseAs: "buffer", bodyLimit: 33_554_432 },
  (_request, body, done) => {
    done(null, body);
  },
);
```

`error-handler.ts` 在现有「请求不合法」分支之后、通用 500 之前增加：路由模板是 `/photos/uploads/:id/parts/:partNumber` 且 `error.code === "FST_ERR_CTP_BODY_TOO_LARGE"` 时，返回 413 `{ error: { code: "payload_too_large", message: "文件超过 32 MiB" } }`。同一路由上 `FST_ERR_CTP_INVALID_MEDIA_TYPE` 返回 400 `{ error: { code: "validation_error", message: "分片不合法" } }`。不要把 `error` 对象传进 `request.log.error`。文件里不要出现 `request.body` 这串字符，否则身份日志测试会失败。其他路由的超限仍走原来的 500「服务器错误」。

`auth-logger.ts` 的 `paths` 保留现有七项，并追加 `"originalUrl"`、`"photo.originalUrl"`、`"photos[*].originalUrl"`。

`wire-library.ts` 放在 `apps/api/src/wire-library.ts`。它 import DAO 与 `createIdGenerator`，返回 Task 5 的 `LibraryDeps`。`libraryLogFromFastify` 只把 `LibraryLogFields` 里的字段和静态中文 message 交给 logger，不传错误对象。

```typescript
export function createLibraryDeps(input: {
  pool: pg.Pool;
  storage: ObjectStorage;
  signedUrlTtlSeconds: number;
  log: LibraryLog;
}): LibraryDeps {
  return {
    photos: createPhotoRepository(input.pool),
    sessions: createUploadSessionRepository(input.pool),
    storage: input.storage,
    ids: createIdGenerator(),
    signedUrlTtlSeconds: input.signedUrlTtlSeconds,
    log: input.log,
  };
}
```

`buildApp` 同时造出两套依赖，再按这个顺序装配。未传入 `storage` 时使用 `createFakeObjectStorage()`，未传入 TTL 时使用 `900`。不要在这里调用 `loadStorageConfig`，也不要读取 `S3_ACCESS_KEY_ID`。

```typescript
const identity = await createIdentityDeps({ config, clock, pool, log: authLogFromFastify(app.log) });
const storage = options.storage ?? createFakeObjectStorage();
const signedUrlTtlSeconds = options.signedUrlTtlSeconds ?? 900;
const library = createLibraryDeps({
  pool,
  storage,
  signedUrlTtlSeconds,
  log: libraryLogFromFastify(app.log),
});
registerErrorHandler(app);
registerHealthRoute(app);
registerAuthRoutes(app, identity);
registerMeRoute(app, identity);
registerApiKeyRoutes(app, identity);
registerPhotoRoutes(app, identity, library, clock);
```

`index.ts` 在 `loadAuthConfig` 和 `listen` 之前：

```typescript
let storageConfig: ReturnType<typeof loadStorageConfig>;
try {
  storageConfig = loadStorageConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : "对象存储配置无效");
  process.exit(1);
}
```

成功后再 `createS3ObjectStorage(storageConfig)`，并把 `storage` 与 `signedUrlTtlSeconds: storageConfig.signedUrlTtlSeconds` 传给 `buildApp`。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/personal-library.test.ts apps/api/test/storage-startup.test.ts apps/api/test/health.test.ts apps/api/test/identity-auth.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 全部退出码 0。身份测试与健康检查不需要设置 `S3_*`。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test/personal-library.test.ts apps/api/test/storage-startup.test.ts
git commit -m "feat: 接通个人库 HTTP 路由与存储组合根"
```

---

### Task 8: 设计 §10 的 HTTP 验收

**Files:**
- Modify: `apps/api/test/personal-library.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `app`、`storage`、`pool`、`clock`、`serial`，以及 `POST /auth/register`、`POST /api-keys`
- Produces: 设计 §10 第 1 到第 11 条和第 13 条的 HTTP 断言。设计 §10 第 12 条（分层边界）由 Task 9 的 `npm test` 覆盖，不在本任务编号里。另有一节「附加 HTTP 边角」，不是设计 §10 的第 12 条。第 11 条的解析表已经在 `storage-config.test.ts`，这里补列表上的 `originalUrlExpiresAt`

- [ ] **Step 1: 把验收用例追加到同一个文件**

下列每条都是 `serial` 用例。先 `truncate`，再注册主人。上传助手使用 `application/octet-stream`。错误断言使用 `assert.deepEqual` 比对整个 `{ error: { code, message } }`。

1. Access JWT 创建、上传一片、完成。完成前 `photos` 没有该 `photoId`，`upload_sessions.status` 为 `open`。完成后 201，`status` 为 `processing`。`GET /photos` 能看到该照片，并带 `originalUrl` 与 `originalUrlExpiresAt`。`photos.id` 等于创建响应里的 `photoId`。`photos.object_key` 等于 `owners/{userId}/photos/{photoId}/original`。假存储 `completedBytes` 的长度等于 `byteSize`。
2. 同一用户的 API Key 完成上传、列表、详情、PATCH、删除。`source_key_id` 等于该 Key 的 id。用 JWT 完成的另一张照片 `source_key_id` 为 `NULL`，`source_user_id` 为用户 id。响应 JSON 不含这两个字段。
3. 另一个用户的 JWT 和 API Key 分别调用详情、PATCH、删除、分片、完成、中止，状态都是 404，`error.code` 与 `error.message` 都是 `not_found` / 「未找到」。`GET /photos` 的数组里没有这张照片。
4. PATCH 依次写入 `description`、`tags`、`takenAt`、`locationText`、成对的 `latitude`/`longitude`，再分别用 `null`、空标签和成对 `null` 清空。请求体里的 `contentType`、`objectKey`、`status` 返回 400「请求不合法」，数据库这三列不变，`status` 仍是 `processing`。
5. 删除返回 204 且正文为空。行消失。`deletedKeys` 包含该 `objectKey`。`failDelete = true` 后再删另一张：仍是 204，行消失。日志不含 `S3_SECRET_ACCESS_KEY` 的值、不含 Access JWT、不含 `originalUrl` 查询串，并含「删除对象失败」。
6. `byteSize` 为 `0` 和 `33554433` 时文案是「文件大小须为 1 字节到 32 MiB」。`image/gif` 返回「不支持的文件类型」。额外字段，或 `contentType` 不是字符串，返回「请求不合法」，并且先于类型和大小。四种 RAW 与 `image/heic` 都能创建会话。
7. 声明大小为 `5242880 + 10`。第一片 `Buffer.alloc(5242880, 1)`，第二片 10 字节，完成后对象字节数为声明大小。只上传一片且长度等于声明大小 `10` 时可以完成。第一片 40 字节、第二片 60 字节，或只上传 10 字节但声明 11，或只有 1 和 3 两片：完成都是 400「分片不合法」，且没有 `photos` 行，会话仍是 `open`。
8. 同一 `partNumber` 先上传 `Buffer.from("old")` 再上传 `Buffer.from("new")`。完成后的对象字节是 `new`。
9. 中止后再次上传分片得到 409 `upload_closed`。完成后再次完成得到 200 和同一 `id`。完成后中止得到 409 `upload_completed`，照片行还在。`failComplete = true` 时完成得到 500 `storage_error`，没有 `photos` 行，会话变回 `open`。然后把 `failComplete` 设回 `false`。
10. `clock.set(new Date(expiresAt + 1))` 后上传分片：`abortCount` 增加，会话为 `aborted`，响应 409 `upload_closed`。
11. 本文件里列表项的 `originalUrlExpiresAt` 等于测试时钟加上 `900` 秒。配置解析的空白、`15m` 和超过 7 天已经在 `apps/api/test/storage-config.test.ts`，不要另写一套时长语法。

**附加 HTTP 边角**（不是设计 §10 第 12 条；那一条在 Task 9）：分片正文超过 `33554432` 字节时，这一条路由返回 413 `payload_too_large`，「文件超过 32 MiB」。`Content-Type: text/plain` 返回 400「分片不合法」。`PUT` 与 `POST` 各成功上传一次。`GET /photos/uploads` 返回 400「标识不合法」。`limit=01` 与未知查询参数返回 400「请求不合法」。

**设计 §10 第 13 条，完成进行中：** 把下面的用例放进 `personal-library.test.ts`。`uploadJpeg` 用 Access JWT 创建 `byteSize: 4` 的 jpeg 会话并上传 `Buffer.from("abcd")`，返回 `{ sessionId, photoId }`。`auth` 带上 `authorization: Bearer ...`。

```typescript
serial("设计 §10 第 13 条：完成进行中时分片与中止得到 409，结束后仍插入照片", async () => {
  await reset();
  const owner = await registerAccess("owner13@example.com");
  const { sessionId, photoId } = await uploadJpeg(owner.accessToken);
  const before = await pool.query(
    "select etag, byte_size from upload_parts where upload_session_id = $1 order by part_number",
    [sessionId],
  );
  const gate = createStorageGate();
  storage.blockComplete(gate);
  const pending = app.inject({
    method: "POST",
    url: `/photos/uploads/${sessionId}/complete`,
    headers: { authorization: `Bearer ${owner.accessToken}` },
  });
  await gate.entered;
  const status = await pool.query("select status from upload_sessions where id = $1", [sessionId]);
  assert.equal(status.rows[0].status, "completing");
  const part = await withTimeout(
    app.inject({
      method: "PUT",
      url: `/photos/uploads/${sessionId}/parts/1`,
      headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/octet-stream" },
      payload: Buffer.from("zzzz"),
    }),
    2000,
  );
  const aborted = await withTimeout(
    app.inject({
      method: "POST",
      url: `/photos/uploads/${sessionId}/abort`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    }),
    2000,
  );
  const again = await withTimeout(
    app.inject({
      method: "POST",
      url: `/photos/uploads/${sessionId}/complete`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    }),
    2000,
  );
  for (const response of [part, aborted, again]) {
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { error: { code: "upload_completing", message: "上传正在完成" } });
  }
  const during = await pool.query(
    "select etag, byte_size from upload_parts where upload_session_id = $1 order by part_number",
    [sessionId],
  );
  assert.deepEqual(during.rows, before.rows);
  assert.equal(storage.completeCalls, 1);
  gate.release();
  const done = await pending;
  assert.equal(done.statusCode, 201);
  assert.equal(done.json().photo.id, photoId);
  assert.equal(done.json().photo.status, "processing");
  const photos = await pool.query("select id, status from photos where id = $1", [photoId]);
  assert.equal(photos.rowCount, 1);
});
```

`withTimeout` 与 Task 5 相同。每个用例结束前把 `failDelete`、`failComplete` 和 `blockComplete(null)` 恢复。

- [ ] **Step 2: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/personal-library.test.ts
```

Expected: 退出码 0，`# fail 0`。设计 §10 第 13 条在释放栅栏前就得到 409。若超时，说明 `completeMultipartUpload` 仍握着会话行锁，回到 Task 5 把提交 `completing` 放在存储调用之前。若其他断言失败，修正对应路由或用例，不要放宽断言。`gate.release()` 放在 `finally` 里，避免断言失败后 `pending` 挂住进程。

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/personal-library.test.ts
git commit -m "test: 覆盖个人库上传、越权与 completing 栅栏"
```

---

### Task 9: 锁住领域层不得出现对象存储 SDK

**Files:**
- Create: `apps/api/test/library-boundaries.test.ts`
- Modify: `scripts/check-layer-boundaries.mjs`（仅当下面的字符串已经丢失时）

**Interfaces:**
- Consumes: 现有 `domainPackages` 已含 `aws-sdk` 与 `minio`，`domainPrefixes` 已含 `@aws-sdk/`
- Produces: `npm test` 的分层检查通过，并且 `domain/library` 源码不出现这些包名

- [ ] **Step 1: 写源码扫描测试**

创建 `apps/api/test/library-boundaries.test.ts`。递归读取 `apps/api/src/domain/library` 与 `apps/api/src/adapters/library` 的 `.ts` 文件并拼成一个字符串。对两份源码都断言不包含 `@aws-sdk/`、`aws-sdk`、`minio`，也不匹配 `/Date\.now|new Date\(\)/`。领域源码不包含 `domain/identity`。适配源码不包含 `/dao` 与 `/gateways`。再读 `scripts/check-layer-boundaries.mjs`，断言它仍包含 `"aws-sdk"`、`"minio"` 和 `@aws-sdk/`。

不要在被扫描目录的注释里写下这三个包名。需要说明时写「对象存储 SDK」。

- [ ] **Step 2: 运行完整测试**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npm test
npx tsc -p apps/api/tsconfig.json --noEmit
npm run build -w apps/api
```

Expected: `npm test` 先打印 `分层边界检查通过`，然后 API 测试 `# fail 0`，退出码 0。`tsc` 与 `build` 退出码 0。若边界脚本丢了 `aws-sdk` 或 `@aws-sdk/`，按文件里现有的 `domainPackages` / `domainPrefixes` 补回，不要另起一份规则。身份测试和 `GET /health` 在不配置 `S3_*` 时仍然通过。

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/library-boundaries.test.ts scripts/check-layer-boundaries.mjs
git commit -m "test: 锁定个人库领域层不引用对象存储 SDK"
```

若边界脚本没有改动，就不要把它放进 `git add`。

---

### Task 10: 验收通过后把阶段标成 done

**Files:**
- Modify: `specs/phases/02-personal-library.md`
- Modify: `specs/SPEC.md`

**Interfaces:**
- Consumes: Task 9 的 `npm test`、`tsc`、`build` 都已通过
- Produces: 阶段规格状态 `done`，六条验收框勾上；`specs/SPEC.md` 索引表阶段 2 为 `done`

这个任务只有在 Task 9 的三条命令都成功之后才能做。测试失败时不要改状态。

- [ ] **Step 1: 再跑一次验收命令**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npm test
npx tsc -p apps/api/tsconfig.json --noEmit
npm run build -w apps/api
```

Expected: 全部退出码 0。

- [ ] **Step 2: 更新阶段规格**

`specs/phases/02-personal-library.md` 的状态行改为：

```markdown
**状态：** done
```

验收列表改为：

```markdown
- [x] 主人用 JWT 或自己的 API Key 都能上传并在列表中看到该照片
- [x] 其他用户不能读取或删除该照片
- [x] 元数据修改只作用于调用者有权的照片
- [x] 对象键与数据库行一致；存储凭证不出现在日志或响应正文
- [x] 未配置真实对象存储时，测试可以使用本地假实现，且假实现位于网关层
- [x] 领域层边界检查仍然通过
```

不要修改设计文件开头的「状态：已定稿（待实现）」。不要改「范围内」那段已经写明的 completing 规则。

- [ ] **Step 3: 更新索引表**

`specs/SPEC.md` 里阶段 2 那一行改为：

```markdown
| 2 | [phases/02-personal-library.md](phases/02-personal-library.md) | done | 个人照片增删改查与对象存储 |
```

不要勾选「任何阶段的完成定义」那一组模板复选框。

- [ ] **Step 4: Commit**

```bash
git add specs/phases/02-personal-library.md specs/SPEC.md
git commit -m "docs: 将 Phase 2 状态标记为 done"
```

---

## 自检（计划作者已完成，实现时不要重做这一节）

实现代理跳过本节。下列是写计划时对照设计合同的覆盖记录。

| 设计 | 落点 | 结论 |
|------|------|------|
| §1 只交付 HTTP API 与测试，不改 `apps/web`，照片保持 `processing` | Global Constraints；无 web 任务；Task 10 才改阶段状态 | 已覆盖 |
| §2 服务端 multipart、方案 A、32 MiB、白名单、签名 TTL、删除、PATCH、404、分层、24 小时 | Global Constraints 与 File Structure | 已覆盖 |
| §3.1 领域端口与纯规则 | Task 2 | 已覆盖 |
| §3.2 八个用例，适配层不引用 DAO / 网关 | Task 5、Task 6；Task 9 源码扫描 | 已覆盖 |
| §3.3 `FOR UPDATE` 与应用生成 UUID | Task 4 | 已覆盖 |
| §3.4 真 S3 与内存假存储，假 URL 为 `http://storage.invalid/get` | Task 3 | 已覆盖 |
| §3.5 原始字节、`bodyLimit` 33554432、只有分片路由映射 413 | Task 7；Task 8「附加 HTTP 边角」 | 已覆盖 |
| §3.6 未注入存储时用假实现且不读密钥；生产入口先校验配置 | Task 7 的 `buildApp`、`index.ts` 与 `storage-startup.test.ts` | 已覆盖 |
| §4.1–4.3 创建与分片，含覆盖、累计上限、状态码 | Task 5、Task 7、Task 8 | 已覆盖 |
| §4.4、§5.2 completing 在 `completeMultipartUpload` 之前提交 | Global Constraints；Task 5 完成用例；Task 8 设计 §10 第 13 条 | 已覆盖 |
| §4.4 另一完成请求拿不到互斥时 409，且不第二次呼叫存储 | Task 4 `pg_try_advisory_lock`；Task 5 与 Task 8 都断言 `completeCalls` 仍为 1 | 已覆盖 |
| §4.4 存储失败退回 `open`；对象已完成但插入失败则 500「上传未能完成」，重试不再创建对象 | Task 5 步骤 6 与 `reopenIfNoObject` / `insertPhotoAndComplete`；Task 8 第 9 条 | 已覆盖 |
| §4.5 中止、已完成后再中止、`completing` 时不 Abort | Task 5 `abortLocked`；Task 8 第 9 条与设计 §10 第 13 条 | 已覆盖 |
| §4.6–4.8 列表游标、详情字段、PATCH 规则 | Task 2 纯函数；Task 6；Task 8 第 4、11 条 | 已覆盖 |
| §4.9 先删行，对象与非空 `thumb_key` 尽力删 | Task 6 第 5 条；Task 8 第 5 条 | 已覆盖 |
| §5.1 DDL | Task 1，SQL 与设计一致 | 已覆盖 |
| §5.3 分片规则与最多 7 片 | Task 2 `validatePartsForComplete`；Task 8 第 7 条 | 已覆盖 |
| §5.4 只对 `open` 过期中止，`completing` 过期仍 409 | Task 5；Task 8 第 10 条与设计 §10 第 13 条 | 已覆盖 |
| §6.1–6.3 白名单与插入列，含 `source_key_id` | Task 2、Task 4 插入 SQL、Task 5 第 4 条、Task 8 第 2、6 条 | 已覆盖 |
| §7 不读 `S3_PUBLIC_BASE_URL`，个人库不用 403 | Task 1 示例与 README；Task 3 配置对象无该字段；Task 8 第 3 条 | 已覆盖 |
| §8 配置与 7 天上限 | Task 1 示例；Task 3 `loadStorageConfig`；Task 7 启动退出 | 已覆盖 |
| §9 日志红线与 `originalUrl` redact | Global Constraints；Task 7 保留身份测试要求的原路径并追加 `originalUrl`；Task 8 第 5 条 | 已覆盖 |
| §10 第 1–11、13 条 | Task 8。第 11 条的时长解析在 Task 3 | 已覆盖 |
| §10 第 12 条 | Task 9 的 `npm test` 与源码扫描 | 已覆盖 |
| §11 明确不做 | Global Constraints，无对应实现任务 | 已覆盖 |
| §12 六条阶段验收 | Task 10 才勾选 | 已覆盖 |
| §13 已确认决策，含 completing | 与上文相同 | 已覆盖 |

过期中止和客户端中止在会话行锁内呼叫 `abortMultipartUpload`。`completeMultipartUpload` 不在这把行锁里：必须先提交 `completing`、释放行锁、拿到 advisory lock，然后才呼叫存储。这样分片请求不会堵在行锁上，而是读到 `completing` 后返回 409。

占位符扫描：计划正文没有 TBD、TODO、待定，也没有「类似 Task N」这种未展开的实现步骤。`completeUpload`、`tryCompletionLock`、`insertPhotoAndComplete`、`PhotoResponse`、`LibraryDeps` 在前后任务里的名字一致。

## 执行交接

计划保存在 `docs/superpowers/plans/2026-11-04-openalbum-phase2-personal-library.md`。实现时二选一：

1. **Subagent-Driven（推荐）**：每个任务一个新的子代理，任务之间做审查。子代理使用 Composer 2.5，不用 fast 模式。所需技能是 `superpowers:subagent-driven-development`。
2. **Inline Execution**：在同一会话里按 `superpowers:executing-plans` 批量执行，并在检查点停下来审查。

写这份计划的提交不实现个人库代码。
