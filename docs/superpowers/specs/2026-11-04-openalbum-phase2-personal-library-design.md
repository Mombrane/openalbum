# OpenAlbum Phase 2 — 个人照片库设计

日期：2026-11-04  
状态：已定稿（待实现）  
依赖：Phase 1 为 `done`  
对应规格：[`specs/phases/02-personal-library.md`](../../../specs/phases/02-personal-library.md)

本文件是 Phase 2 的实现合同。权威索引仍是 [`specs/SPEC.md`](../../../specs/SPEC.md)。产品背景见 [`2026-11-03-ai-native-photo-album-design.md`](2026-11-03-ai-native-photo-album-design.md)。未写进本文的行为，实现时不得自行补充。

本设计提交只改文档。不改 `apps/**`，不改 `deploy/db/schema.sql`，不改 `deploy/env.example`，也不改 `specs/SPEC.md` 的阶段状态。表结构和环境变量示例留到实现提交，按本文落地。

## 1. 背景与目标

Phase 1 已经回答「请求是谁」。Phase 2 在这个主体上交付个人库：主人本人，以及持有其有效 API Key 的 Agent，可以上传原图、列出、查看、修改允许的元数据，并删除自己的照片。

原图进 S3 兼容对象存储，元数据进 PostgreSQL。上传走服务端中转的 multipart：浏览器或 Agent 把字节交给 API，API 再交给对象存储。客户端不拿预签名上传 URL。

照片插入 `photos` 时状态为 `processing`。EXIF、缩略图、描述、标签和向量是 Phase 3 的事。本阶段不入队、不推进状态机。

交付物只有 HTTP API 与自动化测试。不改 `apps/web`。

实现完成后，`specs/phases/02-personal-library.md` 的验收项应能逐条勾上。本阶段不把该文件的状态改成 `done`；状态仍由实现提交按 `specs/SPEC.md` 的流程更新。

## 2. 已定决策一览

| 议题 | 决定 |
|------|------|
| 上传路径 | 服务端中转。不提供预签名客户端直传 |
| 续传 | S3 Multipart Upload，全程经 API：创建会话 → 上传分片 → 完成。客户端可以中止 |
| 会话方案 | 方案 A：进行中只写 `upload_sessions`（及分片行）。呼叫 `completeMultipartUpload` 之前先把会话标为 `completing`。存储成功之后才 `INSERT photos` |
| 对象键 | 创建会话时预生成 photo UUID。键为 `owners/{userId}/photos/{photoId}/original`。完成时 `photos.id` 用同一个 UUID |
| 单文件上限 | 32 MiB（33554432 字节） |
| 类型 | 白名单固定，见第 6 节。本阶段不按魔数嗅探，也不把名单做成环境变量 |
| 读原图 | 列表和详情返回签名 GET URL。TTL 来自 `S3_SIGNED_URL_TTL`，默认 `15m` |
| 删除 | 先删 `photos` 行。原图尽力删；`thumb_key` 非空时缩略图也尽力删。对象删除失败只记日志，HTTP 仍成功 |
| PATCH | 只能改 `description`、`tags`、`taken_at`、`location_text`、`latitude`、`longitude`。不能改 `content_type`、`object_key`、`status` |
| 他人资源 | 已认证但不是主人：统一 404，文案「未找到」。不使用 403，避免把「没有」和「不是你的」分开 |
| 分层 | 领域层定义端口，不 import S3 SDK。假存储只放在 `gateways/storage` |
| 会话寿命 | 固定 24 小时，用注入的时钟计算。本阶段不另设环境变量 |
| 明确不做 | EXIF、缩略图、向量、搜索、共享册、网页、预签名直传、限流器 |

## 3. 架构与分层

依赖方向与 `scripts/check-layer-boundaries.mjs` 一致：接口层不引用 DAO / 网关；适配层不引用接口层、DAO、网关包；领域层不引用其余四层，也不 import `fastify`、`pg`、`@aws-sdk/*`、`aws-sdk`、`minio`。组合根 `apps/api/src/app.ts` 与 `apps/api/src/index.ts` 负责装配。

`domain/library` 不 import `domain/identity`。适配层从 Phase 1 的 `resolvePrincipal` 取得主体，再把 `{ userId, credentialKind, credentialId }` 和 `now: Date` 传进库用例。

### 3.1 领域 `apps/api/src/domain/library`

纯规则与端口，没有基础设施实现。

- 内容类型白名单、32 MiB 上限、对象键格式。
- 分片集合是否能够完成：编号从 1 连续、字节之和等于声明大小、除最后一片外每片至少 5 MiB。
- 元数据补丁：允许的字段、清空、经纬度成对、标签规范化。
- 可见性：`photo.ownerId === principal.userId` 才算找到。否则领域结果是「未找到」，适配层映射成 404。
- 端口：`PhotoRepository`、`UploadSessionRepository`、`ObjectStorage`。

`ObjectStorage` 只表达这些操作，参数里没有 SDK 类型：

