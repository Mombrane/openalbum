# OpenAlbum Phase 3 — 处理流水线设计

日期：2026-11-06  
状态：已定稿（待实现）  
依赖：Phase 2 为 `done`  
对应规格：[`specs/phases/03-processing-pipeline.md`](../../../specs/phases/03-processing-pipeline.md)

本文件是 Phase 3 的实现合同。权威索引仍是 [`specs/SPEC.md`](../../../specs/SPEC.md)。产品背景见 [`2026-11-03-ai-native-photo-album-design.md`](2026-11-03-ai-native-photo-album-design.md)。个人库的上传、列表与删除合同见 [`2026-11-04-openalbum-phase2-personal-library-design.md`](2026-11-04-openalbum-phase2-personal-library-design.md)。未写进本文的行为，实现时不得自行补充。

本设计提交只改文档。不改 `apps/**`，不改 `deploy/db/schema.sql`，不改 `deploy/env.example`，不改 `deploy/systemd/`，也不改 `specs/SPEC.md` 的阶段状态。`specs/phases/03-processing-pipeline.md` 只增加设计链接，状态保持 `planned`。表结构、环境变量示例和 worker 单元留到实现提交，按本文落地。

## 1. 背景与目标

Phase 2 把原图放进对象存储，并插入 `photos`，状态为 `processing`。完成上传的事务只写照片和会话，不写 `jobs`。`thumb_key` 与 `error_message` 保持空。列表和详情能签发原图的签名 URL。PATCH 可以改元数据，但不会入队，也不会改 `status`。

Phase 3 在这张 `processing` 的照片上补齐异步流水线：读 EXIF、生成缩略图、调用外部视觉模型填写仍为空的描述与标签、调用外部嵌入模型写入向量，然后把状态改为 `ready`。从本阶段起，首次插入 `photos` 的同一事务插入 `process_photo`。视觉或嵌入失败时原图仍可访问，状态变为 `failed`，语义步骤可以再跑。主人或 Agent 改了描述或标签之后，可以只重做嵌入。

模型调用只走外部 HTTP。进程内不加载、不运行大模型。

本地、CI 与非 production 的 worker 在没有真实视觉或嵌入时，用网关层的假实现跑完同一条流水线。`npm test` 注入这些假实现，不把填好生产密钥写成失败条件。`NODE_ENV=production` 时，视觉、嵌入或 S3 占位符让 worker 退出；生产环境的 API 在 S3 占位符上同样退出。两种情况都不用假网关把照片标成 `ready`，见第 9 节。

交付物是 worker、流水线用例、照片响应上的缩略图与错误码、一个重试路由，以及自动化测试。不改 `apps/web`。

实现完成后，`specs/phases/03-processing-pipeline.md` 的验收项应能逐条勾上。本阶段不把该文件的状态改成 `done`；状态仍由实现提交按 `specs/SPEC.md` 的流程更新。

## 2. 已定决策一览

| 议题 | 决定 |
|------|------|
| 任务拆分 | 一张照片两种任务：`process_photo` 与 `reembed`。`process_photo` 在同一条 job 内按 `exif → thumbnail → vision → embed` 推进，进度写在 `payload.step`。不拆成四条 job |
| 何时插入 job | 首次插入 `photos` 的同一事务插入 `process_photo`。PATCH 只有描述或标签的值真的变了才插入 `reembed`。`POST /photos/:id/retry` 只在 `failed` 时新插一条 `process_photo`。照片已是 `failed` 且已有 `process_photo` 历史行时，再次 `complete` 不入队。`completing` 期间不入队 |
| 领取 | `pending` 且 `run_after <= now`，`FOR UPDATE SKIP LOCKED`。间隔 `PIPELINE_POLL_MS`，本进程并发 `PIPELINE_CONCURRENCY` |
| 重试 | 一次领取跑完剩余步骤。可重试失败最多 5 次（领取时 `attempts` 加一）。退避 30s、60s、120s、240s。维度不符、拒绝类与解码失败立即终态 |
| 幂等 | 同一 `photo_id + type` 至多一条 `pending` 或 `running`。步骤按已落库结果跳过。嵌入在持锁复核文本之后才提交 |
| `photos.status` | `process_photo` 成功才从 `processing` 变为 `ready`。其中途失败保持 `processing` 并写下 `error_message`；终态失败变为 `failed`。`reembed` 成功且已有缩略图时变为 `ready` 并清空错误码；`reembed` 失败不改状态 |
| EXIF | 只补 `taken_at` 仍为空、以及经纬度两者都为空的照片。不写 `location_text`。无偏移的 EXIF 时间按 UTC。解析失败当成没有 EXIF，步骤仍成功 |
| 缩略图 | 键 `owners/{userId}/photos/{photoId}/thumb`。JPEG，质量 80，长边 512，不放大。先按 EXIF 方向转正再去掉元数据 |
| 视觉 | `POST {VISION_API_BASE_URL}/v1/describe`，正文是原图的 base64。只填仍为空的描述和仍为空的标签。超时默认 60s |
| 嵌入 | 文本嵌入，供 Phase 4 用同一网关嵌查询。`POST {EMBED_API_BASE_URL}/v1/embeddings`。超时默认 30s。输入由描述与标签拼成；两者都空时用字面量 `photo` |
| 维度 | 启动时 `EMBED_DIMENSIONS` 必须是 `1536`，与 `vector(1536)` 一致，否则 worker 退出。返回向量的长度校验在领域函数。DAO 在发 SQL 前再挡一次。不匹配则任务失败，事务回滚，不写向量列 |
| 向量事务 | 嵌入 HTTP 在事务外。提交时同一事务：锁照片、复核文本、upsert `photo_embeddings`、更新照片状态、把 job 标为 `done` |
| 进程 | 独立入口 `apps/api/src/worker.ts`，不监听端口。API 进程不轮询。测试调用 `runOnce`，注入假网关和时钟，不睡眠等轮询 |
| 删除 | `photo_embeddings` 已有级联。给 `jobs` 加上 `photo_id` 外键并级联删除。删行之后的对象清理仍按 Phase 2：原图与非空 `thumb_key` 尽力删除 |
| 假实现 | 假视觉、假嵌入、假 EXIF、假缩略图、假对象存储都放在 `gateways/`。开关是 `NODE_ENV`：trim 后等于 `production` 时，视觉、嵌入或 S3 占位符命中则 worker `exit 1`，生产环境的 API 在 S3 占位符上同样 `exit 1`，不用假网关。非 production 的视觉与嵌入占位符仍用假网关，并打一条静态 INFO。测试注入的假实现不看 `NODE_ENV`。API 不读 `VISION_*` / `EMBED_*` |
| 明确不做 | 搜索排序、共享册、人脸、自动事件、网页、反向地理编码、以图搜图、过期上传会话的后台清扫、在 CVM 上跑模型 |

## 3. 架构与分层

依赖方向与 `scripts/check-layer-boundaries.mjs` 一致：接口层不引用 DAO / 网关；适配层不引用接口层、DAO、网关包；领域层不引用其余四层，也不 import `fastify`、`pg`、`@aws-sdk/*`、`aws-sdk`、`minio`、`undici`、`sharp`、`exifr`，以及 `node:http` / `node:https`。组合根 `apps/api/src/app.ts`、`apps/api/src/index.ts`、`apps/api/src/worker.ts` 与现有的 `wire-*.ts` 负责装配。

`domain/library` 不 import `domain/identity`，也不 import `domain/search`。嵌入文本的拼法放在照片库，因为「元数据覆盖后要重嵌入」是照片规则。Phase 4 再消费已经写好的向量。

### 3.1 领域 `apps/api/src/domain/library`

纯规则与端口。本阶段新增的规则集中在一个模块（名称由实现自定，下文按职责称呼）：

- 照片状态是 `processing`、`ready`、`failed` 三者之一。`Photo.status` 从宽字符串收成这个联合类型。`Photo` 增加 `errorCode: string | null`，对应列 `error_message`。
- EXIF 补空、视觉结果是否允许写入、嵌入文本、向量长度与有限数校验、失败种类到「重试或终态」的映射、PATCH 是否构成语义变更。
- 缩略图对象键。原图键函数保持不动。
- 端口在现有 `ObjectStorage`、`PhotoRepository` 上扩展，并增加任务、嵌入、EXIF、缩略图、视觉、嵌入网关。端口的参数和返回值只有普通数据，没有 SDK 类型、没有 `fetch` 的 `Response`。