| 操作 | 约定 |
|------|------|
| `createMultipartUpload` | 入参 `key`、`contentType`；返回 `uploadId` |
| `uploadPart` | 入参 `key`、`uploadId`、`partNumber`、字节；返回 `etag` 与字节数 |
| `completeMultipartUpload` | 入参 `key`、`uploadId`、按 partNumber 升序的 `{ partNumber, etag }` |
| `abortMultipartUpload` | 入参 `key`、`uploadId`。对象上已不存在该 upload 时视为成功 |
| `headObject` | 存在则返回 `byteSize`，不存在则返回空 |
| `deleteObject` | 对象已不存在时视为成功 |
| `presignGet` | 入参 `key`、`expiresInSeconds`、`now`；返回 `url` 与 `expiresAt` |

领域服务不决定 HTTP 状态码。适配层把领域结果映射成第 4 节的 DTO 与错误码。

### 3.2 适配层 `apps/api/src/adapters`

用例：`createUpload`、`uploadPart`、`completeUpload`、`abortUpload`、`listPhotos`、`getPhoto`、`patchPhoto`、`deletePhoto`。

用例编排事务、时钟和端口调用。源码不得出现 `from ".../dao"` 或 `from ".../gateways"`。S3 的完成 / 中止顺序见第 5、7 节，写在用例里，不写进领域实体。

两种 `credentialKind` 在本阶段的库路由上等价。`source_key_id` 的写入差异见第 6.3 节，它不改变允许的操作。

### 3.3 DAO `apps/api/src/dao`

实现 `PhotoRepository` 与 `UploadSessionRepository`。完成上传时对会话行 `SELECT … FOR UPDATE`。应用生成 UUID 并写入主键；DDL 里的 `gen_random_uuid()` 只作兜底。

### 3.4 网关 `apps/api/src/gateways/storage`

| 实现 | 用途 |
|------|------|
| S3 兼容客户端 | 生产。允许依赖 `@aws-sdk/client-s3` 与 `@aws-sdk/s3-request-presigner`。只出现在本目录 |
| 内存假存储 | 测试，以及 `buildApp` 未注入存储时的替身。实现同一个 `ObjectStorage` 端口，能创建 multipart、按片覆盖、完成时拼字节、中止、删除、按 key 取大小、签发假的 GET URL |

假 URL 使用 `http://storage.invalid/get`，查询参数只带对象键和过期时间。它不包含访问密钥，也不是真实签名。

内存实现按 key 保存已完成对象。`presignGet` 不检查对象是否存在；调用方只对已经插入的照片签发。

### 3.5 接口层 `apps/api/src/interfaces/http`

路由承载第 4 节的路径、JSON Schema 与状态码，调用适配层用例。不写归属判断，不访问 SQL，不调用 S3 SDK。

分片路由接收原始字节，`Content-Type` 必须是 `application/octet-stream`。这里的「multipart」是 S3 的分片上传，不是 `multipart/form-data`，也不引入 busboy。

该路由的 `bodyLimit` 为 33554432。只有这条路由把 Fastify 的请求体超限映射为 413 `payload_too_large`。其他路由保持现有错误处理，默认请求体上限不变。

### 3.6 组合根

`BuildAppOptions` 增加可选的 `storage` 与 `signedUrlTtlSeconds`。

- 生产入口 `src/index.ts` 先 `loadStorageConfig(process.env)`。缺必填项、取值非法或 TTL 超过 7 天，进程直接退出，不监听端口。成功后再构造 S3 网关，注入 `buildApp`。
- 未传入 `storage` 时，`buildApp` 使用内存假存储，不读取 `S3_ACCESS_KEY_ID` 与 `S3_SECRET_ACCESS_KEY`，也不为这件事打日志。现有身份测试与健康检查不注入存储，必须仍能构造应用。
- 个人库测试必须显式注入内存假存储，用它断言上传、完成和删除，不能依赖「忘了注入所以碰巧是假的」。

未注入时的 TTL 使用 900 秒。生产入口把解析后的 `S3_SIGNED_URL_TTL` 传进去。

## 4. HTTP API 与鉴权

除 Phase 1 已有路由外，本阶段新增下列路由。JSON 请求和响应的字段用 camelCase。入参用 Fastify JSON Schema 校验，`additionalProperties` 为 false，不引入新的校验库。

受保护路由沿用 Phase 1 的 Bearer 解析：先 Access JWT，再 API Key。缺少头、不是 Bearer、凭证无效，一律 401 `unauthorized`，文案「未授权」。本阶段不因为 `credentialKind` 返回 403。

错误体与 Phase 1 相同：

```json
{ "error": { "code": "unauthorized", "message": "未授权" } }
```

已认证但资源不属于当前 `userId`，或 id 不存在：404 `not_found`，文案「未找到」。列表只会查出 `owner_id` 等于当前用户的行，所以别人的照片不会出现在列表里。