实现提交必须修改 `scripts/check-layer-boundaries.mjs`，把 `sharp` 和 `exifr` 加入领域层禁止 import 的包名单，与现有的 `fastify`、`pg`、`undici` 放在一起。领域文件 import `sharp` 或 `exifr` 时，`node scripts/check-layer-boundaries.mjs` 的退出码为 1。本设计提交不改该脚本。

`ObjectStorage` 在 Phase 2 的操作之外增加：

| 操作 | 约定 |
|------|------|
| `getObject` | 入参 `key`。对象存在则返回 `body: Buffer` 与 `byteSize`。不存在返回空。其他失败抛错 |
| `putObject` | 入参 `key`、`contentType`、`body`。覆盖同一键。失败抛错 |

Phase 2 已有的 multipart、`headObject`、`deleteObject`、`presignGet` 语义不变。流水线读原图用 `getObject`，写缩略图用 `putObject`。

视觉端口：

```text
describe(input: {
  model: string;
  contentType: string;
  bytes: Buffer;
}): Promise<
  | { ok: true; description: string | null; tags: string[] }
  | { ok: false; kind: "vision_unavailable" | "vision_rejected" }
>
```

嵌入端口：

```text
embed(input: {
  model: string;
  text: string;
}): Promise<
  | { ok: true; values: number[] }
  | { ok: false; kind: "embed_unavailable" | "embed_rejected" }
>
```

网关把 HTTP 状态收成上表的 `kind`。领域见不到状态码和响应正文。长度不符不是网关的 `kind`：网关照实返回 `values`，领域函数判定 `dimension_mismatch` 或 `invalid_embedding`。

EXIF 端口 `read(bytes) -> { takenAt: Date | null; latitude: number | null; longitude: number | null }`。解析不了就返回三个空，不抛错。

缩略图端口 `encode(bytes) -> { bytes: Buffer; contentType: "image/jpeg" }`。解码不了则抛出 `name` 为 `ThumbnailEncodeError` 的错误。适配层只读 `name`，把这一步定为 `thumbnail_failed`。

领域服务不决定 HTTP 状态码。适配层把领域结果映射成第 8 节的 DTO 与错误码。

### 3.2 适配层

照片用例仍在 `apps/api/src/adapters/library`。完成上传、PATCH、删除、重试在这里编排事务。流水线的一次领取放在 `apps/api/src/adapters/pipeline`（目录名固定为 `pipeline`），入口函数 `runOnce(deps, now)`。

适配层调用领域函数决定补哪些字段、要不要入队、失败是重试还是终态。源码不得出现 `from ".../dao"` 或 `from ".../gateways"`。对象存储、视觉、嵌入的调用顺序写在用例里。持有照片行锁期间不做网络 I/O，也不做缩略图编码。

### 3.3 DAO

`apps/api/src/dao` 实现照片、任务和嵌入的 SQL。领取用 `SKIP LOCKED`。嵌入 upsert 使用参数化的 `vector` 输入。应用生成 job 的 UUID；DDL 里的 `gen_random_uuid()` 只作兜底。

### 3.4 网关

| 路径 | 生产 | 测试与占位 |
|------|------|------------|
| `gateways/storage` | 现有 S3 客户端补上 `getObject` / `putObject` | 现有内存假存储补上这两项。`putObject` 按键保存字节；`getObject` 能读到 multipart 完成后的原图和 `putObject` 写入的缩略图 |
| `gateways/vision` | `fetch` 调用第 7.3 节的 HTTP | 内存假视觉。可配置成功正文、连续失败次数、直接拒绝 |
| `gateways/embed` | `fetch` 调用第 7.4 节的 HTTP | 内存假嵌入。按调用方给的维度返回确定向量；可配置错误维度、连续失败、直接拒绝 |
| `gateways/exif` | `exifr` | 内存假读数，测试注入 `takenAt` 与经纬度 |
| `gateways/thumbnail` | `sharp` | 内存假编码器。默认返回一段非空 JPEG 字节；可配置抛出 `ThumbnailEncodeError` |

假实现不发网络请求，不读 `VISION_API_KEY`、`EMBED_API_KEY`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`。

HTTP 网关使用全局 `fetch`，`redirect: "manual"`。遇到 3xx 不再请求下一跳，避免 `Authorization` 被带到别的来源。3xx 视为对应的 `*_rejected`。

### 3.5 接口层

沿用 Phase 2 的照片路由。新增 `POST /photos/:id/retry`。照片 JSON 增加 `thumbUrl`、`thumbUrlExpiresAt`、`errorCode`。路由只做形状校验和用例调用。

### 3.6 组合根

- `buildApp` 仍负责 HTTP。未注入 `storage` 时继续用内存假存储。`buildApp` 不创建视觉或嵌入客户端，不启动轮询，也不读取 `VISION_*`、`EMBED_*`、`PIPELINE_*`、`NODE_ENV`。现有身份测试与健康检查不注入这些配置，必须仍能构造应用。
- `src/index.ts` 仍加载身份与对象存储配置。它不读视觉和嵌入，因此这两侧是占位符时 API 照常监听。`NODE_ENV=production` 且 S3 命中第 9 节的占位符时，API 进程按第 9 节退出。
- `src/worker.ts` 加载同一份环境文件里的数据库、对象存储和流水线配置，按第 9 节决定退出还是构造网关，然后循环调用与 `runOnce` 相同的领取逻辑。它不调用 `listen`。
- 测试不走 `worker.ts`，也不看 `NODE_ENV`。测试直接调用 `runOnce`，并把假网关放进 `deps`。

个人库测试继续显式注入内存假存储。流水线测试显式注入第 3.4 节的假视觉、假嵌入、假 EXIF 和假缩略图，不能依赖「忘了注入所以碰巧是假的」。

## 4. 领域规则与状态机

### 4.1 照片状态

| 状态 | 含义 |
|------|------|
| `processing` | 原图已入库，`process_photo` 尚未成功结束。中途失败也留在这里，直到次数用尽或遇到立即终态 |
| `ready` | 缩略图键已写入，且 `photo_embeddings` 有这一行 |
| `failed` | `process_photo` 终态失败。原图对象保留。已生成的缩略图对象也保留 |

不变量：

- `ready` 的 `error_message` 为空。
- `failed` 的 `error_message` 要么是已经写下的业务码（第 4.4 节里除 `interrupted` 以外的稳定码），要么在仅因租约耗尽、且此前没有业务码时保持为空。它不是上游正文。租约回收不用 `interrupted` 覆盖已有业务码。
- `processing` 的 `error_message` 可以为空，也可以是最近一次可重试失败的业务码。租约回收不改写这一列。
- 列表和详情仍返回这三种状态的照片。本阶段不按状态过滤。

`process_photo` 的终态失败只把仍为 `processing` 的行改成 `failed`。已经是 `ready` 的行保持 `ready`。

`reembed` 成功时：若 `thumb_key` 非空，把状态改为 `ready` 并清空 `error_message`；若 `thumb_key` 为空，不改状态，也不清空已有错误码。这样，缩略图还没做成时，只补嵌入不会把照片标成 `ready`。

`reembed` 失败时不改 `photos.status`，也不改 `error_message`。失败记在该 job 的 `last_error` 和 worker 日志里。已有向量行保持原样。

### 4.2 步骤顺序

`process_photo` 的 `payload` 形如 `{"step":"exif"}`。`step` 只取 `exif`、`thumbnail`、`vision`、`embed`、`done`。新任务从 `exif` 开始。

顺序固定为 EXIF、缩略图、视觉、嵌入。EXIF 放在缩略图之前：缩略图解码失败时，拍摄时间和 GPS 已经按补空规则写上。视觉使用原图字节，不使用缩略图。嵌入使用视觉或用户留下的文本，所以排在视觉之后。

一次领取从当前 `step` 做到成功、可重试失败或终态失败，中间不把 job 放回 `pending`。每一步成功后先提交该步的数据和下一 `step`，再开始下一步的外部调用。进程在两次提交之间退出时，租约回收从已提交的 `step` 继续。

`reembed` 的 `payload` 固定为 `{"step":"embed"}`。它不读 EXIF，不生成缩略图，不调用视觉。

### 4.3 EXIF 补空

领域函数输入是当前照片和 EXIF 读数，输出只含允许写入的字段：

- `takenAt`：照片的 `takenAt` 为空，且读数是有效时间，才输出。
- 经纬度：照片的 `latitude` 与 `longitude` 都为空，且读数两个都是有限数、纬度在闭区间 −90 到 90、经度在闭区间 −180 到 180，才成对输出。只读到一个坐标时，两个都不写。
- 不输出 `locationText`、`description`、`tags`。

写入使用条件更新：`taken_at IS NULL` 才写时间；`latitude IS NULL AND longitude IS NULL` 才写坐标。用户或 Agent 在 worker 读完之后、写之前 PATCH 过的值会留下来。

无 EXIF、坏 EXIF、空文件：读数为空，这一步成功。不因此把照片标为 `failed`。

### 4.4 失败种类

| 种类 | 来源 | 处置 |
|------|------|------|
| `storage` | `getObject` / `putObject` / `headObject` 抛错 | 可重试 |
| `original_missing` | 原图 `getObject` 得到空 | 立即终态 |
| `thumbnail_failed` | 编码器抛出 `ThumbnailEncodeError` | 立即终态 |
| `vision_unavailable` | 视觉超时、网络失败、429、500、502、503、504 | 可重试 |
| `vision_rejected` | 视觉其他 4xx、3xx、200 但 JSON 不是约定形状 | 立即终态 |
| `embed_unavailable` | 嵌入超时、网络失败、429、500、502、503、504 | 可重试 |
| `embed_rejected` | 嵌入其他 4xx、3xx、200 但没有数值数组 | 立即终态 |
| `dimension_mismatch` | 数组长度与期望维度不同 | 立即终态 |
| `invalid_embedding` | 数组含非有限数 | 立即终态 |
| `interrupted` | 运行中的任务超过租约 | 只出现在回收日志的 `errorCode`，不写入 `jobs.last_error` 或 `photos.error_message`。关机时没写完的任务改回 `pending`，日志也不记这个码 |

稳定码就是上表左列的字符串。`jobs.last_error` 与 `photos.error_message` 只存业务码，也就是除 `interrupted` 以外的那些字符串。`interrupted` 不入库。

可重试：领取后的 `attempts` 小于 5 时，job 回到 `pending`，`run_after = now + delay`。`delay` 秒数是 `min(30 * 2^(attempts - 1), 900)`。因此四次等待依次是 30、60、120、240 秒。第 5 次仍可重试失败，则 job 为 `failed`；若类型是 `process_photo` 且照片仍为 `processing`，照片改为 `failed`。

立即终态不受 `attempts` 影响，第一次就 `failed`。

文本在嵌入 HTTP 返回之后变了：这不是失败，也不占用上面的 5 次额度。不把这次向量写进去。job 回到 `pending`，`run_after = now`，`locked_at` 清空，`attempts` 减 1（不低于 0），用来抵消这次领取加上的 1。下一步会用新文本再嵌一次。

### 4.5 已填写字段

视觉归一化的字符允许集与 Phase 2 第 4.8 节的 PATCH 相同。长度的处置不同：PATCH 拒绝超长描述；视觉把超长描述截断后再写入。

- 描述：trim。trim 后为空则当作没有描述。允许制表符（U+0009）与换行（U+000A）。拒绝其他 U+0000–U+001F 与 U+007F；含这些字符则整段描述当作没有，不因此让视觉步骤失败。长于 4000 个 UTF-16 码元时截到 4000；若截断处落在高代理项，再去掉那一个码元。PATCH 仍按 Phase 2 拒绝超长描述，不截断。
- 标签：与 Phase 2 标签相同的允许集。每一项 trim。拒绝控制字符，含制表符和换行（U+0000–U+001F 与 U+007F）。去掉空项、含控制字符的项、长度不在 1–64 的项，去重并保留第一次出现的顺序，最多 32 个。多出来的丢掉，不因此让视觉步骤失败。

归一化之后：

- 照片 `description` 已非空：不写描述。
- 照片 `tags` 长度大于 0：不写标签。
- 两个都已经有值：不调用视觉 HTTP。
- 模型返回空描述且空标签：步骤成功，列保持原样。

这些判断落在条件 SQL 上，见第 5.5 节。领域函数先算出「想写的值」，DAO 再用「列仍为空」保护。

嵌入文本由领域函数 `embeddingInput` 生成，只看 `description` 和 `tags`：

1. 描述非空则作为第一行。
2. 标签非空则把标签用 `", "` 接成一行。
3. 两行都没有时，返回小写字面量 `photo`。
4. 有内容时用一个 `\n` 连接。

不把原图字节、对象键或用户 id 送进嵌入模型。

### 4.6 语义变更

PATCH 的字段集合与 Phase 2 相同。领域函数判断「语义是否变化」：

- `description` 出现在补丁里，且归一化后的值与当前列不同（`null` 与 `null` 相同）。
- `tags` 出现在补丁里，且长度与每一项顺序都与当前数组不同。

只改 `takenAt`、`locationText`、`latitude`、`longitude` 时，语义没有变化。空补丁没有变化。

语义没有变化：不插入 `reembed`。

语义有变化：在同一事务里看未结束任务。已有 `pending` 或 `running` 的 `process_photo` 时，不插入 `reembed`，进行中的流水线会在嵌入步读到新文本。已有未结束的 `reembed` 时，也不再插入，那条任务会在写入前复核文本。否则插入一条新的 `reembed`。

Phase 2 合同里「PATCH 不入队」到此为止。本阶段只对上述语义变化入队。

## 5. 任务编排与 worker

### 5.1 任务行

`jobs.status` 只使用 `pending`、`running`、`done`、`failed`。`jobs.type` 只使用 `process_photo`、`reembed`。

| 列 | 写入 |
|----|------|
| `id` | 应用生成的小写 UUID |
| `type` | `process_photo` 或 `reembed` |
| `photo_id` | 照片 id。实现时新增的外键，删除照片时级联删除任务 |
| `payload` | `{"step":"..."}`。不放图片字节、签名 URL、密钥 |
| `status` | 见下文 |
| `attempts` | 插入时为 0。每次成功领取加 1 |
| `last_error` | 稳定码或空 |
| `run_after` | 插入时为 `now`。退避时改为到期时间 |
| `locked_at` | 领取时写成 `now`，回到 `pending` 或结束时清空 |

未结束是指 `pending` 与 `running`。`done` 与 `failed` 留在表里，供测试和排障阅读。新的重试再插一行，不把旧的 `failed` 行改回 `pending`。

部分唯一索引保证同一照片、同一类型至多一条未结束任务。冲突时插入方视为「已经有人负责」：完成上传的补插忽略冲突；PATCH 在锁内先查询，不会靠冲突来决定业务结果；重试在锁内先查询。

### 5.2 谁在何时插入

**首次入库。** 适配层用现有的 id 生成器造出 job id，放进 `insertPhotoAndComplete` 的入参。该函数已经在一个事务里插入 `photos` 并把会话改成 `completed`。同一事务、照片插入成功的分支里插入 `process_photo`，`step` 为 `exif`，`run_after` 为这次完成使用的 `now`。照片插入因主键冲突回滚并返回 `exists` 时，这一事务里没有新的 job。DAO 只执行插入，不判断要不要入队；首次成功插入一定入队。

`exists` 之后另做一次短事务补救：照片存在、状态为 `processing`、且该照片没有任何 `process_photo` 行（四种状态都算）时，插入一条 `process_photo`。已有 `failed` 或 `done` 的 `process_photo` 时不补。照片状态已是 `failed` 且已经有历史 `process_photo` 行时，再次 `complete` 不插入任务，也不把状态改回 `processing`；要重跑必须调用 `POST /photos/:id/retry`。唯一冲突忽略，完成接口仍按 Phase 2 返回已有照片。其他数据库错误返回 500 `internal_error`，文案「上传未能完成」，不删除已经存在的照片。客户端再次完成会再试补插；照片若已是 `failed`，这次重试完成仍然不入队。

会话处于 `open` 或 `completing`、对象存储尚未完成、照片行还不存在时，不插入 job。worker 不读 `upload_sessions`。

**PATCH。** 仓储提供锁住照片行的事务回调。适配层在回调里读取当前行和未结束任务，调用第 4.6 节的领域函数，再让仓储写元数据和可选的 job。DAO 不自行判断语义有没有变化。更新失败则整个事务回滚，返回 500，文案「修改未能完成」。事务已经提交之后，签发 URL 失败仍按 Phase 2 返回 500 `storage_error`；已经写上的元数据和任务保留。

**重试。** 第 8.3 节。同一种事务回调里锁照片。状态不是 `failed` 则不插任务。是 `failed` 时：把状态改回 `processing`，`error_message` 置空，删除该照片仍为 `pending` 的 `reembed` 行，再插入 `process_photo`（若锁内已经有未结束的 `process_photo` 则不重复插入）。正在 `running` 的 `reembed` 不中途杀掉；它若随后写向量，必须通过第 5.5 节的锁复核，流水线的嵌入步会再覆盖一次。

### 5.3 领取

worker 每一轮和测试里的 `runOnce` 都用调用方传入的 `now`，不用 SQL 的 `now()`。

1. 按第 5.4 节回收过期租约。
2. 本进程正在执行的条数记为 `inFlight`。`runOnce` 开始时 `inFlight` 为 0。可领取条数是 `PIPELINE_CONCURRENCY - inFlight`。小于 1 则这一轮不领取。
3. 在一个事务里执行：

```sql
UPDATE jobs
SET status = 'running',
    attempts = attempts + 1,
    locked_at = $now,
    updated_at = $now