| 状态 | `error.code` | 文案 | 何时 |
|------|----------------|------|------|
| 400 | `validation_error` | 见本节固定句 | 入参不合法 |
| 401 | `unauthorized` | 未授权 | 没有可用的 Bearer |
| 404 | `not_found` | 未找到 | 照片或会话不存在，或不属于当前用户 |
| 409 | `upload_closed` | 上传已结束 | 会话已中止，或已过期并被中止 |
| 409 | `upload_completing` | 上传正在完成 | 会话处于 `completing` 时再传分片或中止。另一完成请求正握着该会话的存储互斥时，本次完成也返回这一结果 |
| 409 | `upload_completed` | 上传已完成 | 对已完成的会话再传分片或再中止 |
| 413 | `payload_too_large` | 文件超过 32 MiB | 分片路由的请求体超过 32 MiB |
| 500 | `storage_error` | 对象存储不可用 | 对象存储操作失败，且本文没有把这次失败定义成成功 |
| 500 | `internal_error` | 上传未能完成 | 对象已经完成，但照片行还没写上；客户端应重试完成 |
| 500 | `internal_error` | 删除未能完成 | 照片行未能删除。此时不调用对象删除 |

校验失败时 `message` 只报告第一个问题，且为下列固定句之一：「请求不合法」「标识不合法」「不支持的文件类型」「文件大小须为 1 字节到 32 MiB」「分片不合法」「描述不合法」「标签不合法」「地点不合法」「拍摄时间不合法」「经纬度须成对出现」「经纬度超出范围」。

标识沿用 Phase 1：路径中的 UUID 不匹配 `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`（大小写不敏感）时，400，文案「标识不合法」。写进数据库的 UUID 使用小写。

### 4.1 路由一览

| 方法 | 路径 | 作用 |
|------|------|------|
| `POST` | `/photos/uploads` | 创建上传会话 |
| `PUT` 或 `POST` | `/photos/uploads/:id/parts/:partNumber` | 上传一片。两种方法等价 |
| `POST` | `/photos/uploads/:id/complete` | 完成 multipart，并插入 `photos` |
| `POST` | `/photos/uploads/:id/abort` | 中止未完成的上传 |
| `GET` | `/photos` | 列出当前用户的照片 |
| `GET` | `/photos/:id` | 查看一张照片 |
| `PATCH` | `/photos/:id` | 修改允许的元数据 |
| `DELETE` | `/photos/:id` | 删除照片 |

`:id` 在上传路由上是会话 id，在照片路由上是 `photos.id`。没有列出会话的接口。进行中的上传不会出现在 `GET /photos`。客户端保存创建会话时返回的 `upload.id`。

`GET /photos/:id` 的 `:id` 先按 UUID 校验。`uploads` 这种非 UUID 落到这里时返回 400「标识不合法」，而不是 404。

### 4.2 `POST /photos/uploads`

Bearer：Access JWT 或 API Key。

请求：

```json
{ "contentType": "image/jpeg", "byteSize": 12345 }
```

`contentType` 是字符串。实现先 trim，再把类型和子类型转成小写，拒绝带参数的值（不接受 `image/jpeg; charset=binary`）。结果必须属于第 6 节的白名单，否则 400「不支持的文件类型」。

`byteSize` 是 JSON 整数，闭区间 1 到 33554432。否则 400「文件大小须为 1 字节到 32 MiB」。未知字段、缺字段、类型不对：400「请求不合法」。先判断形状，再判断类型，再判断大小。

成功 **201**：

```json
{
  "upload": {
    "id": "<session uuid>",
    "photoId": "<photo uuid>",
    "objectKey": "owners/<userId>/photos/<photoId>/original",
    "contentType": "image/jpeg",
    "byteSize": 12345,
    "expiresAt": "2026-11-05T02:31:00.000Z",
    "status": "open"
  }
}
```

`expiresAt` 是 `now + 24h` 的 ISO 8601 UTC。响应不包含 S3 `uploadId`。每次调用都新建会话，不按内容去重。

创建顺序：

1. 清扫当前用户已过期且仍为 `open` 的会话（第 5.4 节）。不处理 `completing`。清扫失败不阻止本次创建。
2. 生成会话 id 与 photo id，算出对象键，调用 `createMultipartUpload`。
3. 存储成功后再插入 `upload_sessions`。插入失败时尽力 `abortMultipartUpload`，记日志，返回 500 `storage_error`。
4. 存储创建失败则不插行，返回 500 `storage_error`。

### 4.3 `PUT` 或 `POST /photos/uploads/:id/parts/:partNumber`

Bearer。`:partNumber` 必须匹配 `^[1-9][0-9]{0,4}$` 且数值在 1 到 10000。否则 400「分片不合法」。前导零不合法。

请求体是原始字节，`Content-Type` 为 `application/octet-stream`。其他媒体类型，或空正文：400「分片不合法」。正文超过 32 MiB：413「文件超过 32 MiB」。

同一 `partNumber` 再次上传会覆盖这一片的字节、ETag 和字节数。累计大小按每个编号的最新一片计算，不得超过会话的 `byteSize`，也不得超过 32 MiB。超过时不调用对象存储，返回 400「分片不合法」。

小于 5 MiB 的分片允许先收下。它是不是最后一片，到完成时再判断。

成功 **200**：

```json
{ "part": { "partNumber": 1, "etag": "\"etag-from-storage\"", "byteSize": 5242880 } }
```

`etag` 原样保存网关返回的字符串，完成时原样交回。客户端在完成请求里不必、也不能提交 ETag。

会话不属于当前用户，或 id 不存在：404。状态为 `completing`：409 `upload_completing`，文案「上传正在完成」。不调用对象存储，不写分片行。已中止，或仍为 `open` 但此次发现过期：按第 5.4 节中止后返回 409 `upload_closed`。已完成：409 `upload_completed`，不修改对象。

只有 `open` 且未过期才收下分片。处理时先锁会话行。锁内若不是这个状态，按上一段的状态码返回，不发起 `uploadPart`。确认是 `open` 之后，可以在持锁期间调用 `uploadPart`，再写分片行。对象存储拒绝该片时返回 500 `storage_error`，不写分片行。

### 4.4 `POST /photos/uploads/:id/complete`

Bearer。正文省略，或是 `{}`。出现其他字段：400「请求不合法」。

分片集合不满足第 5.3 节：400「分片不合法」，不调用完成，不插入 `photos`，状态保持 `open`。

持锁校验通过后，先把会话写成 `completing` 并提交，然后才呼叫 `completeMultipartUpload`。`completing` 期间分片与中止得到 409，分片行不再变化。另一完成请求正握着该会话的存储互斥时，本次完成也返回 409 `upload_completing`，不发起第二次存储调用。互斥已经释放（上次请求结束或进程已退出）且 `object_completed_at` 仍为空时，再次完成沿用冻结的分片行继续呼叫存储，见第 5.2 节。

对象存储的完成调用成功之后，才写 `object_completed_at` 并插入 `photos`。插入的列见第 6.3 节。首次成功 **201**，正文是第 4.7 节的 `{ "photo": ... }`。

已经完成且照片还在：再次完成返回 **200** 和同一张照片，不第二次创建对象。已经完成但照片已被删除：404，不把照片插回去。

对象存储完成失败，且第 5.2 节的补救也不成立：500 `storage_error`，把 `completing` 改回 `open`，`photos` 中没有这张图。客户端可以改分片或中止后再试。改回 `open` 若失败，会话留在 `completing`；再次完成仍可重试对象存储，此期间仍然拒绝分片与中止。

对象已经完成，但数据库没能写下照片行：500 `internal_error`。会话仍可重试；重试不得再创建一遍对象。

### 4.5 `POST /photos/uploads/:id/abort`

Bearer。正文省略，或是 `{}`。出现其他字段：400「请求不合法」。

会话属于当前用户且为 `open`：调用 `abortMultipartUpload`，把状态改为 `aborted`，**204** 空正文。存储返回「upload 不存在」时同样 204。其他存储失败：500 `storage_error`，状态保持 `open`，客户端可以重试中止。

状态为 `completing`：409 `upload_completing`，文案「上传正在完成」。不调用 `abortMultipartUpload`。已经是 `aborted`：204。已经 `completed`：409 `upload_completed`，不删除照片，也不删除对象。不存在或不属于当前用户：404。过期的 `open` 会话走第 5.4 节，成功后 204。`completing` 即使已经过了 `expires_at`，中止仍然是 409，不改走过期中止。

### 4.6 `GET /photos`

Bearer。

查询参数：

| 参数 | 规则 |
|------|------|
| `limit` | 可省略，省略时为 50。十进制整数 1 到 100，不含前导零。其他值 400「请求不合法」 |
| `cursor` | 可省略。无填充 base64url，解码后是 `<createdAt ISO>\n<photo uuid>`。无法解码、时间无效或 uuid 无效：400「请求不合法」 |

没有其他查询参数。未知查询参数：400「请求不合法」。

排序是 `created_at DESC, id DESC`。只查 `owner_id` 等于当前用户的行。`cursor` 是这一用户自己的键集位置：`(created_at, id)` 严格小于游标中的一对。游标即使由别人的照片拼出来，也仍然加上 `owner_id` 条件，不会读出别人的行，也不因此 404。

实现多取一行，用来判断有没有下一页。响应最多 `limit` 条。没有更多行时 `nextCursor` 为 `null`。有更多行时，`nextCursor` 用本页最后一条的 `createdAt` 与 `id` 按上面的格式编码。

成功 **200**：

```json
{
  "photos": [],
  "nextCursor": null
}
```

数组元素与第 4.7 节的 `photo` 对象相同。每条都带新签发的签名 URL。空库返回空数组，不是 404。

### 4.7 `GET /photos/:id`

Bearer。成功 **200**：

```json
{
  "photo": {
    "id": "<uuid>",
    "contentType": "image/jpeg",
    "byteSize": 12345,
    "takenAt": null,
    "locationText": null,
    "latitude": null,
    "longitude": null,
    "description": null,
    "tags": [],
    "status": "processing",
    "originalUrl": "http://storage.invalid/get?key=owners%2F...%2Foriginal&exp=1762220000",
    "originalUrlExpiresAt": "2026-11-04T02:46:00.000Z",
    "createdAt": "2026-11-04T02:31:00.000Z",
    "updatedAt": "2026-11-04T02:31:00.000Z"
  }
}
```

`originalUrlExpiresAt` 等于本次签发所用的 `now + TTL`。每次列表或详情都重新签发，不缓存 URL。响应不包含 `objectKey`、`thumbKey`、`sourceUserId`、`sourceKeyId`、`errorMessage`。