WHERE id IN (
  SELECT id
  FROM jobs
  WHERE status = 'pending'
    AND run_after <= $now
  ORDER BY run_after, created_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT $limit
)
RETURNING id, type, photo_id, payload, attempts, locked_at;
```

后续所有更新都用这里 `RETURNING` 的 `locked_at`，不用本机另造一个时间。PostgreSQL 的时间精度和 `Date` 再塞回去可能对不齐，对不齐会被第 5.5 节当成「锁已经不属于这次领取」。

4. 对领到的每一条执行第 5.5 节。`runOnce` 等待这些条都结束再返回。worker 循环则把它们计入 `inFlight`，睡眠 `PIPELINE_POLL_MS` 后再进入下一轮。睡眠期间不重叠领取超过并发上限。可以顺序执行领到的几条，不要求真并行。

两个 worker 进程同时轮询也由 `SKIP LOCKED` 保证不会领走同一行。部署上仍只跑一个 worker 进程。

### 5.4 租约、回收与关机

租约长度是固定的 600000 毫秒，不设环境变量。一次尝试里的外部调用上限是：读原图 60 秒、写缩略图 60 秒、视觉 60 秒、嵌入 30 秒，总和小于租约。

`locked_at <= now - 600000ms` 且仍为 `running` 的行，先处理 `attempts >= 5`，再回收其余行。两种情况都不改写已有业务码。`last_error` 与照片 `error_message` 里已经是 `vision_unavailable` 这类业务码时，保持原文。两列为空也保持为空，不补上 `interrupted`。

- `attempts >= 5`：job 改为 `failed`，`locked_at` 清空，`last_error` 保持回收前的值。类型是 `process_photo` 且照片仍为 `processing` 时，照片改为 `failed`，`error_message` 保持回收前的值。
- `attempts < 5`：job 改为 `pending`，`run_after = now`，`locked_at` 清空，`attempts` 不变，`last_error` 保持回收前的值。照片状态与 `error_message` 都不变。

每一条被租约回收的任务打一条日志：静态文案「任务租约回收」，`errorCode` 为 `interrupted`。这条 `interrupted` 只存在于日志，不写回 `jobs.last_error`，也不写回照片的 `error_message`。

worker 收到 SIGTERM 或 SIGINT：停止领取，最多再等 60 秒让本进程已领取的任务写完。仍未结束的，把本进程记得的 `id` 与 `locked_at` 对上号之后改回 `pending`，`attempts` 减 1（不低于 0），`locked_at` 清空，`run_after = now`。对不上号说明锁已经不属于这次领取，不再改那一行。然后进程退出。API 进程没有这条循环，不处理这些信号的任务回收。

### 5.5 一次尝试怎么跑

适配层按 `payload.step` 执行。每一步写库都带条件：`jobs.status = 'running'` 且 `jobs.locked_at` 等于本次领取返回的时刻。影响行数为 0 则回滚这一事务，放弃本进程后续步骤。被回收的任务会从已提交的 `step` 再跑，步骤本身可重复执行。

当前 `step` 是 `exif`、`thumbnail` 或 `vision` 时，这一次尝试先 `getObject` 一次原图，后面几步共用这份字节。`reembed` 以及从 `embed` 恢复的 `process_photo` 不下载。若同一次尝试里因为缺少缩略图而退回 `thumbnail`，而手里还没有字节，再 `getObject` 一次。

**exif**

`getObject` 为空则 `original_missing`。抛错则 `storage`。用这份字节调用 EXIF 端口，按第 4.3 节条件更新，把 `step` 改为 `thumbnail`。

**thumbnail**

期望键为 `owners/{userId}/photos/{photoId}/thumb`。`userId` 与 `photoId` 使用库里的小写 UUID。键不以 `/` 开头，不含桶名。

若 `thumb_key` 已经等于期望键：`headObject`。有对象且 `byteSize >= 1` 则把 `step` 改为 `vision`，不再编码。`headObject` 为空则重新编码并覆盖该键。`headObject` 抛错则 `storage`。

编码抛出 `ThumbnailEncodeError` 则 `thumbnail_failed`，不调用 `putObject`。`putObject` 的 `contentType` 为 `image/jpeg`。成功后的短事务把 `thumb_key` 写成期望键（仅当原值为空或已经是期望键），`step` 改为 `vision`。若此时照片行已经不在，回滚，并 `deleteObject` 刚写上的键；对象删除失败只记第 10 节允许的日志。

**vision**

按第 4.5 节，描述和标签都已有值则把 `step` 改为 `embed`，不发 HTTP。否则使用本尝试已经取到的原图字节调用视觉端口。失败按种类结束这一次尝试。成功则在短事务里更新照片，再把 `step` 改为 `embed`。描述列可空，标签列是 `NOT NULL`，所以空结果必须写成「保持原列」，不能把标签更新成 SQL `NULL`：

```sql
UPDATE photos
SET description = CASE
      WHEN description IS NULL AND $description::text IS NOT NULL THEN $description
      ELSE description
    END,
    tags = CASE
      WHEN tags = '{}'::text[] AND cardinality($tags::text[]) > 0 THEN $tags
      ELSE tags
    END,
    updated_at = $now