签发失败：500 `storage_error`。不返回缺少 URL 的照片。

### 4.8 `PATCH /photos/:id`

Bearer。正文是 JSON 对象，字段全部可选。空对象 `{}` 合法，不改列，返回当前照片和一张新的签名 URL，**200**。

可以出现的字段只有：

| 字段 | 写入规则 |
|------|----------|
| `description` | 字符串或 `null`。trim。trim 后为空则写入 `null`。JavaScript 字符串长度上限 4000。允许制表符和换行，拒绝其他 U+0000–U+001F 与 U+007F。不合法时「描述不合法」 |
| `tags` | 字符串数组，不能为 `null`。整组替换。最多 32 个。每一项 trim 后长度 1–64，去重并保留第一次出现的顺序。拒绝控制字符（含换行）。空数组在库里写成 `'{}'`，响应里是 `[]`。不合法时「标签不合法」 |
| `takenAt` | `null`，或带时区的 ISO 8601 日期时间。不接受纯日期。不合法时「拍摄时间不合法」 |
| `locationText` | 与 `description` 相同，上限 500。不合法时「地点不合法」 |
| `latitude` 与 `longitude` | 必须同时出现。两个 `null` 表示清空两点。只出现一个，或一空一数：400「经纬度须成对出现」。两个有限数字时，纬度闭区间 −90 到 90，经度闭区间 −180 到 180；超出范围则「经纬度超出范围」 |

`takenAt` 的字符串必须匹配下面的表达式，并且能被解析成时间：

```text
^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$
```

省略的字段保持原值。`updated_at` 在有字段实际写入时改为 `now`；空对象不改 `updated_at`。

`contentType`、`objectKey`、`status`、`byteSize`、`id` 以及其他未列出的字段，只要出现在 JSON 里，就是 400「请求不合法」。状态保持 `processing`，本阶段不因为 PATCH 入队，也不触发重嵌入。

成功 **200**，正文与详情相同。不是主人或照片不存在：404。

### 4.9 `DELETE /photos/:id`

Bearer。照片属于当前用户：在一个事务里删除 `photos` 行并提交，然后尽力 `deleteObject`。HTTP **204**，空正文。

先删行，再删对象。行删除失败时不调用对象删除，返回 500 `internal_error`，文案「删除未能完成」。

对象删除失败，或对象本来就不存在：仍然 204。失败时按第 9 节记日志。不回插已删除的行。

若 `thumb_key` 非空，对这个键同样尽力删除。失败只记日志，响应仍是 204。本阶段新插入的行该列为空。Phase 3 写下缩略图之后，删除仍同时清掉缩略图对象。

再次删除同一 id：404。不存在或不属于当前用户：404，且不调用对象删除。删除照片不中止、不删除 `upload_sessions` 行；完成之后的会话如果还在，再次完成按第 4.4 节返回 404。

## 5. 上传会话、对象键与 multipart

### 5.1 表

实现时把下面的 DDL 追加到 `deploy/db/schema.sql` 的个人库段（`photos` 索引之后）。本设计提交不改该文件。

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

`photo_id` 在完成前不是 `photos` 的外键。`users` 删除时级联删会话。现有测试的 `TRUNCATE TABLE users CASCADE` 因此仍然够用。

`photos` 的列保持现状。本阶段不写 `thumb_key` 与 `error_message`（保持空）。不修改 `jobs`。

### 5.2 对象键与完成顺序

对象键只有这一种形式，由服务端生成，客户端不能指定：

```text
owners/{userId}/photos/{photoId}/original
```

`userId` 与 `photoId` 是小写 UUID。键不以 `/` 开头，也不含桶名。`CreateMultipartUpload` 使用会话里的 `contentType`，让对象的 Content-Type 与库中的列一致。

完成时的顺序：

1. 事务里 `SELECT … FOR UPDATE` 会话行。不是主人或不存在则 404。`aborted` 则 409 `upload_closed`。`completed` 则按第 4.4 节返回照片或 404。状态为 `open` 且 `expires_at <= now` 且 `object_completed_at` 为空：进入过期中止，不写成 `completing`。
2. `object_completed_at` 已有值：跳过对象存储，进入第 6 步。
3. 仅当状态仍为 `open` 时校验分片。不满足第 5.3 节：400「分片不合法」，状态保持 `open`，不调用对象存储。进入 `completing` 之前做完这次校验。
4. 校验通过后，仍在同一事务里把状态写成 `completing` 并提交，然后释放行锁。同一会话同时只允许一个完成请求呼叫对象存储。互斥使用会随数据库连接断开而释放的锁（PostgreSQL advisory lock 即可）。行锁释放后，分片请求能读到 `completing` 并返回 409，而不是堵在行锁上。拿不到互斥的完成请求返回 409 `upload_completing`，不呼叫存储。已经是 `completing`、互斥又已空闲的重试不再改分片集合，直接使用锁内读到的分片行。
5. 持有互斥时，在行锁之外调用 `completeMultipartUpload`，使用第 4 步提交前读到的 ETag。成功后用单独的短事务写下 `object_completed_at = now`，状态保持 `completing`。若存储返回 upload 已不存在，则 `headObject`：字节数等于 `byte_size` 时同样写下 `object_completed_at`。其他失败：仅当 `object_completed_at` 仍为空时把状态从 `completing` 改回 `open`，返回 500 `storage_error`，不插照片。条件不成立时改为进入第 6 步，不得把已完成对象的会话退回 `open`。
6. 再开事务插入 `photos`，把会话改为 `completed`。主键冲突说明并发的另一次完成已经插入：读出该照片，返回 200。
7. 第 5 步已经成功但第 6 步失败：返回 500 `internal_error`。再次 `complete` 看到 `object_completed_at` 后只做第 6 步。