WHERE id = $photoId
```

没有可写的描述时，`$description` 传 SQL `NULL`。没有可写的标签时，`$tags` 传 `'{}'`，`cardinality` 为 0，列保持不变。用户在视觉返回之前把描述写成非空，或把标签写成非空数组，条件会留下用户的值。

**embed**

事务外用当前读到的照片计算 `embeddingInput` 并调用嵌入端口。失败按种类结束。成功后领域函数检查：期望维度由调用方传入（worker 传入配置里的 1536）；长度不同是 `dimension_mismatch`；任一元素不是有限数是 `invalid_embedding`。这两种都立即终态，并且不调用 DAO 的 upsert。

检查通过后开启事务：

1. `SELECT … FOR UPDATE` 照片。行不在则回滚并停止。
2. 再次计算 `embeddingInput`。与这次 HTTP 使用的文本不同则回滚，按第 4.4 节把 job 放回 `pending`，不写向量。
3. 类型是 `process_photo` 且 `thumb_key` 为空：回滚，不写向量。另开短事务把 `step` 改回 `thumbnail`，job 仍保持这次的 `running` 与原来的 `locked_at`，然后在同一次尝试里从缩略图继续。这只防步骤顺序被写乱。缩略图那一步若终态失败，尝试就结束，不会在嵌入和缩略图之间来回转。
4. DAO upsert 向量。DAO 若发现长度不等于期望维度或含非有限数，必须在发 SQL 之前抛错，事务回滚，适配层记 `dimension_mismatch` 或 `invalid_embedding`。
5. 同一事务更新照片：`process_photo` 把状态改为 `ready`、`error_message` 置空。`reembed` 仅当 `thumb_key` 非空时同样改为 `ready` 并清空错误码。执行到这里时 `process_photo` 的 `thumb_key` 已经非空；`reembed` 看见空键则不改照片的状态和错误码，向量仍然写入，job 仍然结束。
6. 同一事务把 job 改为 `done`，`step` 改为 `done`，`locked_at` 清空，`last_error` 清空。

第 4 到第 6 步任何一步失败都回滚，向量行、照片状态和 job 状态保持进入本事务之前的样子。PostgreSQL 因向量维度报错时同样回滚，照片不会变成 `ready`，列里不会留下半截向量。`reembed` 在空缩略图时的第 5 步不改照片，第 4 步和第 6 步仍提交。

可重试失败写回 job 时，`process_photo` 还把照片的 `error_message` 写成稳定码，状态保持 `processing`。`reembed` 的可重试失败只写 job。

终态失败写回 job 时，`process_photo` 在照片仍为 `processing` 的前提下把照片改为 `failed` 并写上稳定码。`reembed` 只把 job 改为 `failed`。

### 5.6 删除照片

Phase 2 的删除顺序不变：事务里删除 `photos` 行并提交，再尽力删除原图；`thumb_key` 非空时再尽力删除缩略图。失败只记日志，HTTP 仍是 204。

`photo_embeddings.photo_id` 已是 `ON DELETE CASCADE`。实现给 `jobs.photo_id` 同样的级联之后，未结束和历史任务随照片删除。worker 随后的更新影响 0 行，按第 5.5 节放弃。若缩略图对象是在删除提交之后才 `putObject` 成功的，worker 发现照片已不在，就删除刚写的那个键。

删除不处理 `upload_sessions`。

### 5.7 与 `completing` 的关系

Phase 2 在呼叫对象存储完成之前把会话写成 `completing`，此期间拒绝分片和中止。本阶段不改变这段顺序，也不在进入 `completing` 时插入 job。只有 `insertPhotoAndComplete` 提交之后，worker 才能看见 `process_photo`。

worker 不把过期的 `open` 上传会话收成 `aborted`。那仍是 Phase 2 的惰性清扫：下一次创建、分片、完成或中止时处理。Phase 2 设计里「后台扫表留给以后的 worker」一句，不扩大本阶段范围。

## 6. 实现时的表结构

本设计提交不改 `deploy/db/schema.sql`。实现提交把下面的约束并进该文件。新装数据库直接体现在 `CREATE TABLE jobs` 里；已经按旧草图建过表的库执行等价的 `ALTER`。

`photos` 与 `photo_embeddings` 的列保持现状。`photo_embeddings.embedding` 仍是 `vector(1536)`。本阶段不加 IVFFlat / HNSW。

`jobs` 的目标形状：

```sql
-- type: process_photo | reembed
-- status: pending | running | done | failed
-- payload.step: exif | thumbnail | vision | embed | done
CREATE TABLE IF NOT EXISTS jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT NOT NULL,
  photo_id     UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  payload      JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jobs_type CHECK (type IN ('process_photo', 'reembed')),
  CONSTRAINT jobs_status CHECK (status IN ('pending', 'running', 'done', 'failed')),
  CONSTRAINT jobs_attempts CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_jobs_poll ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_jobs_photo ON jobs(photo_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active
  ON jobs (photo_id, type)
  WHERE status IN ('pending', 'running');
```

已有库上的迁移：

1. `ADD COLUMN IF NOT EXISTS photo_id UUID REFERENCES photos(id) ON DELETE CASCADE`。
2. `ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ`。
3. Phase 2 不写入 `jobs`。若仍有 `photo_id` 为空的行，删掉这些行，再 `ALTER COLUMN photo_id SET NOT NULL`。
4. 补上上面的 `CHECK` 与两个索引。旧的 `idx_jobs_poll` 可以保留。

`last_error` 不加枚举约束，避免每一次新增稳定码都改 DDL。允许的码以第 4.4 节为全部。

## 7. EXIF、缩略图、视觉与嵌入

### 7.1 EXIF

生产读数使用 `exifr`，只放在 `gateways/exif`。网关负责：

- 读得出 `DateTimeOriginal`（没有则退到 `CreateDate`）时，若带 `OffsetTimeOriginal` 或等价偏移，用该偏移构造 `Date`。没有偏移时，把那一组年月日时分秒当作 UTC。
- 年份小于 1970 或大于 2100，或结果不是有效时间：返回 `takenAt: null`。
- GPS 转成有符号十进制度。超出第 4.3 节范围则两个坐标都返回空。
- 任何解析异常都变成三个空字段。

领域不猜测时区，也不根据 GPS 反查地名。

### 7.2 缩略图

生产编码使用 `sharp`，只放在 `gateways/thumbnail`。合同：

- 按 EXIF 方向转正，输出不含 EXIF 的 JPEG。
- 长边最大 512 像素，另一边按比例取整，不放大。长宽都已经不超过 512 时，仍重新编码为 JPEG，以便 PNG、WebP、HEIC 的缩略图类型一致。
- 质量 80。
- 输入解码失败：抛出 `ThumbnailEncodeError`。不为 RAW 或 HEIC 合成占位图。解码失败的照片停在 `failed`，原图仍可通过 Phase 2 的签名 URL 读取。用户稍后调用重试；自动退避不会把解码失败当成暂时故障。

对象键见第 5.5 节。`putObject` 与条件更新 `thumb_key` 成功之后，列表和详情才签发缩略图 URL。

`S3_PUBLIC_BASE_URL` 本阶段仍不读取。缩略图与原图使用同一套签名 GET，TTL 仍是 `S3_SIGNED_URL_TTL`。个人库对象保持私有。

流水线使用的 `getObject` 与 `putObject` 在网关内各自 60 秒截止（`AbortSignal` 或 SDK 单次请求的 abort）。不改 Phase 2 multipart 上传的超时。截止到期归类为 `storage`。

### 7.3 视觉 HTTP

`VISION_API_BASE_URL` 去掉末尾斜杠后，路径固定为 `/v1/describe`。配置值是前缀，不是完整路径。

```http
POST /v1/describe
Authorization: Bearer <VISION_API_KEY>
Content-Type: application/json
Accept: application/json
```

```json
{
  "model": "<VISION_MODEL>",
  "image": {
    "contentType": "image/jpeg",
    "dataBase64": "<原图字节的 base64>"
  }
}
```

`contentType` 使用照片行里的值，可以是 Phase 2 白名单中的 RAW 或 HEIC。不在流水线里把原图转成另一种格式再送给视觉模型。提供方拒绝该类型时，结果是 `vision_rejected`，原图仍可访问。

超时来自 `VISION_TIMEOUT_MS`，默认 60000。截止、DNS、连接失败归 `vision_unavailable`。

200 的 JSON：

```json
{ "description": "海边", "tags": ["海", "黄昏"] }
```

`description` 可以是字符串或 `null`，缺省当作 `null`。`tags` 缺省当作 `[]`。忽略多余字段。`description` 既不是字符串也不是 `null`，或 `tags` 不是字符串数组：`vision_rejected`。HTTP 200 且两者都空：成功。

然后按第 4.5 节归一化，再按第 5.5 节的条件 SQL 写入。

单张原图上限 32 MiB，base64 后约 43 MiB。并发上限 8，worker 按这个量准备内存，不另做分块上传协议。

### 7.4 嵌入 HTTP

路径固定为 `{EMBED_API_BASE_URL}/v1/embeddings`，前缀规则与视觉相同。

```http
POST /v1/embeddings
Authorization: Bearer <EMBED_API_KEY>
Content-Type: application/json
Accept: application/json
```

```json
{ "model": "<EMBED_MODEL>", "input": "<embeddingInput 的文本>" }
```

超时来自 `EMBED_TIMEOUT_MS`，默认 30000。状态码分类与视觉对称，种类换成 `embed_unavailable` / `embed_rejected`。

200 的 JSON：

```json
{ "embedding": [0.01, -0.02] }
```

`embedding` 必须是数组。缺字段或元素不是数字：`embed_rejected`。元素是数字但非有限、或长度不对：网关仍把数字数组交给领域，由第 5.5 节判定，并且不写库。

`photo_embeddings.model` 写入配置里的 `EMBED_MODEL`，不写响应里回显的模型名。

假嵌入在测试里，以及非 production 的占位符假网关上，按输入文本变化：同样的文本得到同样的向量，不同文本得到不同向量，长度等于调用方要求的维度。占位符假嵌入必须输出 1536 维。比较时用数值相等即可，不规定具体哈希算法，但同一进程内必须稳定。`NODE_ENV=production` 命中嵌入占位符时进程按第 9 节退出，不构造这个假网关，也不会用假向量把照片标成 `ready`。

### 7.5 维度放在哪一层

1. **配置。** worker 启动时读取 `EMBED_DIMENSIONS`。空白、非整数、或不是 `1536`：进程退出，文案分别是 `EMBED_DIMENSIONS 缺失`、`EMBED_DIMENSIONS 无效`、`EMBED_DIMENSIONS 与向量列不一致`。`1536` 这个数写在 `gateways/embed` 的配置模块里，并注明它必须与 `schema.sql` 的 `vector(1536)` 相同。API 进程不执行这道检查。
2. **领域。** 纯函数比较 `values.length` 与调用方传入的期望值，并检查 `Number.isFinite`。期望值由适配层从配置注入。领域源码不读 `process.env`。
3. **DAO。** upsert 之前再检查一次长度和有限性。通过后把每个数格式化成十进制（不用科学计数法），拼成 pgvector 接受的 `[...]` 文本参数。检查失败不发 SQL。
4. **数据库。** 列类型仍是 `vector(1536)`。类型错误会让第 5.5 节的事务回滚。

因此，配置与列不一致时 worker 根本不领取；模型返回了别的维度时，任务失败且向量列不变。测试观察 `jobs.last_error = dimension_mismatch`。`process_photo` 同时让照片变为 `failed`，`errorCode` 为 `dimension_mismatch`。

## 8. HTTP API

Phase 2 的路由、鉴权、404 文案「未找到」、校验文案和错误体外壳保持不变。两种 Bearer 仍然等价。本阶段不因为 `credentialKind` 返回 403。

在 Phase 2 的照片对象上增加三个字段。列表、详情、完成上传、PATCH、重试返回的 `photo` 都带上它们。没有缩略图时 URL 字段为 `null`，没有错误码时 `errorCode` 为 `null`。三个键始终出现，不用省略表示空。

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
    "errorCode": null,
    "originalUrl": "http://storage.invalid/get?key=owners%2F...%2Foriginal&exp=1762220000",
    "originalUrlExpiresAt": "2026-11-06T02:46:00.000Z",
    "thumbUrl": null,
    "thumbUrlExpiresAt": null,
    "createdAt": "2026-11-06T02:31:00.000Z",
    "updatedAt": "2026-11-06T02:31:00.000Z"
  }
}
```

`thumb_key` 非空时，`thumbUrl` 用与原图相同的 `presignGet` 和同一 TTL。`thumbUrlExpiresAt` 等于这次签发的 `now + TTL`。签发缩略图失败：500 `storage_error`，文案「对象存储不可用」，不返回缺少 URL 的照片。响应仍不包含 `objectKey`、`thumbKey`、`sourceUserId`、`sourceKeyId`，也不包含 `jobs` 行。

`errorCode` 来自 `error_message`。它是业务稳定码。`status` 才是终态：`processing` 配合非空 `errorCode` 表示最近一次尝试的业务失败，还会再跑。租约回收不把 `errorCode` 改成 `interrupted`。`failed` 表示 `process_photo` 已经终态失败。`ready` 时 `errorCode` 为 `null`。

完成上传的响应仍在提交后立即返回，当时状态是 `processing`，缩略图 URL 仍为 `null`。客户端之后用 `GET /photos/:id` 看它是否变成 `ready`。本阶段没有 webhook，也没有单独的任务查询路由。

新增的错误：

| 状态 | `error.code` | 文案 | 何时 |
|------|----------------|------|------|
| 409 | `not_failed` | 照片不在失败状态 | 对 `processing` 或 `ready` 调用重试 |
| 500 | `internal_error` | 修改未能完成 | PATCH 的事务失败 |

### 8.1 沿用的路由

| 方法 | 路径 | 本阶段的变化 |
|------|------|----------------|
| `POST` | `/photos/uploads` | 无 |
| `PUT` 或 `POST` | `/photos/uploads/:id/parts/:partNumber` | 无 |
| `POST` | `/photos/uploads/:id/complete` | 首次插入的同一事务入队，见第 5.2 节。照片已是 `failed` 且已有历史 `process_photo` 行时，再次完成不入队，必须改走 `POST /photos/:id/retry`。响应照片多三个字段 |
| `POST` | `/photos/uploads/:id/abort` | 无 |
| `GET` | `/photos` | 元素多三个字段 |
| `GET` | `/photos/:id` | 多三个字段 |
| `PATCH` | `/photos/:id` | 字段集合不变。语义变化时按第 4.6 节入队。不在响应前等待嵌入完成 |
| `DELETE` | `/photos/:id` | 级联删除嵌入和任务，见第 5.6 节 |
| `POST` | `/photos/:id/retry` | 新增 |

未知的照片字段仍然 400「请求不合法」。不能通过 PATCH 修改 `status` 或 `errorCode`。

### 8.2 `PATCH /photos/:id`

请求和校验与 Phase 2 第 4.8 节相同。成功仍是 200 和当前照片。状态不会因为 PATCH 本身从 `ready` 改成 `processing`。

描述或标签的值变了，且当时没有未结束的 `process_photo` 或 `reembed`：响应返回时，数据库里已经有一条 `pending` 的 `reembed`。worker 稍后写新向量。写完之前，旧向量还在；Phase 4 才会读取向量，本阶段不定义检索结果。

只改拍摄时间、地点或经纬度：不插入任务。

### 8.3 `POST /photos/:id/retry`

Bearer。正文省略，或是 `{}`。出现其他字段：400「请求不合法」。

照片属于当前用户且状态为 `failed`：按第 5.2 节更新并入队，**200**，正文是照片对象，`status` 为 `processing`，`errorCode` 为 `null`。已有的缩略图和向量行保留，新的 `process_photo` 从 `exif` 重新走，靠第 5.5 节的跳过规则避免无意义的覆盖。

状态是 `processing` 或 `ready`：409 `not_failed`，文案「照片不在失败状态」，不插入任务。不存在或不属于当前用户：404。

## 9. 配置

API 进程的必填项与 Phase 2 相同。流水线变量只由 worker 读取。实现提交在 `deploy/env.example` 补上超时的注释和示例；本设计提交不改那个文件。已有变量的占位值保持不变。

| 变量 | 本阶段 |
|------|--------|
| `PIPELINE_POLL_MS` | 空白时 2000。十进制整数，闭区间 200 到 60000。其他值：worker 退出，`PIPELINE_POLL_MS 无效` |
| `PIPELINE_CONCURRENCY` | 空白时 2。十进制整数，闭区间 1 到 8。其他值：`PIPELINE_CONCURRENCY 无效` |
| `VISION_PROVIDER` | 空白或 `http`。其他值：`VISION_PROVIDER 无效`。本阶段没有第二种协议 |
| `VISION_API_BASE_URL` | 绝对 `http` 或 `https` URL，不能带 userinfo。见下方的占位规则 |
| `VISION_API_KEY` | 只放进 `Authorization`。见占位规则 |
| `VISION_MODEL` | 非空时最长 200 个字符。更长：`VISION_MODEL 无效` |
| `VISION_TIMEOUT_MS` | 空白时 60000。整数，闭区间 1000 到 120000。其他值：`VISION_TIMEOUT_MS 无效` |
| `EMBED_PROVIDER` | 规则同 `VISION_PROVIDER`，文案换成 `EMBED_PROVIDER 无效` |
| `EMBED_API_BASE_URL` | 规则同视觉基址 |
| `EMBED_API_KEY` | 只放进 `Authorization` |
| `EMBED_MODEL` | 规则同 `VISION_MODEL`，文案换成 `EMBED_MODEL 无效` |
| `EMBED_TIMEOUT_MS` | 空白时 30000。区间同视觉超时，文案换成 `EMBED_TIMEOUT_MS 无效` |
| `EMBED_DIMENSIONS` | 必须是 `1536`。见第 7.5 节 |
| `S3_PUBLIC_BASE_URL` | 不读取 |
| `S3_*` 其余项 | worker 与 API 一样，用 Phase 2 的 `loadStorageConfig`。语法不合法则进程退出，文案沿用 Phase 2，不回显密钥。占位符另见下方 |
| `NODE_ENV` | trim 后等于 `production` 才是生产。未设置、空白或其他值都按非 production。不新增别的开关 |

占位字符串与 `deploy/env.example` 里的示例值逐字比较，比较前只做 trim：

| 侧 | 命中条件（任一即可） |
|----|----------------------|
| 视觉 | `VISION_API_BASE_URL` 为空白，或去掉末尾斜杠后等于 `https://YOUR_VISION_API_BASE`；或 `VISION_API_KEY` 为空白或等于 `YOUR_VISION_API_KEY`；或 `VISION_MODEL` 为空白或等于 `YOUR_VISION_MODEL` |
| 嵌入 | 与视觉相同的结构，示例值是 `https://YOUR_EMBED_API_BASE`、`YOUR_EMBED_API_KEY`、`YOUR_EMBED_MODEL` |
| S3 | `S3_BUCKET` 等于 `YOUR_BUCKET_NAME`，或 `S3_ACCESS_KEY_ID` 等于 `YOUR_ACCESS_KEY`，或 `S3_SECRET_ACCESS_KEY` 等于 `YOUR_SECRET_KEY` |

基址非空、但带 userinfo 或不是合法的 `http` / `https` URL：不论 `NODE_ENV`，这一侧先退出，文案 `VISION_API_BASE_URL 无效` 或 `EMBED_API_BASE_URL 无效`。退出文案不包含 URL 的用户信息。S3 的语法错误仍用 Phase 2 的文案，先于占位判断。

`NODE_ENV=production` 时，上表任一侧命中：worker 以退出码 1 结束，文案是 `视觉配置仍是占位符`、`嵌入配置仍是占位符` 或 `对象存储配置仍是占位符`。不构造该侧的假网关，不轮询，因此不会用假描述或假向量把照片标成 `ready`。API 进程的 `src/index.ts` 在生产环境命中 S3 占位符时也以退出码 1 结束，文案同样是 `对象存储配置仍是占位符`。API 不读视觉和嵌入变量，不因为这两侧的占位符退出。

非 production：视觉或嵌入命中占位时，该侧使用假网关。假视觉的固定输出是描述 `未配置视觉模型`、标签 `["未配置"]`。假嵌入按第 7.4 节返回 1536 维。worker 启动时对该侧打一条 INFO，文案固定为 `视觉网关使用假实现` 或 `嵌入网关使用假实现`。真实 HTTP 那一侧的 INFO 文案是 `视觉网关使用 HTTP` 或 `嵌入网关使用 HTTP`。这些日志不出现密钥、完整基址和模型字符串。非 production 的 S3 占位符不换成内存假存储；假对象存储只在测试注入。worker 与 API 仍按 Phase 2 构造真实客户端，语法合法就启动。

流水线测试不启动 `worker.ts`，因此 CI 不必提供真实的 S3、视觉或嵌入密钥。`npm test` 也不必为了 `buildApp` 去填这些占位符。配置解析测试要覆盖：非 production 加 `YOUR_VISION_API_KEY` 得到假视觉；`NODE_ENV=production` 加同一占位符时结果是退出，且错误文案不含这枚密钥。

实现时可增加 npm script：`worker` 用 `tsx src/worker.ts`，生产用 `node dist/worker.js`。systemd 另加一个单元草图，`EnvironmentFile` 与 API 相同，`ExecStart` 指向 `dist/worker.js`，不监听端口。这些文件都在实现提交里改。

## 10. 错误与日志红线

响应正文、日志、错误对象里都不得出现：

- `VISION_API_KEY`、`EMBED_API_KEY`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`JWT_SECRET`、`API_KEY_PEPPER`
- `Authorization` 头、Access JWT、Refresh Token、API Key 明文
- 原图或缩略图的签名 URL 查询串，以及 `originalUrl`、`thumbUrl` 整段
- 原图字节、缩略图字节、base64 正文、嵌入向量
- 视觉或嵌入 HTTP 客户端错误的 `message`，以及上游响应正文。这些文本可能带上请求 URL

流水线日志只许带这些字段：`userId`、`photoId`、`objectKey`、`jobId`、`jobType`、`step`、`attempt`、`errorCode`、`errorName`。另加一条静态中文，例如「视觉调用失败」「嵌入调用失败」「缩略图失败」「维度不一致」「对象存储失败」「照片已删除」「任务租约回收」。`errorCode` 在租约回收时是 `interrupted`，在其余流水线日志里是业务码。`errorName` 是异常的 `name`，例如 `ThumbnailEncodeError`。不记录异常的 `message`。

Phase 2 上传路径已允许的字段保持不变。实现时把 `thumbUrl`、`photo.thumbUrl`、`photos[*].thumbUrl`、`dataBase64`、`embedding` 补进现有 redact 路径。身份测试要求的 redact 路径和 `originalUrl` 路径保持不动。worker 使用同一份 redact 配置。

500 的正文只有 `code` 与 `message`，不附带上游 JSON 或堆栈。

## 11. 测试策略

纯规则放在 `apps/api/test/pipeline-rules.test.ts`，不连接数据库。至少覆盖：EXIF 只补空字段、GPS 必须成对、嵌入文本的三种拼法、维度和非法数、可重试退避与第 5 次终态、立即终态不看次数、语义变更的相等比较。

集成测试放在 `apps/api/test/processing-pipeline.test.ts`，使用现有的 `node:test` 与 `buildApp().inject`。仓储走真实 PostgreSQL：`DATABASE_URL` 指向本地库。缺少 `DATABASE_URL` 时失败，而不是跳过。对象存储、视觉、嵌入、EXIF、缩略图都使用 `gateways/` 里的假实现。时钟可替换。`runOnce` 不使用真实的 `setTimeout` 去等待 `PIPELINE_POLL_MS` 或退避；测试把 `now` 拨过 `run_after` 再调用一次。

`npm test` 里的分层边界检查必须通过。实现提交按第 3.1 节把 `sharp` 和 `exifr` 加入 `scripts/check-layer-boundaries.mjs` 的领域禁止名单。`domain/library` 与 `adapters/library`、`adapters/pipeline` 的源码不出现 `@aws-sdk/`、`sharp`、`exifr`、`undici`。适配层源码不出现 `/dao` 与 `/gateways`。

断言至少覆盖：

1. 完成上传的事务提交后有一条 `process_photo`，`payload.step` 为 `exif`，照片状态为 `processing`。会话仍是 `completing`、照片行还不存在时，`jobs` 里没有该 `photo_id`。再次完成返回 200，且 `process_photo` 仍是一行。把照片改成 `failed` 并留下这条历史 `process_photo` 后再完成一次：仍返回已有照片，`jobs` 里该类型的行数不变，状态仍是 `failed`。
2. `runOnce` 使用假 EXIF、假缩略图、假视觉、假嵌入后，照片变为 `ready`，`errorCode` 为 `null`。`thumb_key` 等于 `owners/{userId}/photos/{photoId}/thumb`。假存储里该键的字节非空。描述和标签等于假视觉的返回。`photo_embeddings` 有一行，向量长度 1536，`model` 等于注入的模型名。详情里的 `thumbUrl` 与 `thumbUrlExpiresAt` 有值，`originalUrl` 仍在。
3. 完成之前 PATCH 写入 `takenAt` 和经纬度。假 EXIF 给出不同的时间和坐标。跑完后列仍是用户的值。`locationText` 仍是用户的值或空，不被 EXIF 填写。用户没填的那张照片则会写上假 EXIF 的时间和成对坐标。
4. 用户在流水线之前写了描述和标签：假视觉的调用次数为 0，描述和标签不变，嵌入文本使用用户的内容。只写了标签时，视觉可以填上空的描述，标签保持用户的数组。
5. 假视觉前两次 `vision_unavailable`、第三次成功。第一次 `runOnce` 后 job 为 `pending`，`attempts` 为 1，`run_after` 等于 `now + 30s`，照片仍是 `processing` 且 `errorCode` 为 `vision_unavailable`。把时钟拨过 `run_after` 再跑，最终 `ready`。不在测试里真实睡眠。
6. 假嵌入返回长度为 3 的数组。没有 `photo_embeddings` 行。job 为 `failed`，`last_error` 为 `dimension_mismatch`。照片为 `failed`，`errorCode` 为 `dimension_mismatch`。原图在假存储里仍可 `getObject`。
7. 假嵌入返回含 `NaN` 的数组：同样不写向量，`last_error` 为 `invalid_embedding`。
8. 假缩略图抛出 `ThumbnailEncodeError`：第一次就 `failed`，`errorCode` 为 `thumbnail_failed`，`attempts` 为 1，没有退避中的 `pending` 行。
9. `ready` 之后 PATCH 描述。响应 200 时已有 `pending` 的 `reembed`，状态仍是 `ready`。`runOnce` 后向量变化，假视觉调用次数不增加。只 PATCH `takenAt` 时不新增 job。PATCH 成与当前相同的描述时不新增 job。
10. 照片为 `failed` 且已有缩略图时，PATCH 新描述产生的 `reembed` 成功后，状态变为 `ready`。没有缩略图时，`reembed` 成功后状态仍是 `failed`。
11. `POST /photos/:id/retry` 对 `failed` 返回 200，`status` 为 `processing`，并新插入 `process_photo`。对 `ready` 返回 409，`error.code` 为 `not_failed`，文案「照片不在失败状态」。另一用户返回 404。
12. 删除 `ready` 的照片返回 204。`photo_embeddings` 与该照片的 `jobs` 行都不在。假存储收到原图键和缩略图键的删除。
13. 配置解析放在 `apps/api/test/pipeline-config.test.ts`，不连接数据库。`EMBED_DIMENSIONS=1536` 通过；`768`、空白、`abc` 分别拒绝。非 production 且 `VISION_API_KEY=YOUR_VISION_API_KEY` 时解析为假视觉。同一占位符在 `NODE_ENV=production` 时得到退出，文案是 `视觉配置仍是占位符`，且不含这枚密钥。`S3_ACCESS_KEY_ID=YOUR_ACCESS_KEY` 在生产环境同样退出，文案是 `对象存储配置仍是占位符`，不含密钥。`PIPELINE_POLL_MS` 空白为 2000，`50` 拒绝。集成测试里，`buildApp` 在不设置 `VISION_*` 与 `EMBED_*` 时仍能完成 Phase 2 的上传。
14. 让假视觉抛出的错误 `message` 里带上密钥哨兵和 `X-Amz-Signature`。流水线日志含「视觉调用失败」，不含哨兵、不含 `X-Amz-Signature`、不含 `dataBase64`。
15. 两条到期的 `process_photo`，并发为 2，一次 `runOnce` 都变成 `done`。第三条 `run_after` 在未来，仍是 `pending`。
16. 已经 `ready` 后再 `runOnce`：假视觉、假嵌入、`putObject` 的调用次数都不增加。
17. `npm test` 的分层边界检查通过。领域源码不包含 `sharp`、`exifr`、`@aws-sdk/`。`scripts/check-layer-boundaries.mjs` 的领域禁止名单含 `sharp` 与 `exifr`。
18. 一条 `running` 的 `process_photo`，`attempts` 为 5，`last_error` 与照片 `error_message` 都是 `vision_unavailable`，`locked_at` 早于租约。`runOnce` 之后 job 为 `failed`，这两个字段仍是 `vision_unavailable`，照片状态为 `failed`。日志含「任务租约回收」和 `interrupted`，数据库列里没有 `interrupted`。

Phase 2 里对照片 JSON 做整对象比较的断言，实现时要算上 `errorCode`、`thumbUrl`、`thumbUrlExpiresAt`。上传刚完成时这三个值是 `null`。

## 12. 范围外

本阶段不做：

- 关键词、自然语言、排序和 `POST /photos/search`（Phase 4）。本阶段不按 `ready` 过滤列表
- 共享册里的可见性（Phase 5）
- 人脸聚类、自动事件分组
- `apps/web` 以及任何页面
- 反向地理编码。`location_text` 只来自用户或 Agent
- 以图搜图，以及把图像而不是文本送进嵌入模型
- 过期 `upload_sessions` 的定时清扫
- 在 CVM 或 worker 进程里加载大模型
- `photo_embeddings` 的 IVFFlat / HNSW
- 任务完成的 webhook、SSE，以及 `GET /jobs`
- 使用 `S3_PUBLIC_BASE_URL` 公布缩略图
- 把队列换成 Redis
- 改 Phase 2 的上传上限、内容类型白名单、`completing` 栅栏和「他人资源统一未找到」

## 13. 验收对照

与 `specs/phases/03-processing-pipeline.md` 的验收项对应关系如下。实现提交才能勾选。

| 阶段验收 | 本文何处 |
|----------|----------|
| 上传后的照片最终变为 `ready`，或在外部 API 失败时变为 `failed`，原图仍可访问 | 第 4.1、5.5、7.3 节；第 11 节第 2、5、6 条 |
| `ready` 的照片具备缩略图、描述或标签（模型有返回时）、以及一条嵌入 | 第 4.5、5.5、7.2 节；第 11 节第 2、4 条 |
| 嵌入维度与配置一致；不匹配时任务失败并可观察，且不写坏向量列 | 第 7.5 节；第 11 节第 6、7、13 条 |
| 覆盖描述或标签后能再次嵌入 | 第 4.6、8.2 节；第 11 节第 9、10 条 |
| worker 不向日志打印 API Key、对象存储密钥或口令 | 第 9、10 节；第 11 节第 13、14 条 |
| 领域层边界检查仍然通过 | 第 3、11 节第 17 条 |

未配置真实视觉、嵌入和对象存储时，测试用的假实现位于网关层：第 3.4、3.6、11 节。

## 14. 已确认决策

- `process_photo` 在一条 job 内依次做 EXIF、缩略图、视觉和文本嵌入；`reembed` 只做嵌入。
- 首次插入照片的同一事务入队。PATCH 只在描述或标签真正变化时入队。`failed` 经 `POST /photos/:id/retry` 再入队。再次 `complete` 不把已失败且已有历史任务的照片重新入队。`completing` 不入队。
- 领取使用 `SKIP LOCKED`。可重试失败最多 5 次，退避 30、60、120、240 秒。维度不符和拒绝类错误立即失败。租约回收不把已有业务码改成 `interrupted`；`interrupted` 只出现在回收日志。
- 用户或 Agent 已经写下的拍摄时间、成对经纬度、描述和标签不会被流水线覆盖。无偏移的 EXIF 时间按 UTC。不写地点文本。视觉描述的控制字符允许集与 PATCH 相同；超长描述由视觉截到 4000 个 UTF-16 码元，PATCH 仍拒绝超长。
- 缩略图键是 `owners/{userId}/photos/{photoId}/thumb`，JPEG，长边 512，质量 80。
- 视觉接收原图 base64。嵌入接收描述和标签拼出的文本；都空时嵌入 `photo`。
- `EMBED_DIMENSIONS` 必须为 1536。长度校验在领域，DAO 在 SQL 前再挡一次，写入与 `ready` 在同一事务。
- worker 是独立进程。API 不轮询。测试用 `runOnce` 和网关层假实现，不依赖生产密钥。`NODE_ENV=production` 时，视觉、嵌入或 S3 占位符让 worker 退出；生产环境的 API 在 S3 占位符上同样退出。
- 删除照片级联删除嵌入和任务。过期上传会话不由这个 worker 清扫。
- 实现提交把 `sharp` 与 `exifr` 写入领域层边界检查的禁止名单。
- 不做搜索、共享册、人脸、自动事件和网页。