完成路径在持有会话行锁期间不做网络 I/O。分片路径可以在持有该行锁期间调用 `uploadPart`。完成在释放行锁之前把状态提交为 `completing`，对象存储调用期间另持一把会随数据库连接断开而释放的互斥。随后的分片与中止得到 409：既改不到这次完成所使用的 ETag，也不会中止这次 multipart。

### 5.3 分片规则

- 单文件以及各片字节之和的上限都是 32 MiB。
- S3 要求除最后一片外，每一片至少 5 MiB（5 × 1024 × 1024 = 5242880 字节）。最后一片至少 1 字节，可以小于 5 MiB。
- 完成时把已保存的分片按 `partNumber` 升序排列，必须正好是 `1..n`，没有空缺。
- 除最后一片外，每一片 `byte_size >= 5242880`。
- 各片 `byte_size` 之和等于会话声明的 `byteSize`。
- 在 32 MiB 上限和 5 MiB 下限同时成立时，最多 7 片。超过 7 个编号，或出现空缺，完成时返回 400「分片不合法」。上传接口仍接受 S3 的 1 到 10000 编号；片数、连续性与 5 MiB 下限在完成时判定。
- 整个文件可以只有一片。这一片就是最后一片，大小等于 `byteSize`，允许小于 5 MiB。

### 5.4 过期与中止

`expires_at = now + 24h`。没有后台扫表任务，那是 Phase 3 worker 的范围。

过期处理只针对 `open`。`completing` 即使过了 `expires_at` 也不 Abort。这种会话上的分片与中止返回 409 `upload_completing`，完成请求继续第 5.2 节。

过期的 `open` 会话在下一次分片、完成、中止，或该用户再次创建会话时处理：

- `object_completed_at` 为空：调用 `abortMultipartUpload`。存储成功或 upload 已不存在时，把状态改为 `aborted`。
- 分片与完成遇到这种会话：中止成功后返回 409 `upload_closed`，并且不收下这片字节、不插入照片。存储中止失败则 500 `storage_error`，状态保持 `open`。
- 显式中止遇到这种会话：与第 4.5 节相同。成功为 204。存储失败为 500，状态保持 `open`。
- 创建会话时的清扫只处理当前 `owner_id`。某一个旧会话的中止失败：只记日志，留下 `open`，不让本次创建失败。下次创建会再试。
- `object_completed_at` 已写下的会话不再因为过期去 Abort。完成请求继续插入照片。

客户端中止与过期中止使用同一个 `aborted` 状态。日志可以带原因 `client` 或 `expired`，字段遵守第 9 节。

## 6. 照片行与类型

### 6.1 内容类型

本阶段只接受下列值。以后可以加类型，但要改规格，不能靠配置扩。

普通图片：

- `image/jpeg`
- `image/png`
- `image/webp`
- `image/heic`
- `image/heif`

RAW，至少覆盖这些常见类型，本阶段也只接受这些：

- `image/x-canon-cr2`
- `image/x-nikon-nef`
- `image/x-sony-arw`
- `image/x-adobe-dng`

比较在 trim 与小写化之后进行。不读取文件头。声明与字节不符的对象仍会以 `processing` 入库，由此造成的失败留在 Phase 3。

### 6.2 上限

32 MiB 等于 33554432 字节（32 × 1024 × 1024）。声明大小、单片大小、累计大小都用这个上限。

### 6.3 完成时插入的 `photos` 行

| 列 | 值 |
|----|----|
| `id` | 会话的 `photo_id` |
| `owner_id` | 会话的 `owner_id` |
| `object_key` | 会话的 `object_key` |
| `thumb_key` | `NULL` |
| `content_type` | 会话的 `content_type` |
| `byte_size` | 会话的 `byte_size` |
| `taken_at`、`location_text`、`latitude`、`longitude`、`description` | `NULL` |
| `tags` | `'{}'` |
| `status` | `processing` |
| `source_user_id` | 当前主体的 `userId` |
| `source_key_id` | `credentialKind = api_key` 时写 `credentialId`；密码会话写 `NULL`。密码会话的 `credentialId` 是 Refresh Token 行 id，不能写入引用 `api_keys` 的外键 |
| `error_message` | `NULL` |

这些来源列不出现在 HTTP 正文里。PATCH 不修改它们。

## 7. 列表、详情、PATCH、删除的行为边界

列表和详情的可见集合就是 `owner_id = 当前 userId`。签名 URL 是 GET，有效期是配置的 TTL。URL 的主机、路径和签名算法由网关按 endpoint、region、`S3_FORCE_PATH_STYLE` 和桶名决定。领域层不拼签名。

本阶段原图不读 `S3_PUBLIC_BASE_URL`。该变量留给以后的缩略图或公开基址，Phase 3 再用。

PATCH 的字段集合以第 4.8 节为全部。删除以第 4.9 节为全部：行先走，再尽力删原图；`thumb_key` 非空时缩略图同样尽力删。对象失败不改变 204。

个人库不使用 403 表示「这是别人的照片」。403 仍只属于 Phase 1 里「凭证种类不允许」的那些 Key 管理路由。

## 8. 配置

沿用 `deploy/env.example` 里已有的对象存储变量。实现提交补上 `S3_SIGNED_URL_TTL`，并在注释里写明默认 `15m`、语法与 `JWT_TTL` 相同、上限 7 天。本设计提交不改 `deploy/env.example`。

| 变量 | Phase 2 含义 |
|------|----------------|
| `S3_ENDPOINT` | 绝对 `http` 或 `https` URL。必填。拒绝带 userinfo 的地址，避免密钥写进 URL |
| `S3_REGION` | 必填，非空 |
| `S3_BUCKET` | 必填，非空 |
| `S3_ACCESS_KEY_ID` | 必填，非空。只交给 S3 客户端 |
| `S3_SECRET_ACCESS_KEY` | 必填，非空。只交给 S3 客户端 |
| `S3_FORCE_PATH_STYLE` | `true` 或 `false`。省略或空白时为 `false`。其他值拒绝启动 |
| `S3_SIGNED_URL_TTL` | 签名 GET 的有效期。省略或空白时为 `15m`。语法复用已有的 `parseDurationSeconds`（正整数加 `s`、`m` 或 `d`）。大于 7 天（604800 秒）拒绝启动 |
| `S3_PUBLIC_BASE_URL` | 本阶段不读取 |

生产入口在配置非法时退出。错误文案只点名变量，不回显密钥或 endpoint 里的用户信息。例如：`S3_SECRET_ACCESS_KEY 缺失`、`S3_SIGNED_URL_TTL 无效`、`S3_SIGNED_URL_TTL 超过 7 天`。

轮换对象存储密钥会使新的签名和上传使用新密钥。已发出的签名 URL 在剩余 TTL 内是否仍可用，由存储服务决定。本阶段不做双密钥。

时长解析复用 `gateways/auth/config.ts` 的 `parseDurationSeconds`，不另写一套单位规则。这是网关内部复用。

## 9. 错误与日志红线

响应正文、日志、错误对象里都不得出现：

- `S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`JWT_SECRET`、`API_KEY_PEPPER`
- `Authorization` 头、Access JWT、Refresh Token、API Key 明文
- 签名 URL 的查询串（`originalUrl` 整段都不要记）
- 分片的原始字节
- S3 SDK 异常的 `message`。这类文本可能带上规范化请求

对象删除失败、清扫中止失败、完成前的存储失败，日志只许带这些字段：`userId`、`photoId`、`objectKey`、`uploadSessionId`、`partNumber`、`byteSize`、`reason`（`client` 或 `expired`）、错误的 `name`。另加一条静态中文，例如「删除对象失败」。

实现时把 `originalUrl` 补进现有日志 redact 路径。身份测试要求的那些 redact 路径保持不动。

500 的正文只有第 4 节的 `code` 与 `message`，不附带存储厂商的 XML 或堆栈。

## 10. 测试策略

新测试放在 `apps/api/test/personal-library.test.ts`，使用现有的 `node:test` 与 `buildApp().inject`。仓储走真实 PostgreSQL：`DATABASE_URL` 指向本地库，应用含本节 DDL 的 `deploy/db/schema.sql`。缺少 `DATABASE_URL` 时测试失败，而不是跳过。

对象存储使用注入的内存假实现，类型来自 `gateways/storage`。不连接真实的 S3 或 COS。时钟沿用现有的可替换时钟。哈希与 JWT 仍用真实网关。`npm test` 里的分层边界检查必须通过，并且 `domain/library` 的源码不出现 `@aws-sdk/`、`aws-sdk`、`minio`。

断言至少覆盖：

1. 主人用 Access JWT 创建会话、上传一片、完成。响应 201，`status` 为 `processing`。列表里能看到该照片，并带 `originalUrl` 与 `originalUrlExpiresAt`。`photos.object_key` 等于 `owners/{userId}/photos/{photoId}/original`，`photos.id` 等于创建时的 `photoId`。完成之前 `photos` 没有这一行，`upload_sessions.status` 为 `open`。
2. 同一用户的 API Key 走完上传、列表、详情、PATCH、删除。`source_key_id` 等于该 Key 的 id。用 JWT 完成的那张照片，`source_key_id` 为 `NULL`，`source_user_id` 为用户 id。
3. 另一个用户的 JWT 与 API Key 调用详情、PATCH、删除、分片、完成、中止，都得到 404，`error.code` 与 `error.message` 相同。列表不含这张照片。
4. PATCH 能写第 4.8 节的每个字段，也能用 `null` 或空标签清空。请求体里的 `contentType`、`objectKey`、`status` 返回 400「请求不合法」，数据库中的这三列不变。
5. 删除返回 204。行消失。假存储收到对该 `objectKey` 的删除。让假存储的删除抛错时，响应仍是 204，行仍然消失，日志不含密钥和签名 URL。
6. `byteSize` 为 0 或 33554433 时创建失败，文案「文件大小须为 1 字节到 32 MiB」。白名单之外的 `contentType` 返回「不支持的文件类型」。白名单中的四种 RAW 与 `image/heic` 可以创建会话。
7. 两片式续传：第一片至少 5 MiB，第二片补满声明大小，完成后对象字节数等于 `byteSize`。只上传一片且该片等于声明大小时，即使小于 5 MiB 也能完成。非最后一片小于 5 MiB，或字节之和不等于声明大小，或编号空缺：完成返回 400「分片不合法」，且没有 `photos` 行。
8. 同一 `partNumber` 上传两次，完成使用的是后一片的字节。
9. 中止后再次上传分片得到 409 `upload_closed`。完成后再次完成得到 200 和同一 `id`。完成后中止得到 409 `upload_completed`。让完成时的存储调用失败：没有 `photos` 行，会话从 `completing` 回到 `open`。
10. 把时钟拨过 `expiresAt` 再上传分片：假存储记录到 Abort，会话变为 `aborted`，响应 409 `upload_closed`。
11. `S3_SIGNED_URL_TTL` 的解析：空白为 900 秒，`15m` 为 900 秒，超过 7 天拒绝。这一条可以留在本文件，也可以放在 `apps/api/test` 下单独的存储配置测试。列表返回的 `originalUrlExpiresAt` 等于注入时钟加上测试传入的 TTL。
12. `npm test` 的分层边界检查通过。身份测试与 `GET /health` 在不配置 `S3_*` 时仍然通过。
13. 完成进行中：假存储在 `completeMultipartUpload` 内阻塞，且会话状态已经是 `completing`。此时覆盖分片与中止都返回 409 `upload_completing`，文案「上传正在完成」。分片行与未完成的 multipart 保持进入 `completing` 之前的内容。阻塞结束后，完成仍能插入照片。

## 11. 范围外与后续阶段

本阶段不做：

- EXIF、缩略图、视觉模型、嵌入、`jobs` 入队，以及把 `processing` 改成 `ready` 或 `failed`（Phase 3）
- 搜索与 `POST /photos/search`（Phase 4）。列表只有主人维度和 `created_at` 键集分页
- 共享册，以及按册角色返回 403（Phase 5）
- 网页瀑布流，以及任何 `apps/web` 改动（Phase 6）
- 预签名或表单直传。客户端不接触 S3 凭证，也不收到用于 PUT 的签名 URL
- 限流器，以及任何具体的请求阈值
- 按魔数、扩展名或文件名识别类型。本阶段没有文件名列
- 列出会话、查询单个会话、按内容去重
- 删除用户。表上的 `ON DELETE CASCADE` 只保证行能被级联删掉；用户删除时的对象清理不在本阶段
- 加密参数、存储类别、双密钥、CDN

Phase 3 可以读取本阶段留下的 `processing` 行。本阶段不预插 `jobs`。

## 12. 验收对照

与 `specs/phases/02-personal-library.md` 的验收项对应关系如下。实现提交才能勾选。

| 阶段验收 | 本文何处 |
|----------|----------|
| 主人用 JWT 或自己的 API Key 都能上传并在列表中看到该照片 | 第 4 节两种 Bearer 等价；第 10 节第 1、2 条 |
| 其他用户不能读取或删除该照片 | 第 4 节 404「未找到」；第 10 节第 3 条 |
| 元数据修改只作用于调用者有权的照片 | 第 4.8 节；越权与 JWT/Key 的否定用例在第 10 节第 3、4 条 |
| 对象键与数据库行一致；存储凭证不出现在日志或响应正文 | 第 5.2、6.3、9 节；第 10 节第 1、5 条 |
| 未配置真实对象存储时，测试可以使用本地假实现，且假实现位于网关层 | 第 3.4、3.6、10 节 |
| 领域层边界检查仍然通过 | 第 3、10 节第 12 条 |

## 13. 已确认决策

- 上传是服务端中转的 S3 multipart：创建会话、分片、完成、中止。
- 方案 A：`upload_sessions` 记录进行中的上传。呼叫对象存储完成之前会话进入 `completing`，此期间拒绝分片与中止。存储成功后才插入 `photos`，状态 `processing`。
- 对象键在创建时由预生成的 photo UUID 决定，完成时插入同一 id。
- 单文件 32 MiB。类型白名单按第 6.1 节固定。
- 列表和详情返回可配置 TTL 的签名 GET URL，默认 15 分钟。
- 删除先删行，对象尽力删，失败只记日志。
- PATCH 只覆盖第 2 节列出的元数据字段。
- 他人资源统一「未找到」。
- 领域层不引入 S3 SDK。假存储只在 `gateways/storage`。
- 不做 EXIF、缩略图、向量、搜索、共享册、网页、预签名直传和限流器。
