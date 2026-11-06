# OpenAlbum Phase 3 — 处理流水线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 照片首次入库的同一事务入队 `process_photo`，由独立 worker 按 EXIF、缩略图、视觉、嵌入跑完并写成 `ready`；可重试失败按次数退避，终态失败变成 `failed` 且原图仍可访问，描述或标签真的变了才 `reembed`。

**Architecture:** 纯规则留在 `domain/library`。`adapters/pipeline` 的 `runOnce` 编排一次领取：网络与缩略图编码都在行锁之外，嵌入提交时再锁照片、复核文本、upsert 向量、改状态、结束任务。`dao` 执行 `SKIP LOCKED` 与参数化 `vector`。`exifr` 与 `sharp` 只出现在网关。API 进程不轮询；`src/worker.ts` 不监听端口。测试把假网关注入 `runOnce`，不启动 worker，也不依赖生产密钥。

**Tech Stack:** Node/TS, Fastify, pg, pgvector, @aws-sdk/client-s3, exifr, sharp, 全局 fetch, docker postgres, node:test

## Global Constraints

下列约束每个任务都要遵守。数值与硬规则抄自 [`docs/superpowers/specs/2026-11-06-openalbum-phase3-processing-pipeline-design.md`](../specs/2026-11-06-openalbum-phase3-processing-pipeline-design.md) 与 [`specs/phases/03-processing-pipeline.md`](../../../specs/phases/03-processing-pipeline.md)。

- `process_photo` 在同一条 job 内按 `exif → thumbnail → vision → embed` 推进，进度只写在 `payload.step`。新任务从 `exif` 开始。`reembed` 的 payload 固定为 `{"step":"embed"}`，不读 EXIF、不生成缩略图、不调用视觉。不拆成四条 job。
- 首次插入 `photos` 的同一事务插入 `process_photo`，`run_after` 为这次完成使用的 `now`。照片插入因主键冲突回滚并返回 `exists` 时，该事务里没有新 job。`exists` 之后另做短事务：照片存在、状态为 `processing`、且没有任何 `process_photo` 行（四种状态都算）时才补插。照片已是 `failed` 且已有 `process_photo` 历史行时，再次 `complete` 不入队，也不把状态改回 `processing`。会话处于 `open` 或 `completing`、对象存储尚未完成、照片行还不存在时不入队。worker 不读 `upload_sessions`，也不清扫过期上传会话。
- PATCH 只有描述或标签的值真的变了才在同一事务插入 `reembed`。已有未结束的 `process_photo` 或 `reembed` 时不再插入。只改拍摄时间、地点或经纬度不入队。空补丁不入队。PATCH 本身不把 `ready` 改成 `processing`。
- `POST /photos/:id/retry` 只在 `failed` 时把状态改回 `processing`、清空 `error_message`、删除该照片仍为 `pending` 的 `reembed`，再插入 `process_photo`。正在 `running` 的 `reembed` 不中途杀掉。`processing` 或 `ready` 返回 409 `not_failed`，文案「照片不在失败状态」。
- 领取：`pending` 且 `run_after <= now`，`FOR UPDATE SKIP LOCKED`，排序 `run_after, created_at, id`。时间用调用方传入的 `now`，不用 SQL `now()`。后续更新用 `RETURNING` 的 `locked_at`。`runOnce` 开始时 `inFlight` 为 0。可领取条数是 `PIPELINE_CONCURRENCY - inFlight`，小于 1 则这一轮不领取。租约固定 600000 毫秒，不设环境变量。
- 一次领取跑完剩余步骤，中间不把 job 放回 `pending`。每一步成功后先提交该步数据和下一 `step`，再开始下一步的外部调用。可重试失败最多 5 次（领取时 `attempts` 加一）。`attempts` 小于 5 时回到 `pending`，`run_after = now + delay`。`delay` 秒数是 `min(30 * 2^(attempts - 1), 900)`，四次等待依次是 30、60、120、240 秒。第 5 次仍可重试失败则 job 为 `failed`；类型是 `process_photo` 且照片仍为 `processing` 时照片改为 `failed`。
- 可重试码只有 `storage`、`vision_unavailable`、`embed_unavailable`。`original_missing`、`thumbnail_failed`、`vision_rejected`、`embed_rejected`、`dimension_mismatch`、`invalid_embedding` 立即终态，不看次数。稳定码就是这些字符串。`jobs.last_error` 与 `photos.error_message` 只存这些业务码。
- `interrupted` 只出现在租约回收日志的 `errorCode`，不写入 `jobs.last_error` 或 `photos.error_message`。回收不覆盖已有业务码：两列已是 `vision_unavailable` 这类业务码时保持原文，为空也保持为空。`attempts >= 5` 的过期 `running` 行改为 `failed` 并清空 `locked_at`；`process_photo` 且照片仍为 `processing` 时照片改为 `failed`，`error_message` 保持回收前的值。`attempts < 5` 则改回 `pending`，`run_after = now`，`attempts` 与 `last_error` 不变，照片状态与 `error_message` 都不变。关机时没写完的任务改回 `pending`，日志不记 `interrupted`。
- 文本在嵌入 HTTP 返回之后变了：不写向量，不占 5 次额度。job 回到 `pending`，`run_after = now`，`locked_at` 清空，`attempts` 减 1（不低于 0）。
- `process_photo` 成功才从 `processing` 变为 `ready` 并清空 `error_message`。中途可重试失败保持 `processing` 并写下业务码。终态失败只把仍为 `processing` 的行改成 `failed`。已经是 `ready` 的行保持 `ready`。`reembed` 成功且 `thumb_key` 非空时变为 `ready` 并清空错误码；`thumb_key` 为空则不改状态、也不清空错误码，向量仍然写入。`reembed` 失败不改 `photos.status`，也不改 `error_message`。
- EXIF 只补 `taken_at` 仍为空、以及经纬度两者都为空的照片。只读到一个坐标时两个都不写。不写 `location_text`、`description`、`tags`。无偏移的 EXIF 时间按 UTC。年份小于 1970 或大于 2100，或结果不是有效时间，则 `takenAt` 为空。解析失败当成没有 EXIF，步骤仍成功。条件更新：`taken_at IS NULL` 才写时间；`latitude IS NULL AND longitude IS NULL` 才写坐标。
- 缩略图键是 `owners/{userId}/photos/{photoId}/thumb`。`userId` 与 `photoId` 是小写 UUID。键不以 `/` 开头，不含桶名。JPEG，质量 80，长边 512，不放大。先按 EXIF 方向转正，输出不含 EXIF。`putObject` 的 `contentType` 为 `image/jpeg`。`thumb_key` 已经等于期望键且 `headObject` 的 `byteSize >= 1` 时跳过编码。
- 视觉是 `POST {VISION_API_BASE_URL}/v1/describe`，正文是原图 base64，不把原图转成另一种格式。超时默认 60000 毫秒。只填仍为空的描述和仍为空的标签。两个都已经有值则不调用视觉 HTTP。描述 trim 后为空当作没有描述。允许制表符（U+0009）与换行（U+000A）。拒绝其他 U+0000–U+001F 与 U+007F；含这些字符则整段描述当作没有，不因此让视觉步骤失败。长于 4000 个 UTF-16 码元时截到 4000；截断处落在高代理项再去掉那一个码元。标签 trim，拒绝控制字符（含制表符和换行），去掉空项、含控制字符的项、长度不在 1–64 的项，去重并保留第一次出现的顺序，最多 32 个。多出来的丢掉，不因此让视觉步骤失败。
- 嵌入是文本嵌入：`POST {EMBED_API_BASE_URL}/v1/embeddings`。超时默认 30000 毫秒。`embeddingInput` 只看描述和标签：描述非空则作为第一行；标签非空则用 `", "` 接成一行；两行都没有时返回小写字面量 `photo`；有内容时用一个 `\n` 连接。不把原图字节、对象键或用户 id 送进嵌入模型。`photo_embeddings.model` 写入配置里的 `EMBED_MODEL`，不写响应回显的模型名。
- `EMBED_DIMENSIONS` 必须是 `1536`，与 `schema.sql` 的 `vector(1536)` 一致。这个数写在 `gateways/embed` 的配置模块里。空白退出文案 `EMBED_DIMENSIONS 缺失`；非整数退出文案 `EMBED_DIMENSIONS 无效`；其他整数退出文案 `EMBED_DIMENSIONS 与向量列不一致`。API 进程不执行这道检查。长度不符不是网关的 `kind`：网关照实返回 `values`，领域函数判定 `dimension_mismatch` 或 `invalid_embedding`。DAO 在发 SQL 前再挡一次。不匹配则任务失败，事务回滚，不写向量列。嵌入 HTTP 在事务外。提交时同一事务：锁照片、复核文本、upsert、更新照片、把 job 标为 `done`。
- 持有照片行锁或任务锁期间不做网络 I/O，也不做缩略图编码。`getObject` 与 `putObject` 在网关内各自 60 秒截止。截止到期归类为 `storage`。
- 独立入口 `apps/api/src/worker.ts`，不调用 `listen`。API 进程不轮询，不读 `VISION_*`、`EMBED_*`、`PIPELINE_*`。`buildApp` 不创建视觉或嵌入客户端，不读取这些变量，也不读 `NODE_ENV`。测试调用 `runOnce`，注入假网关和时钟，不睡眠等 `PIPELINE_POLL_MS` 或退避；把 `now` 拨过 `run_after` 再调用一次。
- 假视觉、假嵌入、假 EXIF、假缩略图、假对象存储都放在 `gateways/`。测试注入的假实现不看 `NODE_ENV`，不读 `VISION_API_KEY`、`EMBED_API_KEY`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`。非 production 的视觉或嵌入占位符使用假网关，并打一条静态 INFO：`视觉网关使用假实现` 或 `嵌入网关使用假实现`。假视觉固定输出描述 `未配置视觉模型`、标签 `["未配置"]`。假嵌入按文本稳定返回 1536 维。真实 HTTP 的 INFO 是 `视觉网关使用 HTTP` 或 `嵌入网关使用 HTTP`，不出现密钥、完整基址和模型字符串。
- `NODE_ENV` trim 后等于 `production` 才是生产。此时视觉、嵌入或 S3 占位符命中则 worker `exit 1`，文案分别是 `视觉配置仍是占位符`、`嵌入配置仍是占位符`、`对象存储配置仍是占位符`。不构造该侧假网关，不用假描述或假向量把照片标成 `ready`。生产环境的 API 在 S3 占位符上同样 `exit 1`，文案同样是 `对象存储配置仍是占位符`。API 不因为视觉或嵌入占位符退出。占位字符串与 `deploy/env.example` 逐字比较，比较前只做 trim。基址非空但带 userinfo 或不是合法 `http`/`https` URL 时，不论 `NODE_ENV` 都先退出，文案 `VISION_API_BASE_URL 无效` 或 `EMBED_API_BASE_URL 无效`，不包含 URL 的用户信息。S3 语法错误仍用 Phase 2 文案，先于占位判断。非 production 的 S3 占位符不换成内存假存储。
- 占位值：`VISION_API_BASE_URL` 去掉末尾斜杠后等于 `https://YOUR_VISION_API_BASE`，或 `VISION_API_KEY` 为空白或 `YOUR_VISION_API_KEY`，或 `VISION_MODEL` 为空白或 `YOUR_VISION_MODEL`。嵌入对应 `https://YOUR_EMBED_API_BASE`、`YOUR_EMBED_API_KEY`、`YOUR_EMBED_MODEL`。S3：`S3_BUCKET` 等于 `YOUR_BUCKET_NAME`，或 `S3_ACCESS_KEY_ID` 等于 `YOUR_ACCESS_KEY`，或 `S3_SECRET_ACCESS_KEY` 等于 `YOUR_SECRET_KEY`。
- `PIPELINE_POLL_MS` 空白时 2000，十进制整数，闭区间 200 到 60000，否则 `PIPELINE_POLL_MS 无效`。`PIPELINE_CONCURRENCY` 空白时 2，闭区间 1 到 8，否则 `PIPELINE_CONCURRENCY 无效`。`VISION_PROVIDER` 与 `EMBED_PROVIDER` 只接受空白或 `http`。`VISION_TIMEOUT_MS` 空白时 60000，`EMBED_TIMEOUT_MS` 空白时 30000，两者都是闭区间 1000 到 120000。模型非空时最长 200 个字符。
- HTTP 网关使用全局 `fetch`，`redirect: "manual"`。3xx 不再请求下一跳，视为对应的 `*_rejected`。429、500、502、503、504、超时、DNS 与连接失败是 `*_unavailable`。其他 4xx，以及 200 但 JSON 不是约定形状，是 `*_rejected`。
- 照片 JSON 始终带 `thumbUrl`、`thumbUrlExpiresAt`、`errorCode`。没有缩略图或没有错误码时值为 `null`，不用省略表示空。`thumb_key` 非空时用与原图相同的 `presignGet` 和 `S3_SIGNED_URL_TTL`。签发缩略图失败：500 `storage_error`，文案「对象存储不可用」。本阶段不读取 `S3_PUBLIC_BASE_URL`。响应不包含 `objectKey`、`thumbKey`、`sourceUserId`、`sourceKeyId` 或 `jobs` 行。
- 删除顺序仍是 Phase 2：先提交删除 `photos` 行，再尽力删除原图；`thumb_key` 非空时再尽力删除缩略图。`photo_embeddings.photo_id` 与 `jobs.photo_id` 都是 `ON DELETE CASCADE`。
- 日志、响应正文和错误对象都不得出现：`VISION_API_KEY`、`EMBED_API_KEY`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`JWT_SECRET`、`API_KEY_PEPPER`、`Authorization` 头、Access JWT、Refresh Token、API Key 明文、签名 URL 查询串、`originalUrl` 与 `thumbUrl` 整段、原图或缩略图字节、base64 正文、嵌入向量、上游 `message` 与上游响应正文。流水线日志只许带 `userId`、`photoId`、`objectKey`、`jobId`、`jobType`、`step`、`attempt`、`errorCode`、`errorName`，另加一条静态中文。不记录异常的 `message`。身份测试要求的 redact 路径和 `originalUrl` 路径保持不动。再补上 `thumbUrl`、`photo.thumbUrl`、`photos[*].thumbUrl`、`dataBase64`、`embedding`。
- 领域层不 import `fastify`、`pg`、`@aws-sdk/*`、`aws-sdk`、`minio`、`undici`、`sharp`、`exifr`，以及 `node:http` / `node:https`。`domain/library` 不 import `domain/identity`，也不 import `domain/search`。适配层源码不得出现 `from ".../dao"` 或 `from ".../gateways"`。接口层不引用 DAO / 网关。实现提交把 `sharp` 和 `exifr` 加入 `scripts/check-layer-boundaries.mjs` 的领域禁止名单，与 `fastify`、`pg`、`undici` 放在一起。
- 不实现 Phase 4 搜索、Phase 5 共享册、Phase 6 网页、人脸聚类、自动事件、反向地理编码、以图搜图、过期上传会话清扫、在 CVM 上加载大模型、IVFFlat / HNSW、webhook、SSE、`GET /jobs`、Redis 队列，也不改上传上限、内容类型白名单、`completing` 栅栏和「他人资源统一未找到」。不改 `apps/web`。
- 同一 `photo_id + type` 至多一条 `pending` 或 `running`。应用生成 job 的小写 UUID；DDL 里的 `gen_random_uuid()` 只作兜底。`jobs.type` 只使用 `process_photo` 与 `reembed`。`jobs.status` 只使用 `pending`、`running`、`done`、`failed`。`payload.step` 只使用 `exif`、`thumbnail`、`vision`、`embed`、`done`。payload 不放图片字节、签名 URL 或密钥。
- 新测试放在 `apps/api/test/`，使用 `node:test` 与 `tsx`。需要数据库的测试使用真实 PostgreSQL，`DATABASE_URL` 缺失时失败，不跳过。`npm test` 已是 `node scripts/check-layer-boundaries.mjs && npm run test -w apps/api`，API 测试 `--test-concurrency=1`。不要改回并行。单文件命令也带上 `--test-concurrency=1`。
- 按任务编号顺序执行。后一个任务假设前一个任务已经提交。不要提前实现后续任务的路由或 worker。
- 实现本计划时，子代理使用 Composer 2.5，不使用 fast 模式。
- 设计文件开头的「状态：已定稿（待实现）」不要改。阶段状态只按本计划 Task 1 与 Task 12 更新。

**开工前阅读：**

- `docs/superpowers/specs/2026-11-06-openalbum-phase3-processing-pipeline-design.md`
- `specs/phases/03-processing-pipeline.md`
- `specs/SPEC.md`
- `docs/superpowers/plans/2026-11-04-openalbum-phase2-personal-library.md`
- `apps/api/src/domain/library/ports.ts`
- `apps/api/src/domain/library/model.ts`
- `apps/api/src/dao/photo-repository.ts`
- `apps/api/src/dao/upload-session-repository.ts`
- `apps/api/src/adapters/library/complete-upload.ts`
- `apps/api/src/adapters/library/patch-photo.ts`
- `apps/api/src/adapters/library/photo-response.ts`
- `apps/api/src/gateways/storage/fake-object-storage.ts`
- `apps/api/src/gateways/storage/s3-object-storage.ts`
- `apps/api/src/interfaces/http/auth-logger.ts`
- `apps/api/src/interfaces/http/register-photos.ts`
- `apps/api/src/app.ts`
- `apps/api/src/index.ts`
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
| `deploy/db/schema.sql` | 把 `jobs` 收成带 `photo_id`、`locked_at`、CHECK 与部分唯一索引的形状，并带上可重复执行的升级语句。不改 `photos` 与 `photo_embeddings` 的列 |
| `deploy/env.example` | 补 `VISION_TIMEOUT_MS`、`EMBED_TIMEOUT_MS` 与轮询、并发、维度注释。占位符原文保持不变 |
| `deploy/README.md` | 补 Phase 3 的任务表、维度、占位符退出；Task 9 再补 worker 单元文件名 |
| `deploy/systemd/photo-worker.service.example` | worker 单元草图。`EnvironmentFile` 与 API 相同，`ExecStart` 指向 `dist/worker.js`，不监听端口 |
| `specs/SPEC.md` | Task 1 把阶段 3 改为 `in_progress`；只有 Task 12 改为 `done` |
| `specs/phases/03-processing-pipeline.md` | Task 1 把状态改为 `in_progress` 且不勾验收；只有 Task 12 改为 `done` 并勾上验收 |
| `scripts/check-layer-boundaries.mjs` | Task 12 把 `sharp` 与 `exifr` 加入领域禁止包名单 |
| `apps/api/package.json` | 增加 `exifr`、`sharp`，以及 `worker` / `start:worker` 脚本。锁文件一起提交 |
| `apps/api/src/domain/library/model.ts` | `Photo.status` 收成联合类型，增加 `errorCode` |
| `apps/api/src/domain/library/pipeline.ts` | EXIF 补空、视觉归一化、嵌入文本、维度校验、退避、语义变更、缩略图键、步骤类型 |
| `apps/api/src/domain/library/ports.ts` | `getObject` / `putObject`，以及 EXIF、缩略图、视觉、嵌入、任务仓储端口 |
| `apps/api/src/domain/library/index.ts` | 导出本阶段的纯函数与端口类型 |
| `apps/api/src/dao/photo-repository.ts` | 读出 `error_message`；锁内 PATCH / 重试；补插 `process_photo` |
| `apps/api/src/dao/upload-session-repository.ts` | 首次插入照片的同一事务插入 `process_photo` |
| `apps/api/src/dao/pipeline-store.ts` | 领取、租约回收、分步提交、嵌入事务 |
| `apps/api/src/dao/vector-literal.ts` | SQL 前检查维度与有限数，格式化成不含科学计数法的 pgvector 文本 |
| `apps/api/src/dao/index.ts` | 导出 `createPipelineStore` 与 `formatVectorLiteral` |
| `apps/api/src/gateways/storage/fake-object-storage.ts` | `getObject` 读到完成后的原图和 `putObject` 写入的缩略图 |
| `apps/api/src/gateways/storage/s3-object-storage.ts` | `GetObject` / `PutObject`，单次请求 60 秒截止 |
| `apps/api/src/gateways/storage/config.ts` | `productionStoragePlaceholderMessage` |
| `apps/api/src/gateways/exif/parse.ts` | 无偏移按 UTC，坏数据变成空读数 |
| `apps/api/src/gateways/exif/exifr-reader.ts` | 生产 EXIF 读数 |
| `apps/api/src/gateways/exif/fake-exif-reader.ts` | 测试注入的读数 |
| `apps/api/src/gateways/exif/index.ts` | 导出上述工厂 |
| `apps/api/src/gateways/thumbnail/sharp-encoder.ts` | 生产 JPEG 缩略图 |
| `apps/api/src/gateways/thumbnail/fake-encoder.ts` | 内存编码器，可抛出 `ThumbnailEncodeError` |
| `apps/api/src/gateways/thumbnail/index.ts` | 导出上述工厂 |
| `apps/api/src/gateways/vision/http-vision.ts` | `POST /v1/describe` |
| `apps/api/src/gateways/vision/fake-vision.ts` | 可配置成功正文、连续失败、直接拒绝 |
| `apps/api/src/gateways/vision/index.ts` | 保留 `VISION_GATEWAY`，再导出工厂 |
| `apps/api/src/gateways/embed/config.ts` | `EMBED_VECTOR_DIMENSIONS = 1536` 与 `loadPipelineConfig` |
| `apps/api/src/gateways/embed/deterministic.ts` | 同一文本得到同一 1536 维向量 |
| `apps/api/src/gateways/embed/http-embed.ts` | `POST /v1/embeddings` |
| `apps/api/src/gateways/embed/fake-embed.ts` | 可配置维度、连续失败、NaN、直接拒绝 |
| `apps/api/src/gateways/embed/index.ts` | 保留 `EMBED_GATEWAY`，再导出配置与工厂 |
| `apps/api/src/gateways/index.ts` | 再导出本阶段网关工厂与 `loadPipelineConfig` |
| `apps/api/src/adapters/pipeline/deps.ts` | `PipelineDeps`、`PipelineLog`、`WorkerControl` |
| `apps/api/src/adapters/pipeline/failure-message.ts` | 失败种类到静态中文 |
| `apps/api/src/adapters/pipeline/run-once.ts` | `runOnce` |
| `apps/api/src/adapters/pipeline/worker-loop.ts` | 轮询、停止领取、释放未完成任务 |
| `apps/api/src/adapters/library/messages.ts` | `not_failed` 与「修改未能完成」 |
| `apps/api/src/adapters/library/photo-response.ts` | `errorCode`、`thumbUrl`、`thumbUrlExpiresAt` |
| `apps/api/src/adapters/library/complete-upload.ts` | 同事务入队，以及 `failed` 历史任务不再补插 |
| `apps/api/src/adapters/library/patch-photo.ts` | 语义变化时入队 `reembed` |
| `apps/api/src/adapters/library/retry-photo.ts` | 重试用例 |
| `apps/api/src/adapters/library/get-photo.ts` | 签发失败返回 `storage_error` |
| `apps/api/src/adapters/index.ts` | 导出 `runOnce` 与 `retryPhoto` |
| `apps/api/src/interfaces/http/register-photos.ts` | `POST /photos/:id/retry` |
| `apps/api/src/interfaces/http/auth-logger.ts` | redact 补上缩略图 URL、base64 与向量 |
| `apps/api/src/wire-pipeline.ts` | 按配置构造真网关或占位符假网关。禁止移入五层目录 |
| `apps/api/src/worker.ts` | 独立进程入口 |
| `apps/api/src/index.ts` | 生产环境 S3 占位符 `exit 1`。仍不读视觉与嵌入 |
| `apps/api/test/pipeline-schema.test.ts` | DDL 与 env 示例 |
| `apps/api/test/pipeline-rules.test.ts` | 纯规则，不连接数据库 |
| `apps/api/test/pipeline-dao.test.ts` | 领取、回收、入队、向量字面量 |
| `apps/api/test/fake-storage.test.ts` | 补 `getObject` / `putObject` |
| `apps/api/test/s3-storage.test.ts` | 用桩客户端断言 Get/Put 与 60 秒 abort |
| `apps/api/test/pipeline-exif-thumb.test.ts` | EXIF 时间与缩略图编码器 |
| `apps/api/test/pipeline-config.test.ts` | 维度、占位符、假网关 HTTP 分类 |
| `apps/api/test/pipeline-run.test.ts` | `runOnce` 与假网关、真实 Postgres |
| `apps/api/test/pipeline-enqueue.test.ts` | complete 补救、PATCH、retry |
| `apps/api/test/pipeline-worker.test.ts` | 循环与停机释放 |
| `apps/api/test/pipeline-log.test.ts` | 日志字段白名单与 redact 路径 |
| `apps/api/test/processing-pipeline.test.ts` | 设计第 11 节的集成断言 |
| `apps/api/test/library-boundaries.test.ts` | 加上 `sharp`、`exifr`，并扫描 `adapters/pipeline` |

不创建 `apps/web` 下的文件，不新增搜索路由，不新增 Redis 客户端。

---

### Task 1: jobs DDL、流水线环境示例与阶段开工

**Files:**
- Modify: `deploy/db/schema.sql`
- Modify: `deploy/env.example`
- Modify: `deploy/README.md`
- Modify: `specs/SPEC.md`
- Modify: `specs/phases/03-processing-pipeline.md`
- Test: `apps/api/test/pipeline-schema.test.ts`

**Interfaces:**
- Consumes: 现有 `applySchema` 会执行整个 `deploy/db/schema.sql`。库里可能已经有 Phase 2 的 `jobs`（没有 `photo_id`）
- Produces: `jobs.photo_id` 非空且外键级联到 `photos`；列 `locked_at`；约束 `jobs_type`、`jobs_status`、`jobs_attempts`；索引 `idx_jobs_poll`、`idx_jobs_photo`、`idx_jobs_one_active`。环境示例出现 `VISION_TIMEOUT_MS=60000`、`EMBED_TIMEOUT_MS=30000`、`EMBED_DIMENSIONS=1536`、`PIPELINE_POLL_MS=2000`、`PIPELINE_CONCURRENCY=2`。阶段 3 状态为 `in_progress`，验收框仍未勾选

- [ ] **Step 1: 写会失败的结构测试**

创建 `apps/api/test/pipeline-schema.test.ts`：

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

test("jobs 有 photo_id 级联、locked_at、检查约束与一条未结束任务", async () => {
  const columns = await pool.query(
    `SELECT column_name, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'jobs' AND column_name IN ('photo_id', 'locked_at', 'payload', 'attempts')
     ORDER BY column_name`,
  );
  assert.deepEqual(
    columns.rows.map((row) => `${row.column_name}:${row.is_nullable}`),
    ["attempts:NO", "locked_at:YES", "payload:NO", "photo_id:NO"],
  );

  const constraints = await pool.query(
    `SELECT conname FROM pg_constraint
     WHERE conname IN ('jobs_type', 'jobs_status', 'jobs_attempts', 'jobs_photo_id_fkey')
     ORDER BY conname`,
  );
  assert.deepEqual(constraints.rows.map((row) => row.conname), [
    "jobs_attempts",
    "jobs_photo_id_fkey",
    "jobs_status",
    "jobs_type",
  ]);

  const indexes = await pool.query(
    `SELECT indexname FROM pg_indexes
     WHERE indexname IN ('idx_jobs_poll', 'idx_jobs_photo', 'idx_jobs_one_active')
     ORDER BY indexname`,
  );
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    "idx_jobs_one_active",
    "idx_jobs_photo",
    "idx_jobs_poll",
  ]);

  const uniqueDef = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_jobs_one_active'`,
  );
  assert.match(String(uniqueDef.rows[0].indexdef), /UNIQUE/);
  assert.match(String(uniqueDef.rows[0].indexdef), /pending/);
  assert.match(String(uniqueDef.rows[0].indexdef), /running/);

  const embedding = await pool.query(
    `SELECT atttypmod FROM pg_attribute
     WHERE attrelid = 'photo_embeddings'::regclass AND attname = 'embedding'`,
  );
  assert.equal(embedding.rows[0].atttypmod, 1536);
});

test("env 示例声明超时、1536 维与轮询默认值", async () => {
  const example = await readFile(new URL("../../../deploy/env.example", import.meta.url), "utf8");
  assert.match(example, /^VISION_API_BASE_URL=https:\/\/YOUR_VISION_API_BASE$/m);
  assert.match(example, /^VISION_API_KEY=YOUR_VISION_API_KEY$/m);
  assert.match(example, /^VISION_MODEL=YOUR_VISION_MODEL$/m);
  assert.match(example, /^EMBED_API_BASE_URL=https:\/\/YOUR_EMBED_API_BASE$/m);
  assert.match(example, /^EMBED_API_KEY=YOUR_EMBED_API_KEY$/m);
  assert.match(example, /^EMBED_MODEL=YOUR_EMBED_MODEL$/m);
  assert.match(example, /^S3_BUCKET=YOUR_BUCKET_NAME$/m);
  assert.match(example, /^S3_ACCESS_KEY_ID=YOUR_ACCESS_KEY$/m);
  assert.match(example, /^S3_SECRET_ACCESS_KEY=YOUR_SECRET_KEY$/m);
  assert.match(example, /^VISION_TIMEOUT_MS=60000$/m);
  assert.match(example, /^EMBED_TIMEOUT_MS=30000$/m);
  assert.match(example, /^EMBED_DIMENSIONS=1536$/m);
  assert.match(example, /^PIPELINE_POLL_MS=2000$/m);
  assert.match(example, /^PIPELINE_CONCURRENCY=2$/m);
  const readme = await readFile(new URL("../../../deploy/README.md", import.meta.url), "utf8");
  assert.match(readme, /EMBED_DIMENSIONS/);
  assert.match(readme, /对象存储配置仍是占位符/);
  assert.match(readme, /不读取 `S3_PUBLIC_BASE_URL`/);
});

test("阶段 3 已开工且验收仍未勾选", async () => {
  const phase = await readFile(new URL("../../../specs/phases/03-processing-pipeline.md", import.meta.url), "utf8");
  assert.match(phase, /\*\*状态：\*\* in_progress/);
  assert.equal(phase.includes("- [x]"), false);
  const spec = await readFile(new URL("../../../specs/SPEC.md", import.meta.url), "utf8");
  assert.match(spec, /\| 3 \|.*\| in_progress \|/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-schema.test.ts
```

Expected: 退出码非 0。断言找不到 `photo_id:NO`、`VISION_TIMEOUT_MS=60000` 或 `in_progress`。

- [ ] **Step 3: 替换 jobs 草图并写可重复执行的升级**

把 `deploy/db/schema.sql` 里从 `-- 异步流水线任务` 到文件末尾换成：

```sql
-- 异步流水线任务
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

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS photo_id UUID;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_photo_id_fkey') THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_photo_id_fkey
      FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE;
  END IF;
END $$;

DELETE FROM jobs WHERE photo_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'jobs'
      AND column_name = 'photo_id'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE jobs ALTER COLUMN photo_id SET NOT NULL;
  END IF;
END $$;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type;
ALTER TABLE jobs ADD CONSTRAINT jobs_type CHECK (type IN ('process_photo', 'reembed'));
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status;
ALTER TABLE jobs ADD CONSTRAINT jobs_status CHECK (status IN ('pending', 'running', 'done', 'failed'));
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_attempts;
ALTER TABLE jobs ADD CONSTRAINT jobs_attempts CHECK (attempts >= 0);

CREATE INDEX IF NOT EXISTS idx_jobs_poll ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_jobs_photo ON jobs(photo_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active
  ON jobs (photo_id, type)
  WHERE status IN ('pending', 'running');
```

`photos` 与 `photo_embeddings` 的列不要改。不要加 IVFFlat 或 HNSW。

- [ ] **Step 4: 补环境示例与 README**

在 `deploy/env.example` 的视觉段，`VISION_MODEL=YOUR_VISION_MODEL` 下一行插入：

```text
# 空白时 60000。十进制整数，闭区间 1000 到 120000。其他值时 worker 退出，文案 VISION_TIMEOUT_MS 无效。
VISION_TIMEOUT_MS=60000
```

把嵌入维度那一行上面的注释换成下面三行，并在 `EMBED_MODEL=YOUR_EMBED_MODEL` 与 `EMBED_DIMENSIONS=1536` 之间插入超时：

```text
# 空白时 30000。十进制整数，闭区间 1000 到 120000。其他值时 worker 退出，文案 EMBED_TIMEOUT_MS 无效。
EMBED_TIMEOUT_MS=30000
# 必须是 1536，与 schema.sql 的 vector(1536) 相同。空白时 worker 退出，文案 EMBED_DIMENSIONS 缺失；非整数文案 EMBED_DIMENSIONS 无效；其他整数字面量文案 EMBED_DIMENSIONS 与向量列不一致。
EMBED_DIMENSIONS=1536
```

把 worker 段换成：

```text
# --- Worker ---
# 空白时 2000。十进制整数，闭区间 200 到 60000。其他值时 worker 退出，文案 PIPELINE_POLL_MS 无效。
PIPELINE_POLL_MS=2000
# 空白时 2。十进制整数，闭区间 1 到 8。其他值时 worker 退出，文案 PIPELINE_CONCURRENCY 无效。
PIPELINE_CONCURRENCY=2
```

已有占位符 `YOUR_VISION_API_BASE`、`YOUR_VISION_API_KEY`、`YOUR_VISION_MODEL`、`YOUR_EMBED_API_BASE`、`YOUR_EMBED_API_KEY`、`YOUR_EMBED_MODEL`、`YOUR_BUCKET_NAME`、`YOUR_ACCESS_KEY`、`YOUR_SECRET_KEY` 保持逐字不变。

在 `deploy/README.md` 的 Phase 2 那段后面追加：

```markdown
Phase 3 将 `jobs` 定为 `process_photo` 与 `reembed`。`photo_id` 外键级联删除照片的任务，并增加 `locked_at`。Worker 读取 `PIPELINE_POLL_MS`（空白时 2000，闭区间 200 到 60000）、`PIPELINE_CONCURRENCY`（空白时 2，闭区间 1 到 8）、`VISION_TIMEOUT_MS`（空白时 60000）与 `EMBED_TIMEOUT_MS`（空白时 30000）。`EMBED_DIMENSIONS` 必须是 `1536`，与 `vector(1536)` 相同。`NODE_ENV=production` 时，视觉、嵌入或对象存储占位符让 worker 以退出码 1 结束；API 进程只在对象存储占位符上以退出码 1 结束，文案是 `对象存储配置仍是占位符`。非 production 的视觉与嵌入占位符使用假网关。本阶段仍不读取 `S3_PUBLIC_BASE_URL`。
```

- [ ] **Step 5: 把阶段标成 in_progress**

`specs/phases/03-processing-pipeline.md` 的状态行改为：

```markdown
**状态：** in_progress
```

验收列表保持 `- [ ]`，不要勾选。

`specs/SPEC.md` 阶段 3 那一行改为：

```markdown
| 3 | [phases/03-processing-pipeline.md](phases/03-processing-pipeline.md) | in_progress | EXIF、缩略图、视觉描述、嵌入、任务 |
```

不要勾选「任何阶段的完成定义」那一组模板复选框。不要改设计文件的「状态：已定稿（待实现）」。

- [ ] **Step 6: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-schema.test.ts
```

Expected: 退出码 0，`# fail 0`。

- [ ] **Step 7: Commit**

```bash
git add deploy/db/schema.sql deploy/env.example deploy/README.md specs/SPEC.md specs/phases/03-processing-pipeline.md apps/api/test/pipeline-schema.test.ts
git commit -m "feat: 落地处理流水线 jobs 草图并开工"
```

---

### Task 2: 领域规则、照片错误码与流水线端口

**Files:**
- Create: `apps/api/src/domain/library/pipeline.ts`
- Modify: `apps/api/src/domain/library/model.ts`
- Modify: `apps/api/src/domain/library/ports.ts`
- Modify: `apps/api/src/domain/library/index.ts`
- Modify: `apps/api/src/dao/photo-repository.ts`
- Test: `apps/api/test/pipeline-rules.test.ts`

**Interfaces:**
- Consumes: `MetadataPatch` 已有 `description?` 与 `tags?`。Phase 2 的 `normalizeMetadataPatch` 行为不变
- Produces:
  - `PhotoStatus = "processing" | "ready" | "failed"`
  - `Photo.status: PhotoStatus`，`Photo.errorCode: string | null`
  - `PipelineStep = "exif" | "thumbnail" | "vision" | "embed" | "done"`
  - `JobType = "process_photo" | "reembed"`
  - `JobStatus = "pending" | "running" | "done" | "failed"`
  - `PipelineErrorCode = "storage" | "original_missing" | "thumbnail_failed" | "vision_unavailable" | "vision_rejected" | "embed_unavailable" | "embed_rejected" | "dimension_mismatch" | "invalid_embedding"`
  - `PIPELINE_LEASE_MS = 600000`，`PIPELINE_MAX_ATTEMPTS = 5`
  - `exifFill(photo, reading) -> { takenAt?: Date; latitude?: number; longitude?: number }`
  - `normalizeVisionDescription(value: string | null) -> string | null`
  - `normalizeVisionTags(tags: string[]) -> string[]`
  - `shouldCallVision(photo) -> boolean`
  - `visionWrite(photo, normalized) -> { description: string | null; tags: string[] }`
  - `embeddingInput(photo) -> string`
  - `checkEmbedding(values, dimensions) -> { ok: true } | { ok: false; code: "dimension_mismatch" | "invalid_embedding" }`
  - `failureDisposition(code, attempts) -> { outcome: "retry"; delayMs: number } | { outcome: "terminal" }`
  - `semanticChanged(current, patch) -> boolean`
  - `thumbObjectKey(userId, photoId) -> string`
  - `parsePhotoStatus(value) -> PhotoStatus`
  - `parseJobStep(payload) -> PipelineStep`
  - `class ThumbnailEncodeError`
  - 端口 `ExifReader`、`ThumbnailEncoder`、`VisionGateway`、`EmbedGateway`、`PipelineStore`、`PipelineLog` 写在 `ports.ts`。本任务不实现它们，也不给 `ObjectStorage` 加方法

- [ ] **Step 1: 写会失败的纯规则测试**

创建 `apps/api/test/pipeline-rules.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkEmbedding,
  embeddingInput,
  exifFill,
  failureDisposition,
  normalizeVisionDescription,
  normalizeVisionTags,
  PIPELINE_LEASE_MS,
  PIPELINE_MAX_ATTEMPTS,
  semanticChanged,
  shouldCallVision,
  thumbObjectKey,
  ThumbnailEncodeError,
  visionWrite,
} from "../src/domain/library/pipeline.js";

const userId = "11111111-1111-4111-8111-111111111111";
const photoId = "33333333-3333-4333-8333-333333333333";

test("EXIF 只补空字段，坐标必须成对且在范围内", () => {
  const taken = new Date("2020-01-02T03:04:05.000Z");
  const filled = exifFill(
    { takenAt: null, latitude: null, longitude: null },
    { takenAt: taken, latitude: 1.5, longitude: 2.5 },
  );
  assert.equal(filled.takenAt?.toISOString(), taken.toISOString());
  assert.equal(filled.latitude, 1.5);
  assert.equal(filled.longitude, 2.5);

  const kept = exifFill(
    { takenAt: taken, latitude: 9, longitude: 8 },
    { takenAt: new Date("2024-01-01T00:00:00.000Z"), latitude: 1, longitude: 2 },
  );
  assert.equal(Object.hasOwn(kept, "takenAt"), false);
  assert.equal(Object.hasOwn(kept, "latitude"), false);
  assert.equal(Object.hasOwn(kept, "longitude"), false);
  assert.deepEqual(exifFill(
    { takenAt: null, latitude: null, longitude: null },
    { takenAt: null, latitude: 1, longitude: null },
  ), {});
  assert.deepEqual(exifFill(
    { takenAt: null, latitude: null, longitude: null },
    { takenAt: null, latitude: 91, longitude: 0 },
  ), {});
  assert.equal(Object.hasOwn(filled, "locationText"), false);
});

test("视觉描述截断到 4000 且丢掉含非法控制字符的整段，标签最多 32 个", () => {
  assert.equal(normalizeVisionDescription("  海边\n黄昏  "), "海边\n黄昏");
  assert.equal(normalizeVisionDescription("   "), null);
  assert.equal(normalizeVisionDescription("海\u0000边"), null);
  assert.equal(normalizeVisionDescription("a".repeat(4001))?.length, 4000);
  const high = "\uD83D";
  const withSurrogate = `${"a".repeat(3999)}${high}\uDC00`;
  const truncated = normalizeVisionDescription(withSurrogate);
  assert.equal(truncated?.length, 3999);
  assert.equal(truncated?.includes("\uD83D"), false);

  const tags = normalizeVisionTags([" 海 ", "海", "", "a".repeat(65), "黄昏\n", "湖"]);
  assert.deepEqual(tags, ["海", "湖"]);
  const many = normalizeVisionTags(Array.from({ length: 40 }, (_item, index) => `t${index}`));
  assert.equal(many.length, 32);
  assert.equal(many[0], "t0");
  assert.equal(many[31], "t31");
});

test("嵌入文本的三种拼法", () => {
  assert.equal(embeddingInput({ description: null, tags: [] }), "photo");
  assert.equal(embeddingInput({ description: "海边", tags: [] }), "海边");
  assert.equal(embeddingInput({ description: null, tags: ["海", "黄昏"] }), "海, 黄昏");
  assert.equal(embeddingInput({ description: "海边", tags: ["海", "黄昏"] }), "海边\n海, 黄昏");
});

test("维度不符先于非法数，第 5 次可重试失败才终态", () => {
  assert.deepEqual(checkEmbedding([0.1, 0.2], 2), { ok: true });
  assert.deepEqual(checkEmbedding([0.1], 2), { ok: false, code: "dimension_mismatch" });
  assert.deepEqual(checkEmbedding([Number.NaN, 0], 2), { ok: false, code: "invalid_embedding" });
  assert.deepEqual(failureDisposition("vision_unavailable", 1), { outcome: "retry", delayMs: 30_000 });
  assert.deepEqual(failureDisposition("storage", 2), { outcome: "retry", delayMs: 60_000 });
  assert.deepEqual(failureDisposition("embed_unavailable", 3), { outcome: "retry", delayMs: 120_000 });
  assert.deepEqual(failureDisposition("vision_unavailable", 4), { outcome: "retry", delayMs: 240_000 });
  assert.deepEqual(failureDisposition("vision_unavailable", 5), { outcome: "terminal" });
  assert.deepEqual(failureDisposition("vision_rejected", 1), { outcome: "terminal" });
  assert.deepEqual(failureDisposition("thumbnail_failed", 1), { outcome: "terminal" });
  assert.deepEqual(failureDisposition("dimension_mismatch", 1), { outcome: "terminal" });
  assert.equal(PIPELINE_MAX_ATTEMPTS, 5);
  assert.equal(PIPELINE_LEASE_MS, 600_000);
});

test("只有描述或标签的值变了才算语义变化", () => {
  const current = { description: "海边", tags: ["海"] };
  assert.equal(semanticChanged(current, { description: "海边" }), false);
  assert.equal(semanticChanged(current, { description: "湖边" }), true);
  assert.equal(semanticChanged(current, { description: null }), true);
  assert.equal(semanticChanged({ description: null, tags: [] }, { description: null }), false);
  assert.equal(semanticChanged(current, { tags: ["海"] }), false);
  assert.equal(semanticChanged(current, { tags: ["黄昏", "海"] }), true);
  assert.equal(semanticChanged(current, { takenAt: new Date("2020-01-01T00:00:00.000Z") }), false);
  assert.equal(semanticChanged(current, {}), false);
});

test("两个字段都有值时不调用视觉，否则只写出仍为空的字段", () => {
  assert.equal(shouldCallVision({ description: "海边", tags: ["海"] }), false);
  assert.equal(shouldCallVision({ description: null, tags: ["海"] }), true);
  assert.equal(shouldCallVision({ description: "海边", tags: [] }), true);
  assert.deepEqual(
    visionWrite({ description: "用户", tags: [] }, { description: "模型", tags: ["海"] }),
    { description: null, tags: ["海"] },
  );
  assert.deepEqual(
    visionWrite({ description: null, tags: ["用户"] }, { description: "模型", tags: ["海"] }),
    { description: "模型", tags: [] },
  );
});

test("缩略图键与编码错误名", () => {
  assert.equal(thumbObjectKey(userId, photoId), `owners/${userId}/photos/${photoId}/thumb`);
  assert.equal(new ThumbnailEncodeError().name, "ThumbnailEncodeError");
  assert.throws(() => thumbObjectKey("nope", photoId));
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-rules.test.ts
```

Expected: 退出码非 0。`pipeline.js` 找不到，或 `exifFill` 未定义。

- [ ] **Step 3: 写领域模块**

创建 `apps/api/src/domain/library/pipeline.ts`：

```typescript
import type { MetadataPatch } from "./model.js";

export type PhotoStatus = "processing" | "ready" | "failed";
export type PipelineStep = "exif" | "thumbnail" | "vision" | "embed" | "done";
export type JobType = "process_photo" | "reembed";
export type JobStatus = "pending" | "running" | "done" | "failed";
export type PipelineErrorCode =
  | "storage"
  | "original_missing"
  | "thumbnail_failed"
  | "vision_unavailable"
  | "vision_rejected"
  | "embed_unavailable"
  | "embed_rejected"
  | "dimension_mismatch"
  | "invalid_embedding";

export const PIPELINE_LEASE_MS = 600_000;
export const PIPELINE_MAX_ATTEMPTS = 5;
const VISION_DESCRIPTION_MAX = 4000;
const VISION_TAG_MAX = 64;
const VISION_TAG_LIMIT = 32;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RETRYABLE = new Set<PipelineErrorCode>(["storage", "vision_unavailable", "embed_unavailable"]);

export class ThumbnailEncodeError extends Error {
  constructor() {
    super("thumbnail encode failed");
    this.name = "ThumbnailEncodeError";
  }
}

export type ExifReading = {
  takenAt: Date | null;
  latitude: number | null;
  longitude: number | null;
};

export type ExifFill = {
  takenAt?: Date;
  latitude?: number;
  longitude?: number;
};

export function parsePhotoStatus(value: string): PhotoStatus {
  if (value === "processing" || value === "ready" || value === "failed") return value;
  throw new Error("照片状态无效");
}

export function parseJobStep(payload: unknown): PipelineStep {
  if (typeof payload !== "object" || payload === null) throw new Error("任务载荷无效");
  const step = (payload as { step?: unknown }).step;
  if (step === "exif" || step === "thumbnail" || step === "vision" || step === "embed" || step === "done") {
    return step;
  }
  throw new Error("任务载荷无效");
}

export function exifFill(
  photo: { takenAt: Date | null; latitude: number | null; longitude: number | null },
  reading: ExifReading,
): ExifFill {
  const fill: ExifFill = {};
  if (photo.takenAt === null && reading.takenAt instanceof Date && !Number.isNaN(reading.takenAt.getTime())) {
    fill.takenAt = reading.takenAt;
  }
  const latitude = reading.latitude;
  const longitude = reading.longitude;
  if (
    photo.latitude === null &&
    photo.longitude === null &&
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  ) {
    fill.latitude = latitude;
    fill.longitude = longitude;
  }
  return fill;
}

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

function trimOuterSpaces(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 0x20) end -= 1;
  return value.slice(start, end);
}

function truncateUtf16(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const tail = value.charCodeAt(end - 1);
  if (tail >= 0xd800 && tail <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

export function normalizeVisionDescription(value: string | null): string | null {
  if (value === null) return null;
  if (forbiddenControls(value, true)) return null;
  const trimmed = trimOuterSpaces(value);
  if (trimmed.length === 0) return null;
  return truncateUtf16(trimmed, VISION_DESCRIPTION_MAX);
}

export function normalizeVisionTags(tags: string[]): string[] {
  const normalized: string[] = [];
  for (const item of tags) {
    if (typeof item !== "string" || forbiddenControls(item, false)) continue;
    const trimmed = item.trim();
    if (trimmed.length < 1 || trimmed.length > VISION_TAG_MAX) continue;
    if (!normalized.includes(trimmed)) normalized.push(trimmed);
    if (normalized.length === VISION_TAG_LIMIT) break;
  }
  return normalized;
}

function descriptionEmpty(value: string | null): boolean {
  return value === null || value.length === 0;
}

export function shouldCallVision(photo: { description: string | null; tags: string[] }): boolean {
  return descriptionEmpty(photo.description) || photo.tags.length === 0;
}

export function visionWrite(
  photo: { description: string | null; tags: string[] },
  normalized: { description: string | null; tags: string[] },
): { description: string | null; tags: string[] } {
  return {
    description: descriptionEmpty(photo.description) ? normalized.description : null,
    tags: photo.tags.length === 0 ? normalized.tags : [],
  };
}

export function embeddingInput(photo: { description: string | null; tags: string[] }): string {
  const lines: string[] = [];
  if (!descriptionEmpty(photo.description) && photo.description !== null) lines.push(photo.description);
  if (photo.tags.length > 0) lines.push(photo.tags.join(", "));
  if (lines.length === 0) return "photo";
  return lines.join("\n");
}

export function checkEmbedding(
  values: number[],
  dimensions: number,
): { ok: true } | { ok: false; code: "dimension_mismatch" | "invalid_embedding" } {
  if (values.length !== dimensions) return { ok: false, code: "dimension_mismatch" };
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return { ok: false, code: "invalid_embedding" };
  }
  return { ok: true };
}

export function failureDisposition(
  code: PipelineErrorCode,
  attempts: number,
): { outcome: "retry"; delayMs: number } | { outcome: "terminal" } {
  if (!RETRYABLE.has(code) || attempts >= PIPELINE_MAX_ATTEMPTS) return { outcome: "terminal" };
  const seconds = Math.min(30 * 2 ** (attempts - 1), 900);
  return { outcome: "retry", delayMs: seconds * 1000 };
}

export function semanticChanged(
  current: { description: string | null; tags: string[] },
  patch: MetadataPatch,
): boolean {
  if ("description" in patch && (patch.description ?? null) !== current.description) return true;
  if ("tags" in patch) {
    const next = patch.tags ?? [];
    if (next.length !== current.tags.length) return true;
    for (let index = 0; index < next.length; index += 1) {
      if (next[index] !== current.tags[index]) return true;
    }
  }
  return false;
}

export function thumbObjectKey(userId: string, photoId: string): string {
  if (!UUID.test(userId) || !UUID.test(photoId)) throw new Error("对象键标识不合法");
  return `owners/${userId}/photos/${photoId}/thumb`;
}
```

把 `apps/api/src/domain/library/model.ts` 的 `status: string` 换成 `status: PhotoStatus`，并在 `sourceKeyId` 后面加 `errorCode: string | null`。文件顶部增加：

```typescript
import type { PhotoStatus } from "./pipeline.js";
```

`Photo` 里这两行的最终形状是：

```typescript
  status: PhotoStatus;
  sourceUserId: string | null;
  sourceKeyId: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
```

把下面的 `import type` 并进 `apps/api/src/domain/library/ports.ts` 顶部已有的 import。类型声明追加到文件末尾。不要改已有的 `ObjectStorage` 方法。

```typescript
import type {
  ExifFill,
  ExifReading,
  JobStatus,
  JobType,
  PipelineErrorCode,
  PipelineStep,
} from "./pipeline.js";

export type ExifReader = {
  read(bytes: Buffer): Promise<ExifReading>;
};

export type ThumbnailEncoder = {
  encode(bytes: Buffer): Promise<{ bytes: Buffer; contentType: "image/jpeg" }>;
};

export type VisionGateway = {
  describe(input: {
    model: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<
    | { ok: true; description: string | null; tags: string[] }
    | { ok: false; kind: "vision_unavailable" | "vision_rejected" }
  >;
};

export type EmbedGateway = {
  embed(input: { model: string; text: string }): Promise<
    | { ok: true; values: number[] }
    | { ok: false; kind: "embed_unavailable" | "embed_rejected" }
  >;
};

export type ClaimedJob = {
  id: string;
  type: JobType;
  photoId: string;
  step: PipelineStep;
  attempts: number;
  lockedAt: Date;
};

export type ReclaimedJob = {
  id: string;
  type: JobType;
  photoId: string;
  attempts: number;
  lastError: string | null;
};

export type ActiveJob = { type: JobType; status: "pending" | "running" };

export type JobRecord = {
  id: string;
  type: JobType;
  photoId: string;
  step: PipelineStep;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  runAfter: Date;
  lockedAt: Date | null;
};

export type EmbeddingPlan = "write" | "text_changed" | "need_thumbnail";

export type PipelineStore = {
  reclaimExpired(now: Date): Promise<ReclaimedJob[]>;
  claim(now: Date, limit: number): Promise<ClaimedJob[]>;
  readPhoto(photoId: string): Promise<Photo | null>;
  listForPhoto(photoId: string): Promise<JobRecord[]>;
  applyExif(input: { jobId: string; lockedAt: Date; photoId: string; fill: ExifFill; now: Date }): Promise<"ok" | "lost">;
  noteThumbPresent(input: { jobId: string; lockedAt: Date; now: Date }): Promise<"ok" | "lost">;
  commitThumb(input: {
    jobId: string;
    lockedAt: Date;
    photoId: string;
    thumbKey: string;
    now: Date;
  }): Promise<"ok" | "missing" | "conflict" | "lost">;
  skipVision(input: { jobId: string; lockedAt: Date; now: Date }): Promise<"ok" | "lost">;
  applyVision(input: {
    jobId: string;
    lockedAt: Date;
    photoId: string;
    description: string | null;
    tags: string[];
    now: Date;
  }): Promise<"ok" | "lost">;
  commitEmbedding(
    input: {
      jobId: string;
      lockedAt: Date;
      photoId: string;
      jobType: JobType;
      values: number[];
      dimensions: number;
      model: string;
      now: Date;
    },
    plan: (photo: Photo) => EmbeddingPlan,
  ): Promise<"written" | "text_changed" | "need_thumbnail" | "missing" | "lost">;
  rewindToThumbnail(input: { jobId: string; lockedAt: Date; now: Date }): Promise<"ok" | "lost">;
  retryJob(input: {
    jobId: string;
    lockedAt: Date;
    photoId: string;
    jobType: JobType;
    code: PipelineErrorCode;
    runAfter: Date;
    now: Date;
  }): Promise<"ok" | "lost">;
  failJob(input: {
    jobId: string;
    lockedAt: Date;
    photoId: string;
    jobType: JobType;
    code: PipelineErrorCode;
    now: Date;
  }): Promise<"ok" | "lost">;
  releaseRunning(input: { jobId: string; lockedAt: Date; now: Date }): Promise<"ok" | "lost">;
};

export type PipelineLogFields = {
  userId?: string;
  photoId?: string;
  objectKey?: string;
  jobId?: string;
  jobType?: JobType;
  step?: PipelineStep;
  attempt?: number;
  errorCode?: PipelineErrorCode | "interrupted";
  errorName?: string;
};

export type PipelineLog = {
  info(message: string, fields: PipelineLogFields): void;
  warn(message: string, fields: PipelineLogFields): void;
};
```

`ports.ts` 顶部的类型导入并入上面的 `pipeline.js` 导入。不要从端口文件再导出一份重复的 `Photo`。

在 `apps/api/src/domain/library/index.ts` 增加：

```typescript
export {
  PIPELINE_LEASE_MS,
  PIPELINE_MAX_ATTEMPTS,
  ThumbnailEncodeError,
  checkEmbedding,
  embeddingInput,
  exifFill,
  failureDisposition,
  normalizeVisionDescription,
  normalizeVisionTags,
  parseJobStep,
  parsePhotoStatus,
  semanticChanged,
  shouldCallVision,
  thumbObjectKey,
  visionWrite,
} from "./pipeline.js";
export type {
  ActiveJob,
  ClaimedJob,
  EmbedGateway,
  EmbeddingPlan,
  ExifReader,
  JobRecord,
  PipelineLog,
  PipelineLogFields,
  PipelineStore,
  ReclaimedJob,
  ThumbnailEncoder,
  VisionGateway,
} from "./ports.js";
export type {
  ExifFill,
  ExifReading,
  JobStatus,
  JobType,
  PhotoStatus,
  PipelineErrorCode,
  PipelineStep,
} from "./pipeline.js";
```

- [ ] **Step 4: 让照片映射读出 error_message**

在 `apps/api/src/dao/photo-repository.ts` 增加导入 `parsePhotoStatus`。把三处 SELECT 列清单都换成同一段，列名为：

```sql
id, owner_id, object_key, thumb_key, content_type, byte_size,
taken_at, location_text, latitude, longitude, description, tags,
status, source_user_id, source_key_id, error_message, created_at, updated_at
```

`mapPhoto` 里把 `status: String(row.status)` 换成 `status: parsePhotoStatus(String(row.status))`，并增加：

```typescript
    errorCode: row.error_message == null ? null : String(row.error_message),
```

不要在本任务插入 job，也不要改 `insertPhotoAndComplete`。

- [ ] **Step 5: 运行测试，确认通过**

Run:

```bash
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-rules.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 两者退出码都是 0。领域文件里不要出现 `Date.now`、`new Date()`、`process.env`。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/domain/library/pipeline.ts apps/api/src/domain/library/model.ts apps/api/src/domain/library/ports.ts apps/api/src/domain/library/index.ts apps/api/src/dao/photo-repository.ts apps/api/test/pipeline-rules.test.ts
git commit -m "feat: 增加处理流水线领域规则"
```


---

### Task 3: 任务仓储、同事务入队与向量字面量

**Files:**
- Create: `apps/api/src/dao/vector-literal.ts`
- Create: `apps/api/src/dao/pipeline-store.ts`
- Modify: `apps/api/src/domain/library/ports.ts`
- Modify: `apps/api/src/dao/photo-repository.ts`
- Modify: `apps/api/src/dao/upload-session-repository.ts`
- Modify: `apps/api/src/dao/index.ts`
- Modify: `apps/api/src/adapters/library/complete-upload.ts`
- Modify: `apps/api/test/library-dao.test.ts`
- Test: `apps/api/test/pipeline-dao.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `PipelineStore`、`ClaimedJob`、`parseJobStep`、`parsePhotoStatus`、`PIPELINE_LEASE_MS`
- Produces:
  - `formatVectorLiteral(values: number[], dimensions: number): string`。长度不符抛出 `name` 为 `DimensionMismatch` 的错误；含非有限数抛出 `name` 为 `InvalidEmbedding` 的错误。不发 SQL
  - `createPipelineStore(pool: pg.Pool): PipelineStore`
  - `InsertCompletedPhoto` 增加必填 `jobId: string`。`insertPhotoAndComplete` 在照片插入成功的同一事务插入 `process_photo`，`payload` 为 `{"step":"exif"}`，`run_after` 与 `created_at` 都是 `input.now`
  - `PhotoRepository.ensureProcessPhoto(input: { photoId: string; jobId: string; now: Date }): Promise<"inserted" | "skipped">`
  - `PhotoRepository.transactOwned(photoId, ownerId, mutate): Promise<void>`
  - `PhotoMutation`：`update`、`activeJobs`、`insertReembed`、`insertProcessPhoto`、`deletePendingReembed`、`resetForRetry`
  - `mapPhotoRow(row: Record<string, unknown> | undefined): Photo | null` 从 `photo-repository.ts` 导出

本任务的 `complete-upload` 只补上 `jobId: deps.ids.nextId()`。`exists` 之后的补救留到 Task 8，本任务不要调用 `ensureProcessPhoto`。

- [ ] **Step 1: 写会失败的仓储测试**

创建 `apps/api/test/pipeline-dao.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import type { User } from "../src/domain/identity/model.js";
import { createPhotoRepository } from "../src/dao/photo-repository.js";
import { createPipelineStore } from "../src/dao/pipeline-store.js";
import { createUploadSessionRepository } from "../src/dao/upload-session-repository.js";
import { createUserRepository } from "../src/dao/user-repository.js";
import { formatVectorLiteral } from "../src/dao/vector-literal.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";

const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
const now = new Date("2030-06-01T00:00:00.000Z");
const ownerId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const photoId = "33333333-3333-4333-8333-333333333333";
const jobId = "55555555-5555-4555-8555-555555555555";

let tail: Promise<unknown> = Promise.resolve();
function serial(name: string, fn: () => Promise<void>): void {
  test(name, () => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  });
}

test.before(async () => {
  await applySchema(pool);
});

test.after(async () => {
  await pool.end();
});

async function reset(): Promise<void> {
  await pool.query("TRUNCATE TABLE users CASCADE");
}

async function seedPhoto(): Promise<void> {
  await reset();
  const users = createUserRepository(pool);
  const user: User = { id: ownerId, email: "pipe@example.com", passwordHash: "hash", createdAt: now };
  assert.equal(await users.insert(user), "ok");
  const sessions = createUploadSessionRepository(pool);
  await sessions.insert({
    id: sessionId,
    ownerId,
    photoId,
    objectKey: `owners/${ownerId}/photos/${photoId}/original`,
    contentType: "image/jpeg",
    byteSize: 4,
    s3UploadId: "upload-1",
    expiresAt: new Date(now.getTime() + 86_400_000),
    createdAt: now,
  });
  await sessions.transactById(sessionId, async (_row, tx) => {
    await tx.setCompleting(sessionId, now);
  });
  await sessions.markObjectCompleted(sessionId, now);
  assert.equal(
    await sessions.insertPhotoAndComplete({
      sessionId,
      photoId,
      ownerId,
      objectKey: `owners/${ownerId}/photos/${photoId}/original`,
      contentType: "image/jpeg",
      byteSize: 4,
      sourceUserId: ownerId,
      sourceKeyId: null,
      now,
      jobId,
    }),
    "inserted",
  );
}

function vector(length: number, first = 0.01): number[] {
  return Array.from({ length }, (_item, index) => (index === 0 ? first : 0));
}

serial("首次完成同一事务插入 process_photo，重复完成不新增", async () => {
  await seedPhoto();
  const jobs = await pool.query(
    `SELECT type, payload->>'step' AS step, status, attempts FROM jobs WHERE photo_id = $1`,
    [photoId],
  );
  assert.equal(jobs.rowCount, 1);
  assert.equal(jobs.rows[0].type, "process_photo");
  assert.equal(jobs.rows[0].step, "exif");
  assert.equal(jobs.rows[0].status, "pending");
  assert.equal(jobs.rows[0].attempts, 0);
  const sessions = createUploadSessionRepository(pool);
  assert.equal(
    await sessions.insertPhotoAndComplete({
      sessionId,
      photoId,
      ownerId,
      objectKey: `owners/${ownerId}/photos/${photoId}/original`,
      contentType: "image/jpeg",
      byteSize: 4,
      sourceUserId: ownerId,
      sourceKeyId: null,
      now,
      jobId: "55555555-5555-4555-8555-555555555556",
    }),
    "exists",
  );
  const again = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1`, [photoId]);
  assert.equal(again.rows[0].n, 1);
});

serial("领取加一 attempts，第二张到期任务要等下一次", async () => {
  await seedPhoto();
  const store = createPipelineStore(pool);
  const otherPhoto = "33333333-3333-4333-8333-333333333334";
  const otherJob = "55555555-5555-4555-8555-555555555557";
  await pool.query(
    `INSERT INTO photos (
       id, owner_id, object_key, content_type, byte_size, tags, status, created_at, updated_at
     ) VALUES ($1, $2, $3, 'image/jpeg', 4, '{}', 'processing', $4, $4)`,
    [otherPhoto, ownerId, `owners/${ownerId}/photos/${otherPhoto}/original`, now],
  );
  await pool.query(
    `INSERT INTO jobs (id, type, photo_id, payload, status, run_after, created_at, updated_at)
     VALUES ($1, 'process_photo', $2, '{"step":"exif"}'::jsonb, 'pending', $3, $3, $3)`,
    [otherJob, otherPhoto, new Date(now.getTime() + 60_000)],
  );
  const claimed = await store.claim(now, 2);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, jobId);
  assert.equal(claimed[0].attempts, 1);
  assert.equal(claimed[0].step, "exif");
  assert.equal(claimed[0].lockedAt.toISOString(), now.toISOString());
  const pending = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [otherJob]);
  assert.equal(pending.rows[0].status, "pending");
});

serial("租约回收不把 vision_unavailable 改成 interrupted", async () => {
  await seedPhoto();
  const lockedAt = new Date(now.getTime() - 600_000);
  await pool.query(
    `UPDATE jobs
     SET status = 'running', attempts = 5, last_error = 'vision_unavailable', locked_at = $2, updated_at = $2
     WHERE id = $1`,
    [jobId, lockedAt],
  );
  await pool.query(
    `UPDATE photos SET error_message = 'vision_unavailable', updated_at = $2 WHERE id = $1`,
    [photoId, lockedAt],
  );
  const store = createPipelineStore(pool);
  const reclaimed = await store.reclaimExpired(now);
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].attempts, 5);
  assert.equal(reclaimed[0].lastError, "vision_unavailable");
  const job = await pool.query(`SELECT status, last_error, locked_at FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(job.rows[0].status, "failed");
  assert.equal(job.rows[0].last_error, "vision_unavailable");
  assert.equal(job.rows[0].locked_at, null);
  const photo = await pool.query(`SELECT status, error_message FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].status, "failed");
  assert.equal(photo.rows[0].error_message, "vision_unavailable");
  const interrupted = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM jobs WHERE last_error = 'interrupted') +
       (SELECT count(*)::int FROM photos WHERE error_message = 'interrupted') AS n`,
  );
  assert.equal(interrupted.rows[0].n, 0);
});

serial("向量字面量拒绝科学计数法、坏维度和 NaN", () => {
  assert.equal(formatVectorLiteral([0.01, -0.02], 2), "[0.01,-0.02]");
  assert.equal(/[eE]/.test(formatVectorLiteral([1e-7], 1)), false);
  assert.equal(formatVectorLiteral([1e-7], 1), "[0.0000001]");
  assert.throws(() => formatVectorLiteral([1], 2), (error: unknown) => (error as { name?: string }).name === "DimensionMismatch");
  assert.throws(() => formatVectorLiteral([Number.NaN], 1), (error: unknown) => (error as { name?: string }).name === "InvalidEmbedding");
});

serial("嵌入提交写入 1536 维并在文本变化时回滚", async () => {
  await seedPhoto();
  const store = createPipelineStore(pool);
  const claimed = await store.claim(now, 1);
  const values = vector(1536);
  const written = await store.commitEmbedding(
    {
      jobId: claimed[0].id,
      lockedAt: claimed[0].lockedAt,
      photoId,
      jobType: "process_photo",
      values,
      dimensions: 1536,
      model: "embed-test",
      now,
    },
    () => "need_thumbnail",
  );
  assert.equal(written, "need_thumbnail");
  const none = await pool.query(`SELECT count(*)::int AS n FROM photo_embeddings WHERE photo_id = $1`, [photoId]);
  assert.equal(none.rows[0].n, 0);
  const stillRunning = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(stillRunning.rows[0].status, "running");

  await pool.query(`UPDATE photos SET thumb_key = $2 WHERE id = $1`, [photoId, `owners/${ownerId}/photos/${photoId}/thumb`]);
  const done = await store.commitEmbedding(
    {
      jobId: claimed[0].id,
      lockedAt: claimed[0].lockedAt,
      photoId,
      jobType: "process_photo",
      values,
      dimensions: 1536,
      model: "embed-test",
      now,
    },
    () => "write",
  );
  assert.equal(done, "written");
  const embedding = await pool.query(`SELECT model, vector_dims(embedding) AS dims FROM photo_embeddings WHERE photo_id = $1`, [photoId]);
  assert.equal(embedding.rows[0].model, "embed-test");
  assert.equal(embedding.rows[0].dims, 1536);
  const job = await pool.query(`SELECT status, payload->>'step' AS step, last_error FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(job.rows[0].status, "done");
  assert.equal(job.rows[0].step, "done");
  assert.equal(job.rows[0].last_error, null);
  const photo = await pool.query(`SELECT status, error_message FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].status, "ready");
  assert.equal(photo.rows[0].error_message, null);
});
```

同时把 `apps/api/test/library-dao.test.ts` 里两处 `insertPhotoAndComplete({ ... now })` 都加上 `jobId`。第一处用 `"55555555-5555-4555-8555-555555555551"`，第二处用 `"55555555-5555-4555-8555-555555555552"`。第一处成功断言之后加：

```typescript
  const queued = await pool.query(
    `SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1 AND type = 'process_photo'`,
    [photoId],
  );
  assert.equal(queued.rows[0]?.n, 1);
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-dao.test.ts
```

Expected: 退出码非 0。`createPipelineStore` 或 `formatVectorLiteral` 未定义，或插入参数不认识 `jobId`。

- [ ] **Step 3: 写向量字面量与任务仓储**

创建 `apps/api/src/dao/vector-literal.ts`：

```typescript
export function formatVectorLiteral(values: number[], dimensions: number): string {
  if (values.length !== dimensions) {
    throw Object.assign(new Error("dimension_mismatch"), { name: "DimensionMismatch" });
  }
  const parts = values.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw Object.assign(new Error("invalid_embedding"), { name: "InvalidEmbedding" });
    }
    return formatDecimal(value);
  });
  return `[${parts.join(",")}]`;
}

function formatDecimal(value: number): string {
  if (Object.is(value, -0) || value === 0) return "0";
  const negative = value < 0;
  const text = Math.abs(value).toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  return negative ? `-${text}` : text;
}
```

创建 `apps/api/src/dao/pipeline-store.ts`：

```typescript
import pg from "pg";
import { PIPELINE_LEASE_MS, parseJobStep, type JobType } from "../domain/library/pipeline.js";
import type {
  ClaimedJob,
  EmbeddingPlan,
  JobRecord,
  PipelineStore,
  ReclaimedJob,
} from "../domain/library/ports.js";
import { mapPhotoRow } from "./photo-repository.js";
import { formatVectorLiteral } from "./vector-literal.js";

const PHOTO_COLUMNS = `id, owner_id, object_key, thumb_key, content_type, byte_size,
  taken_at, location_text, latitude, longitude, description, tags,
  status, source_user_id, source_key_id, error_message, created_at, updated_at`;

class LostLock extends Error {
  constructor() {
    super("lost");
    this.name = "LostLock";
  }
}

export function createPipelineStore(pool: pg.Pool): PipelineStore {
  return {
    async reclaimExpired(now) {
      return transaction(pool, async (client) => {
        const cutoff = new Date(now.getTime() - PIPELINE_LEASE_MS);
        const updated = await client.query(
          `UPDATE jobs
           SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
               run_after = CASE WHEN attempts >= 5 THEN run_after ELSE $2 END,
               locked_at = NULL,
               updated_at = $2
           WHERE status = 'running'
             AND locked_at IS NOT NULL
             AND locked_at <= $1
           RETURNING id, type, photo_id, attempts, last_error, status`,
          [cutoff, now],
        );
        const reclaimed: ReclaimedJob[] = [];
        for (const row of updated.rows) {
          if (row.status === "failed" && row.type === "process_photo") {
            await client.query(
              `UPDATE photos
               SET status = 'failed', updated_at = $2
               WHERE id = $1 AND status = 'processing'`,
              [row.photo_id, now],
            );
          }
          reclaimed.push({
            id: String(row.id),
            type: row.type as JobType,
            photoId: String(row.photo_id),
            attempts: Number(row.attempts),
            lastError: row.last_error == null ? null : String(row.last_error),
          });
        }
        return reclaimed;
      });
    },

    async claim(now, limit) {
      return transaction(pool, async (client) => {
        const result = await client.query(
          `UPDATE jobs
           SET status = 'running',
               attempts = attempts + 1,
               locked_at = $1,
               updated_at = $1
           WHERE id IN (
             SELECT id FROM jobs
             WHERE status = 'pending' AND run_after <= $1
             ORDER BY run_after, created_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT $2
           )
           RETURNING id, type, photo_id, payload, attempts, locked_at`,
          [now, limit],
        );
        return result.rows.map((row) => ({
          id: String(row.id),
          type: row.type as ClaimedJob["type"],
          photoId: String(row.photo_id),
          step: parseJobStep(row.payload),
          attempts: Number(row.attempts),
          lockedAt: row.locked_at as Date,
        }));
      });
    },

    async readPhoto(photoId) {
      const result = await pool.query(`SELECT ${PHOTO_COLUMNS} FROM photos WHERE id = $1`, [photoId]);
      return mapPhotoRow(result.rows[0]);
    },

    async listForPhoto(photoId) {
      const result = await pool.query(
        `SELECT id, type, photo_id, payload, status, attempts, last_error, run_after, locked_at
         FROM jobs WHERE photo_id = $1 ORDER BY created_at, id`,
        [photoId],
      );
      return result.rows.map(mapJob);
    },

    async applyExif(input) {
      return step(pool, async (client) => {
        await client.query(
          `UPDATE photos
           SET taken_at = CASE
                 WHEN taken_at IS NULL AND $2::timestamptz IS NOT NULL THEN $2::timestamptz
                 ELSE taken_at
               END,
               latitude = CASE
                 WHEN latitude IS NULL AND longitude IS NULL
                  AND $3::float8 IS NOT NULL AND $4::float8 IS NOT NULL THEN $3::float8
                 ELSE latitude
               END,
               longitude = CASE
                 WHEN latitude IS NULL AND longitude IS NULL
                  AND $3::float8 IS NOT NULL AND $4::float8 IS NOT NULL THEN $4::float8
                 ELSE longitude
               END,
               updated_at = $5
           WHERE id = $1`,
          [input.photoId, input.fill.takenAt ?? null, input.fill.latitude ?? null, input.fill.longitude ?? null, input.now],
        );
        await advance(client, input.jobId, input.lockedAt, "thumbnail", input.now);
      });
    },

    async noteThumbPresent(input) {
      return step(pool, async (client) => {
        await advance(client, input.jobId, input.lockedAt, "vision", input.now);
      });
    },

    async commitThumb(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const updated = await client.query(
          `UPDATE photos
           SET thumb_key = $2, updated_at = $3
           WHERE id = $1 AND (thumb_key IS NULL OR thumb_key = $2)`,
          [input.photoId, input.thumbKey, input.now],
        );
        if (updated.rowCount !== 1) {
          const exists = await client.query(`SELECT 1 FROM photos WHERE id = $1`, [input.photoId]);
          await client.query("ROLLBACK");
          return exists.rowCount === 1 ? "conflict" : "missing";
        }
        const job = await client.query(
          `UPDATE jobs
           SET payload = '{"step":"vision"}'::jsonb, updated_at = $3
           WHERE id = $1 AND status = 'running' AND locked_at = $2`,
          [input.jobId, input.lockedAt, input.now],
        );
        if (job.rowCount !== 1) {
          await client.query("ROLLBACK");
          return "lost";
        }
        await client.query("COMMIT");
        return "ok";
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async skipVision(input) {
      return step(pool, async (client) => {
        await advance(client, input.jobId, input.lockedAt, "embed", input.now);
      });
    },

    async applyVision(input) {
      return step(pool, async (client) => {
        await client.query(
          `UPDATE photos
           SET description = CASE
                 WHEN description IS NULL AND $2::text IS NOT NULL THEN $2
                 ELSE description
               END,
               tags = CASE
                 WHEN tags = '{}'::text[] AND cardinality($3::text[]) > 0 THEN $3
                 ELSE tags
               END,
               updated_at = $4
           WHERE id = $1`,
          [input.photoId, input.description, input.tags, input.now],
        );
        await advance(client, input.jobId, input.lockedAt, "embed", input.now);
      });
    },

    async commitEmbedding(input, plan) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query(`SELECT ${PHOTO_COLUMNS} FROM photos WHERE id = $1 FOR UPDATE`, [input.photoId]);
        const photo = mapPhotoRow(found.rows[0]);
        if (!photo) {
          await client.query("ROLLBACK");
          return "missing";
        }
        const decision: EmbeddingPlan = plan(photo);
        if (decision !== "write") {
          await client.query("ROLLBACK");
          return decision;
        }
        const literal = formatVectorLiteral(input.values, input.dimensions);
        await client.query(
          `INSERT INTO photo_embeddings (photo_id, embedding, model, updated_at)
           VALUES ($1, $2::vector, $3, $4)
           ON CONFLICT (photo_id) DO UPDATE
           SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, updated_at = EXCLUDED.updated_at`,
          [input.photoId, literal, input.model, input.now],
        );
        if (input.jobType === "process_photo") {
          await client.query(
            `UPDATE photos SET status = 'ready', error_message = NULL, updated_at = $2 WHERE id = $1`,
            [input.photoId, input.now],
          );
        } else {
          await client.query(
            `UPDATE photos
             SET status = CASE WHEN thumb_key IS NOT NULL THEN 'ready' ELSE status END,
                 error_message = CASE WHEN thumb_key IS NOT NULL THEN NULL ELSE error_message END,
                 updated_at = $2
             WHERE id = $1`,
            [input.photoId, input.now],
          );
        }
        const job = await client.query(
          `UPDATE jobs
           SET status = 'done', payload = '{"step":"done"}'::jsonb, locked_at = NULL, last_error = NULL, updated_at = $3
           WHERE id = $1 AND status = 'running' AND locked_at = $2`,
          [input.jobId, input.lockedAt, input.now],
        );
        if (job.rowCount !== 1) {
          await client.query("ROLLBACK");
          return "lost";
        }
        await client.query("COMMIT");
        return "written";
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async rewindToThumbnail(input) {
      return step(pool, async (client) => {
        await advance(client, input.jobId, input.lockedAt, "thumbnail", input.now);
      });
    },

    async retryJob(input) {
      return step(pool, async (client) => {
        const job = await client.query(
          `UPDATE jobs
           SET status = 'pending', run_after = $4, locked_at = NULL, last_error = $3, updated_at = $5
           WHERE id = $1 AND status = 'running' AND locked_at = $2`,
          [input.jobId, input.lockedAt, input.code, input.runAfter, input.now],
        );
        if (job.rowCount !== 1) throw new LostLock();
        if (input.jobType === "process_photo") {
          await client.query(
            `UPDATE photos SET error_message = $3, updated_at = $4 WHERE id = $1 AND status = 'processing'`,
            [input.photoId, input.code, input.now],
          );
        }
      });
    },

    async failJob(input) {
      return step(pool, async (client) => {
        const job = await client.query(
          `UPDATE jobs
           SET status = 'failed', locked_at = NULL, last_error = $3, updated_at = $4
           WHERE id = $1 AND status = 'running' AND locked_at = $2`,
          [input.jobId, input.lockedAt, input.code, input.now],
        );
        if (job.rowCount !== 1) throw new LostLock();
        if (input.jobType === "process_photo") {
          await client.query(
            `UPDATE photos
             SET status = 'failed', error_message = $3, updated_at = $4
             WHERE id = $1 AND status = 'processing'`,
            [input.photoId, input.code, input.now],
          );
        }
      });
    },

    async releaseRunning(input) {
      return step(pool, async (client) => {
        const job = await client.query(
          `UPDATE jobs
           SET status = 'pending', run_after = $3, locked_at = NULL,
               attempts = GREATEST(attempts - 1, 0), updated_at = $3
           WHERE id = $1 AND status = 'running' AND locked_at = $2`,
          [input.jobId, input.lockedAt, input.now],
        );
        if (job.rowCount !== 1) throw new LostLock();
      });
    },
  };
}

function mapJob(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    type: row.type as JobRecord["type"],
    photoId: String(row.photo_id),
    step: parseJobStep(row.payload),
    status: row.status as JobRecord["status"],
    attempts: Number(row.attempts),
    lastError: row.last_error == null ? null : String(row.last_error),
    runAfter: row.run_after as Date,
    lockedAt: (row.locked_at as Date | null) ?? null,
  };
}

async function advance(client: pg.PoolClient, jobId: string, lockedAt: Date, step: string, now: Date): Promise<void> {
  const job = await client.query(
    `UPDATE jobs SET payload = $4::jsonb, updated_at = $3
     WHERE id = $1 AND status = 'running' AND locked_at = $2`,
    [jobId, lockedAt, now, JSON.stringify({ step })],
  );
  if (job.rowCount !== 1) throw new LostLock();
}

async function step(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<void>): Promise<"ok" | "lost"> {
  try {
    await transaction(pool, fn);
    return "ok";
  } catch (error) {
    if (error instanceof LostLock) return "lost";
    throw error;
  }
}

async function transaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: 同事务入队，并补上锁内变更端口**

`InsertCompletedPhoto` 增加 `jobId: string`。在 `insertPhotoAndComplete` 里，照片 `INSERT` 成功、会话 `UPDATE` 之前执行：

```typescript
        await client.query(
          `INSERT INTO jobs (
             id, type, photo_id, payload, status, attempts, last_error, run_after, locked_at, created_at, updated_at
           ) VALUES (
             $1, 'process_photo', $2, '{"step":"exif"}'::jsonb, 'pending', 0, NULL, $3, NULL, $3, $3
           )`,
          [input.jobId, input.photoId, input.now],
        );
```

主键冲突仍在照片 `INSERT` 的 `catch` 里 `ROLLBACK` 并返回 `"exists"`，不要插入 job。

在 `ports.ts` 的 `PhotoRepository` 上增加：

```typescript
  ensureProcessPhoto(input: { photoId: string; jobId: string; now: Date }): Promise<"inserted" | "skipped">;
  transactOwned(
    photoId: string,
    ownerId: string,
    mutate: (photo: Photo | null, tx: PhotoMutation) => Promise<void>,
  ): Promise<void>;
```

并声明：

```typescript
export type PhotoMutation = {
  update(patch: MetadataPatch, now: Date): Promise<Photo | null>;
  activeJobs(): Promise<ActiveJob[]>;
  insertReembed(job: { id: string; runAfter: Date; now: Date }): Promise<"inserted" | "conflict">;
  insertProcessPhoto(job: { id: string; runAfter: Date; now: Date }): Promise<"inserted" | "conflict">;
  deletePendingReembed(): Promise<void>;
  resetForRetry(now: Date): Promise<Photo | null>;
};
```

`photo-repository.ts` 把 `function mapPhoto` 改成 `export function mapPhotoRow`，文件内调用同步改名。实现两个新方法：

```typescript
    async ensureProcessPhoto(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const photo = await client.query(`SELECT status FROM photos WHERE id = $1 FOR UPDATE`, [input.photoId]);
        if (photo.rows[0]?.status !== "processing") {
          await client.query("COMMIT");
          return "skipped";
        }
        const existing = await client.query(
          `SELECT 1 FROM jobs WHERE photo_id = $1 AND type = 'process_photo' LIMIT 1`,
          [input.photoId],
        );
        if ((existing.rowCount ?? 0) > 0) {
          await client.query("COMMIT");
          return "skipped";
        }
        const inserted = await client.query(
          `INSERT INTO jobs (
             id, type, photo_id, payload, status, attempts, last_error, run_after, locked_at, created_at, updated_at
           ) VALUES (
             $1, 'process_photo', $2, '{"step":"exif"}'::jsonb, 'pending', 0, NULL, $3, NULL, $3, $3
           )
           ON CONFLICT (photo_id, type) WHERE status IN ('pending', 'running') DO NOTHING`,
          [input.jobId, input.photoId, input.now],
        );
        await client.query("COMMIT");
        return inserted.rowCount === 1 ? "inserted" : "skipped";
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async transactOwned(photoId, ownerId, mutate) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query(
          `SELECT ${PHOTO_COLUMNS} FROM photos WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
          [photoId, ownerId],
        );
        const tx = createPhotoMutation(client, photoId, ownerId);
        await mutate(mapPhotoRow(found.rows[0]), tx);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
```

`PHOTO_COLUMNS` 与 Task 2 的列清单相同，包含 `error_message`。`createPhotoMutation` 用同一个 `client`：

```typescript
function createPhotoMutation(client: pg.PoolClient, photoId: string, ownerId: string): PhotoMutation {
  return {
    async update(patch, updatedAt) {
      const sets: string[] = [];
      const values: unknown[] = [photoId, ownerId];
      let index = 3;
      if ("description" in patch) {
        sets.push(`description = $${index++}`);
        values.push(patch.description);
      }
      if ("tags" in patch) {
        sets.push(`tags = $${index++}`);
        values.push(patch.tags);
      }
      if ("takenAt" in patch) {
        sets.push(`taken_at = $${index++}`);
        values.push(patch.takenAt);
      }
      if ("locationText" in patch) {
        sets.push(`location_text = $${index++}`);
        values.push(patch.locationText);
      }
      if ("latitude" in patch) {
        sets.push(`latitude = $${index++}`);
        values.push(patch.latitude);
      }
      if ("longitude" in patch) {
        sets.push(`longitude = $${index++}`);
        values.push(patch.longitude);
      }
      sets.push(`updated_at = $${index++}`);
      values.push(updatedAt);
      const result = await client.query(
        `UPDATE photos SET ${sets.join(", ")} WHERE id = $1 AND owner_id = $2 RETURNING ${PHOTO_COLUMNS}`,
        values,
      );
      return mapPhotoRow(result.rows[0]);
    },
    async activeJobs() {
      const result = await client.query(
        `SELECT type, status FROM jobs WHERE photo_id = $1 AND status IN ('pending', 'running')`,
        [photoId],
      );
      return result.rows.map((row) => ({
        type: row.type as ActiveJob["type"],
        status: row.status as ActiveJob["status"],
      }));
    },
    async insertReembed(job) {
      return insertJob(client, photoId, job, "reembed", "embed");
    },
    async insertProcessPhoto(job) {
      return insertJob(client, photoId, job, "process_photo", "exif");
    },
    async deletePendingReembed() {
      await client.query(
        `DELETE FROM jobs WHERE photo_id = $1 AND type = 'reembed' AND status = 'pending'`,
        [photoId],
      );
    },
    async resetForRetry(updatedAt) {
      const result = await client.query(
        `UPDATE photos
         SET status = 'processing', error_message = NULL, updated_at = $3
         WHERE id = $1 AND owner_id = $2 AND status = 'failed'
         RETURNING ${PHOTO_COLUMNS}`,
        [photoId, ownerId, updatedAt],
      );
      return mapPhotoRow(result.rows[0]);
    },
  };
}

async function insertJob(
  client: pg.PoolClient,
  photoId: string,
  job: { id: string; runAfter: Date; now: Date },
  type: "reembed" | "process_photo",
  step: "embed" | "exif",
): Promise<"inserted" | "conflict"> {
  const result = await client.query(
    `INSERT INTO jobs (
       id, type, photo_id, payload, status, attempts, last_error, run_after, locked_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4::jsonb, 'pending', 0, NULL, $5, NULL, $6, $6
     )
     ON CONFLICT (photo_id, type) WHERE status IN ('pending', 'running') DO NOTHING`,
    [job.id, type, photoId, JSON.stringify({ step }), job.runAfter, job.now],
  );
  return result.rowCount === 1 ? "inserted" : "conflict";
}
```

`dao/index.ts` 增加：

```typescript
export { createPipelineStore } from "./pipeline-store.js";
export { formatVectorLiteral } from "./vector-literal.js";
```

`complete-upload.ts` 的 `insertPhotoAndComplete` 调用补上 `jobId: deps.ids.nextId()`。不要在 `exists` 分支调用 `ensureProcessPhoto`。

- [ ] **Step 5: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-dao.test.ts apps/api/test/library-dao.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/dao/vector-literal.ts apps/api/src/dao/pipeline-store.ts apps/api/src/dao/photo-repository.ts apps/api/src/dao/upload-session-repository.ts apps/api/src/dao/index.ts apps/api/src/domain/library/ports.ts apps/api/src/adapters/library/complete-upload.ts apps/api/test/pipeline-dao.test.ts apps/api/test/library-dao.test.ts
git commit -m "feat: 领取流水线任务并在完成上传时入队"
```

---

### Task 4: 对象存储读取与覆盖写入

**Files:**
- Modify: `apps/api/src/domain/library/ports.ts`
- Modify: `apps/api/src/gateways/storage/fake-object-storage.ts`
- Modify: `apps/api/src/gateways/storage/s3-object-storage.ts`
- Test: `apps/api/test/fake-storage.test.ts`
- Test: `apps/api/test/s3-storage.test.ts`

**Interfaces:**
- Consumes: Phase 2 的 `ObjectStorage`。假存储的 `completed` 映射已经保存 multipart 完成后的字节
- Produces:
  - `getObject(input: { key: string }): Promise<{ body: Buffer; byteSize: number } | null>`
  - `putObject(input: { key: string; contentType: string; body: Buffer }): Promise<void>`
  - `FakeObjectStorage` 增加 `putObjectCalls: number`、`getObjectCalls: number`、`failGetObject: boolean`、`failPutObject: boolean`
  - S3 适配的 `send` 接受可选第二参数 `{ abortSignal?: AbortSignal }`。`GetObject` 与 `PutObject` 各自 60 秒后 abort。`NotFound` 与 `NoSuchKey` 使 `getObject` 返回 `null`

- [ ] **Step 1: 写会失败的存储测试**

在 `apps/api/test/fake-storage.test.ts` 末尾追加：

```typescript
test("getObject 读到完成后的原图，putObject 按键覆盖", async () => {
  const storage = createFakeObjectStorage();
  const upload = await storage.createMultipartUpload({ key: "owners/u/photos/p/original", contentType: "image/jpeg" });
  await storage.uploadPart({ key: "owners/u/photos/p/original", uploadId: upload.uploadId, partNumber: 1, body: Buffer.from("abc") });
  await storage.completeMultipartUpload({
    key: "owners/u/photos/p/original",
    uploadId: upload.uploadId,
    parts: [{ partNumber: 1, etag: "ignored" }],
  });
  const original = await storage.getObject({ key: "owners/u/photos/p/original" });
  assert.equal(original?.byteSize, 3);
  assert.equal(original?.body.toString(), "abc");
  assert.equal(await storage.getObject({ key: "missing" }), null);
  await storage.putObject({ key: "owners/u/photos/p/thumb", contentType: "image/jpeg", body: Buffer.from("jpeg") });
  const thumb = await storage.getObject({ key: "owners/u/photos/p/thumb" });
  assert.equal(thumb?.body.toString(), "jpeg");
  assert.equal(storage.putObjectCalls, 1);
  storage.failGetObject = true;
  await assert.rejects(() => storage.getObject({ key: "owners/u/photos/p/thumb" }), (error: unknown) => (error as { name?: string }).name === "InternalError");
});
```

在 `apps/api/test/s3-storage.test.ts` 末尾追加一个测试。桩客户端记录命令名和 `options?.abortSignal`，`GetObjectCommand` 返回 `{ Body: Buffer.from("bytes") }`，`PutObjectCommand` 返回 `{}`，`NoSuchKey` 时 `getObject` 返回 `null`：

```typescript
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
npx tsx --test --test-concurrency=1 apps/api/test/fake-storage.test.ts apps/api/test/s3-storage.test.ts
```

Expected: 退出码非 0。`getObject` 不是函数。

- [ ] **Step 3: 扩展端口与两个适配**

`ObjectStorage` 增加：

```typescript
  getObject(input: { key: string }): Promise<{ body: Buffer; byteSize: number } | null>;
  putObject(input: { key: string; contentType: string; body: Buffer }): Promise<void>;
```

`S3CommandClient.send` 的签名改为：

```typescript
  send(
    command: { constructor: { name: string }; input: Record<string, unknown> },
    options?: { abortSignal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
```

在 `s3-object-storage.ts` 增加 60 秒发送助手，并让现有命令也走它：

```typescript
const STORAGE_TIMEOUT_MS = 60_000;

async function sendCommand(client: S3CommandClient, command: { constructor: { name: string }; input: Record<string, unknown> }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STORAGE_TIMEOUT_MS);
  try {
    return await client.send(command, { abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function bytesOf(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body && typeof body === "object" && "transformToByteArray" in body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    const array = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(array);
  }
  throw Object.assign(new Error("hidden"), { name: "StorageError" });
}
```

把现有 `client.send(...)` 换成 `sendCommand(client, ...)`。新增：

```typescript
    async getObject(input) {
      try {
        const result = await sendCommand(client, new GetObjectCommand({ Bucket: bucket, Key: input.key }) as never);
        const body = await bytesOf(result.Body);
        return { body, byteSize: body.length };
      } catch (error) {
        if (named(error, "NotFound") || named(error, "NoSuchKey")) return null;
        throw error;
      }
    },
    async putObject(input) {
      await sendCommand(client, new PutObjectCommand({
        Bucket: bucket,
        Key: input.key,
        ContentType: input.contentType,
        Body: input.body,
      }) as never);
    },
```

从 `@aws-sdk/client-s3` 补上 `PutObjectCommand`。`GetObjectCommand` 已经导入。

假存储增加四个字段，默认 `putObjectCalls` 与 `getObjectCalls` 为 0，两个 `fail*` 为 false。实现：

```typescript
    async getObject(input) {
      storage.getObjectCalls += 1;
      if (storage.failGetObject) throw Object.assign(new Error("hidden"), { name: "InternalError" });
      const body = completed.get(input.key);
      if (!body) return null;
      return { body: Buffer.from(body), byteSize: body.length };
    },
    async putObject(input) {
      storage.putObjectCalls += 1;
      if (storage.failPutObject) throw Object.assign(new Error("hidden"), { name: "InternalError" });
      completed.set(input.key, Buffer.from(input.body));
    },
```

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
npx tsx --test --test-concurrency=1 apps/api/test/fake-storage.test.ts apps/api/test/s3-storage.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/domain/library/ports.ts apps/api/src/gateways/storage/fake-object-storage.ts apps/api/src/gateways/storage/s3-object-storage.ts apps/api/test/fake-storage.test.ts apps/api/test/s3-storage.test.ts
git commit -m "feat: 让对象存储能读取原图并覆盖写入缩略图"
```


---

### Task 5: EXIF 读数与缩略图编码

**Files:**
- Create: `apps/api/src/gateways/exif/parse.ts`
- Create: `apps/api/src/gateways/exif/exifr-reader.ts`
- Create: `apps/api/src/gateways/exif/fake-exif-reader.ts`
- Create: `apps/api/src/gateways/exif/index.ts`
- Create: `apps/api/src/gateways/thumbnail/sharp-encoder.ts`
- Create: `apps/api/src/gateways/thumbnail/fake-encoder.ts`
- Create: `apps/api/src/gateways/thumbnail/index.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/gateways/index.ts`
- Test: `apps/api/test/pipeline-exif-thumb.test.ts`

**Interfaces:**
- Consumes: `ExifReader.read(bytes) -> Promise<ExifReading>`，`ThumbnailEncoder.encode(bytes) -> Promise<{ bytes: Buffer; contentType: "image/jpeg" }>`，`ThumbnailEncodeError`
- Produces:
  - `parseExifTimestamp(raw: unknown, offsetRaw: unknown): Date | null`
  - `parseGpsPair(latitude: unknown, longitude: unknown): { latitude: number | null; longitude: number | null }`
  - `createExifrReader(): ExifReader`
  - `createFakeExifReader(reading?: ExifReading): ExifReader & { calls: number }`
  - `createSharpThumbnailEncoder(): ThumbnailEncoder`
  - `createFakeThumbnailEncoder(options?: { fail?: boolean; bytes?: Buffer }): ThumbnailEncoder & { calls: number }`

- [ ] **Step 1: 安装依赖并写会失败的测试**

Run:

```bash
npm install exifr sharp -w apps/api
```

Expected: `apps/api/package.json` 的 `dependencies` 出现 `exifr` 与 `sharp`，锁文件更新。不要手写猜出来的版本号；用这次安装写进锁文件的版本。

创建 `apps/api/test/pipeline-exif-thumb.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { ThumbnailEncodeError } from "../src/domain/library/pipeline.js";
import { createExifrReader } from "../src/gateways/exif/exifr-reader.js";
import { createFakeExifReader } from "../src/gateways/exif/fake-exif-reader.js";
import { parseExifTimestamp, parseGpsPair } from "../src/gateways/exif/parse.js";
import { createFakeThumbnailEncoder } from "../src/gateways/thumbnail/fake-encoder.js";
import { createSharpThumbnailEncoder } from "../src/gateways/thumbnail/sharp-encoder.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("无偏移的 EXIF 时间按 UTC，坏年份与坏坐标变成空", () => {
  assert.equal(parseExifTimestamp("2020:01:02 03:04:05", undefined)?.toISOString(), "2020-01-02T03:04:05.000Z");
  assert.equal(parseExifTimestamp("2020:01:02 03:04:05", "+08:00")?.toISOString(), "2020-01-01T19:04:05.000Z");
  assert.equal(parseExifTimestamp("1960:01:02 03:04:05", undefined), null);
  assert.equal(parseExifTimestamp("not-a-date", undefined), null);
  assert.deepEqual(parseGpsPair(1.25, -2.5), { latitude: 1.25, longitude: -2.5 });
  assert.deepEqual(parseGpsPair(91, 0), { latitude: null, longitude: null });
  assert.deepEqual(parseGpsPair(1, null), { latitude: null, longitude: null });
});

test("假 EXIF 返回注入值，坏字节的生产读数是三个空", async () => {
  const takenAt = new Date("2021-05-06T07:08:09.000Z");
  const fake = createFakeExifReader({ takenAt, latitude: 3, longitude: 4 });
  assert.deepEqual(await fake.read(Buffer.from("x")), { takenAt, latitude: 3, longitude: 4 });
  assert.equal(fake.calls, 1);
  const real = await createExifrReader().read(Buffer.from("not-an-image"));
  assert.deepEqual(real, { takenAt: null, latitude: null, longitude: null });
});

test("生产编码器输出 JPEG，假编码器可以抛出 ThumbnailEncodeError", async () => {
  const encoded = await createSharpThumbnailEncoder().encode(PNG);
  assert.equal(encoded.contentType, "image/jpeg");
  assert.ok(encoded.bytes.length > 1);
  assert.equal(encoded.bytes[0], 0xff);
  assert.equal(encoded.bytes[1], 0xd8);
  const fake = createFakeThumbnailEncoder();
  const thumb = await fake.encode(Buffer.from("x"));
  assert.equal(thumb.contentType, "image/jpeg");
  assert.ok(thumb.bytes.length > 0);
  assert.equal(fake.calls, 1);
  const failing = createFakeThumbnailEncoder({ fail: true });
  await assert.rejects(() => failing.encode(Buffer.from("x")), (error: unknown) => error instanceof ThumbnailEncodeError);
  await assert.rejects(() => createSharpThumbnailEncoder().encode(Buffer.from("nope")), (error: unknown) => error instanceof ThumbnailEncodeError);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-exif-thumb.test.ts
```

Expected: 退出码非 0。模块尚未创建。

- [ ] **Step 3: 写两个网关**

创建 `apps/api/src/gateways/exif/parse.ts`：

```typescript
export function parseExifTimestamp(raw: unknown, offsetRaw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  if (year < 1970 || year > 2100) return null;
  const offset = typeof offsetRaw === "string" && /^[+-]\d{2}:\d{2}$/.test(offsetRaw.trim()) ? offsetRaw.trim() : "Z";
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${offset}`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function parseGpsPair(latitude: unknown, longitude: unknown): { latitude: number | null; longitude: number | null } {
  if (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { latitude: null, longitude: null };
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { latitude: null, longitude: null };
  }
  return { latitude, longitude };
}
```

创建 `apps/api/src/gateways/exif/exifr-reader.ts`：

```typescript
import exifr from "exifr";
import type { ExifReader } from "../../domain/library/ports.js";
import { parseExifTimestamp, parseGpsPair } from "./parse.js";

export function createExifrReader(): ExifReader {
  return {
    async read(bytes) {
      try {
        const tags = (await exifr.parse(bytes, { reviveValues: false })) as Record<string, unknown> | undefined;
        const gps = (await exifr.gps(bytes)) as { latitude?: unknown; longitude?: unknown } | null;
        const takenAt = parseExifTimestamp(
          tags?.DateTimeOriginal ?? tags?.CreateDate,
          tags?.OffsetTimeOriginal ?? tags?.OffsetTime ?? tags?.OffsetTimeDigitized,
        );
        const pair = parseGpsPair(gps?.latitude, gps?.longitude);
        return { takenAt, latitude: pair.latitude, longitude: pair.longitude };
      } catch {
        return { takenAt: null, latitude: null, longitude: null };
      }
    },
  };
}
```

创建 `apps/api/src/gateways/exif/fake-exif-reader.ts`：

```typescript
import type { ExifReading } from "../../domain/library/pipeline.js";
import type { ExifReader } from "../../domain/library/ports.js";

export function createFakeExifReader(
  reading: ExifReading = { takenAt: null, latitude: null, longitude: null },
): ExifReader & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async read() {
      calls += 1;
      return {
        takenAt: reading.takenAt ? new Date(reading.takenAt.getTime()) : null,
        latitude: reading.latitude,
        longitude: reading.longitude,
      };
    },
  };
}
```

创建 `apps/api/src/gateways/exif/index.ts`：

```typescript
export { createExifrReader } from "./exifr-reader.js";
export { createFakeExifReader } from "./fake-exif-reader.js";
export { parseExifTimestamp, parseGpsPair } from "./parse.js";
```

创建 `apps/api/src/gateways/thumbnail/sharp-encoder.ts`：

```typescript
import sharp from "sharp";
import { ThumbnailEncodeError } from "../../domain/library/pipeline.js";
import type { ThumbnailEncoder } from "../../domain/library/ports.js";

export function createSharpThumbnailEncoder(): ThumbnailEncoder {
  return {
    async encode(bytes) {
      try {
        const encoded = await sharp(bytes, { failOn: "error" })
          .rotate()
          .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        return { bytes: encoded, contentType: "image/jpeg" };
      } catch (error) {
        if (error instanceof ThumbnailEncodeError) throw error;
        throw new ThumbnailEncodeError();
      }
    },
  };
}
```

创建 `apps/api/src/gateways/thumbnail/fake-encoder.ts`：

```typescript
import { ThumbnailEncodeError } from "../../domain/library/pipeline.js";
import type { ThumbnailEncoder } from "../../domain/library/ports.js";

export function createFakeThumbnailEncoder(options?: { fail?: boolean; bytes?: Buffer }): ThumbnailEncoder & { calls: number } {
  let calls = 0;
  const body = options?.bytes ?? Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  return {
    get calls() {
      return calls;
    },
    async encode() {
      calls += 1;
      if (options?.fail) throw new ThumbnailEncodeError();
      return { bytes: Buffer.from(body), contentType: "image/jpeg" };
    },
  };
}
```

创建 `apps/api/src/gateways/thumbnail/index.ts`：

```typescript
export { createFakeThumbnailEncoder } from "./fake-encoder.js";
export { createSharpThumbnailEncoder } from "./sharp-encoder.js";
```

`apps/api/src/gateways/index.ts` 再导出这些工厂。不要从领域层引用这两个目录。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-exif-thumb.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/api/package.json package-lock.json apps/api/src/gateways/exif apps/api/src/gateways/thumbnail apps/api/src/gateways/index.ts apps/api/test/pipeline-exif-thumb.test.ts
git commit -m "feat: 增加 EXIF 与缩略图网关"
```

---

### Task 6: 视觉、嵌入与流水线配置

**Files:**
- Create: `apps/api/src/gateways/vision/http-vision.ts`
- Create: `apps/api/src/gateways/vision/fake-vision.ts`
- Modify: `apps/api/src/gateways/vision/index.ts`
- Create: `apps/api/src/gateways/embed/config.ts`
- Create: `apps/api/src/gateways/embed/deterministic.ts`
- Create: `apps/api/src/gateways/embed/http-embed.ts`
- Create: `apps/api/src/gateways/embed/fake-embed.ts`
- Modify: `apps/api/src/gateways/embed/index.ts`
- Modify: `apps/api/src/gateways/storage/config.ts`
- Modify: `apps/api/src/gateways/index.ts`
- Test: `apps/api/test/pipeline-config.test.ts`

**Interfaces:**
- Consumes: `VisionGateway`、`EmbedGateway`
- Produces:
  - `EMBED_VECTOR_DIMENSIONS = 1536`
  - `loadPipelineConfig(env): { ok: true; config: PipelineConfig } | { ok: false; exitCode: 1; message: string }`
  - `PipelineConfig` 含 `pollMs`、`concurrency`，以及 `vision` / `embed` 的 `{ kind: "http"; baseUrl: string; apiKey: string; model: string; timeoutMs: number }` 或 `{ kind: "fake"; model: string }`。`embed` 两种都带 `dimensions: 1536`
  - `createHttpVisionGateway(config, fetchImpl?)`
  - `createFakeVisionGateway(options?)`，`options` 为 `{ description?: string | null; tags?: string[]; failuresBeforeSuccess?: number; reject?: boolean; throwOnCall?: Error }`
  - `createHttpEmbedGateway(config, fetchImpl?)`
  - `createFakeEmbedGateway(options?)`，`options` 为 `{ dimensions?: number; failuresBeforeSuccess?: number; reject?: boolean; nan?: boolean; values?: number[] }`
  - `deterministicEmbedding(text: string, dimensions: number): number[]`
  - `productionStoragePlaceholderMessage(env): string | null`

- [ ] **Step 1: 写会失败的配置与 HTTP 分类测试**

创建 `apps/api/test/pipeline-config.test.ts`。文件不连接数据库：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { EMBED_VECTOR_DIMENSIONS, loadPipelineConfig } from "../src/gateways/embed/config.js";
import { createFakeEmbedGateway } from "../src/gateways/embed/fake-embed.js";
import { createHttpEmbedGateway } from "../src/gateways/embed/http-embed.js";
import { createHttpVisionGateway } from "../src/gateways/vision/http-vision.js";
import { productionStoragePlaceholderMessage } from "../src/gateways/storage/config.js";

function pipelineEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PIPELINE_POLL_MS: "",
    PIPELINE_CONCURRENCY: "",
    VISION_PROVIDER: "http",
    VISION_API_BASE_URL: "https://vision.example.com",
    VISION_API_KEY: "real-vision",
    VISION_MODEL: "vision-model",
    VISION_TIMEOUT_MS: "",
    EMBED_PROVIDER: "http",
    EMBED_API_BASE_URL: "https://embed.example.com",
    EMBED_API_KEY: "real-embed",
    EMBED_MODEL: "embed-model",
    EMBED_TIMEOUT_MS: "",
    EMBED_DIMENSIONS: "1536",
    ...overrides,
  };
}

test("1536 与空白轮询通过，错误维度和过短轮询拒绝", () => {
  assert.equal(EMBED_VECTOR_DIMENSIONS, 1536);
  const ok = loadPipelineConfig(pipelineEnv());
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.config.pollMs, 2000);
  assert.equal(ok.config.concurrency, 2);
  assert.equal(ok.config.vision.kind, "http");
  assert.equal(ok.config.embed.dimensions, 1536);
  if (ok.config.vision.kind === "http") assert.equal(ok.config.vision.timeoutMs, 60_000);
  if (ok.config.embed.kind === "http") assert.equal(ok.config.embed.timeoutMs, 30_000);
  assert.equal(loadPipelineConfig(pipelineEnv({ EMBED_DIMENSIONS: "" })).ok && false, false);
  assert.equal((loadPipelineConfig(pipelineEnv({ EMBED_DIMENSIONS: "" })) as { message?: string }).message, "EMBED_DIMENSIONS 缺失");
  assert.equal((loadPipelineConfig(pipelineEnv({ EMBED_DIMENSIONS: "abc" })) as { message?: string }).message, "EMBED_DIMENSIONS 无效");
  assert.equal((loadPipelineConfig(pipelineEnv({ EMBED_DIMENSIONS: "768" })) as { message?: string }).message, "EMBED_DIMENSIONS 与向量列不一致");
  assert.equal((loadPipelineConfig(pipelineEnv({ PIPELINE_POLL_MS: "50" })) as { message?: string }).message, "PIPELINE_POLL_MS 无效");
});

test("非 production 的视觉占位符用假网关，production 退出且文案不含密钥", () => {
  const fake = loadPipelineConfig(pipelineEnv({ VISION_API_KEY: "YOUR_VISION_API_KEY" }));
  assert.equal(fake.ok, true);
  if (fake.ok) assert.equal(fake.config.vision.kind, "fake");
  const prod = loadPipelineConfig(pipelineEnv({ NODE_ENV: "production", VISION_API_KEY: "YOUR_VISION_API_KEY" }));
  assert.equal(prod.ok, false);
  if (!prod.ok) {
    assert.equal(prod.message, "视觉配置仍是占位符");
    assert.equal(prod.exitCode, 1);
    assert.equal(prod.message.includes("YOUR_VISION_API_KEY"), false);
  }
  const userinfo = loadPipelineConfig(pipelineEnv({ VISION_API_BASE_URL: "https://user:pass@vision.example.com" }));
  assert.equal(userinfo.ok, false);
  if (!userinfo.ok) {
    assert.equal(userinfo.message, "VISION_API_BASE_URL 无效");
    assert.equal(userinfo.message.includes("user"), false);
    assert.equal(userinfo.message.includes("pass"), false);
  }
});

test("生产环境的对象存储占位符文案不含密钥", () => {
  assert.equal(
    productionStoragePlaceholderMessage({ NODE_ENV: "production", S3_BUCKET: "album", S3_ACCESS_KEY_ID: "YOUR_ACCESS_KEY", S3_SECRET_ACCESS_KEY: "secret" }),
    "对象存储配置仍是占位符",
  );
  const message = productionStoragePlaceholderMessage({ NODE_ENV: "production", S3_ACCESS_KEY_ID: "YOUR_ACCESS_KEY" });
  assert.equal(message?.includes("YOUR_ACCESS_KEY"), false);
  assert.equal(productionStoragePlaceholderMessage({ NODE_ENV: "test", S3_ACCESS_KEY_ID: "YOUR_ACCESS_KEY" }), null);
});

test("视觉与嵌入 HTTP 按状态码分类，假嵌入按文本稳定", async () => {
  const calls: Array<{ url: string; redirect: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), redirect: String(init?.redirect) });
    const url = String(input);
    if (url.endsWith("/missing")) return new Response("{}", { status: 200 });
    if (url.includes("/v1/describe")) {
      const status = calls.filter((item) => item.url.includes("/v1/describe")).length;
      if (status === 1) return new Response("{}", { status: 429 });
      if (status === 2) return new Response("{}", { status: 400 });
      if (status === 3) return new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } });
      if (status === 4) return new Response(JSON.stringify({ tags: [1] }), { status: 200 });
      return new Response(JSON.stringify({ description: "海边", tags: ["海"] }), { status: 200 });
    }
    return new Response(JSON.stringify({ embedding: [0.25, -0.5] }), { status: 200 });
  };
  const vision = createHttpVisionGateway(
    { baseUrl: "https://vision.example.com", apiKey: "real-vision", model: "vision-model", timeoutMs: 1000 },
    fetchImpl,
  );
  assert.deepEqual(await vision.describe({ model: "vision-model", contentType: "image/jpeg", bytes: Buffer.from("a") }), { ok: false, kind: "vision_unavailable" });
  assert.deepEqual(await vision.describe({ model: "vision-model", contentType: "image/jpeg", bytes: Buffer.from("a") }), { ok: false, kind: "vision_rejected" });
  assert.deepEqual(await vision.describe({ model: "vision-model", contentType: "image/jpeg", bytes: Buffer.from("a") }), { ok: false, kind: "vision_rejected" });
  assert.deepEqual(await vision.describe({ model: "vision-model", contentType: "image/jpeg", bytes: Buffer.from("a") }), { ok: false, kind: "vision_rejected" });
  assert.deepEqual(await vision.describe({ model: "vision-model", contentType: "image/jpeg", bytes: Buffer.from("a") }), { ok: true, description: "海边", tags: ["海"] });
  assert.equal(calls[0]?.redirect, "manual");
  assert.equal(calls[0]?.url.endsWith("/v1/describe"), true);
  const embed = createHttpEmbedGateway(
    { baseUrl: "https://embed.example.com", apiKey: "real-embed", model: "embed-model", timeoutMs: 1000 },
    fetchImpl,
  );
  assert.deepEqual(await embed.embed({ model: "embed-model", text: "海边" }), { ok: true, values: [0.25, -0.5] });
  const missing = createHttpEmbedGateway(
    { baseUrl: "https://embed.example.com/missing", apiKey: "real-embed", model: "embed-model", timeoutMs: 1000 },
    async () => new Response(JSON.stringify({}), { status: 200 }),
  );
  assert.deepEqual(await missing.embed({ model: "embed-model", text: "海边" }), { ok: false, kind: "embed_rejected" });
  const fake = createFakeEmbedGateway();
  const left = await fake.embed({ model: "embed-model", text: "海边" });
  const same = await fake.embed({ model: "embed-model", text: "海边" });
  const other = await fake.embed({ model: "embed-model", text: "湖边" });
  assert.equal(left.ok && same.ok && other.ok, true);
  if (left.ok && same.ok && other.ok) {
    assert.equal(left.values.length, 1536);
    assert.deepEqual(left.values, same.values);
    assert.notDeepEqual(left.values, other.values);
  }
  const nan = await createFakeEmbedGateway({ nan: true }).embed({ model: "embed-model", text: "海边" });
  assert.equal(nan.ok, true);
  if (nan.ok) {
    assert.equal(nan.values.length, 1536);
    assert.equal(Number.isNaN(nan.values[0]), true);
  }
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-config.test.ts
```

Expected: 退出码非 0。`loadPipelineConfig` 未定义。

- [ ] **Step 3: 写配置与两个 HTTP 网关**

创建 `apps/api/src/gateways/embed/config.ts`。`1536` 只在这个文件的常量 `EMBED_VECTOR_DIMENSIONS` 出现，并在常量上方用注释写明它必须与 `schema.sql` 的 `vector(1536)` 相同。

```typescript
export const EMBED_VECTOR_DIMENSIONS = 1536;

const VISION_BASE_PLACEHOLDER = "https://YOUR_VISION_API_BASE";
const VISION_KEY_PLACEHOLDER = "YOUR_VISION_API_KEY";
const VISION_MODEL_PLACEHOLDER = "YOUR_VISION_MODEL";
const EMBED_BASE_PLACEHOLDER = "https://YOUR_EMBED_API_BASE";
const EMBED_KEY_PLACEHOLDER = "YOUR_EMBED_API_KEY";
const EMBED_MODEL_PLACEHOLDER = "YOUR_EMBED_MODEL";

export type HttpSide = { kind: "http"; baseUrl: string; apiKey: string; model: string; timeoutMs: number };
export type FakeSide = { kind: "fake"; model: string };
export type PipelineConfig = {
  pollMs: number;
  concurrency: number;
  vision: HttpSide | FakeSide;
  embed: (HttpSide | FakeSide) & { dimensions: 1536 };
};

export type PipelineConfigResult =
  | { ok: true; config: PipelineConfig }
  | { ok: false; exitCode: 1; message: string };

export function loadPipelineConfig(env: NodeJS.ProcessEnv): PipelineConfigResult {
  const pollMs = parseRange(env.PIPELINE_POLL_MS, 2000, 200, 60_000, "PIPELINE_POLL_MS 无效");
  if (typeof pollMs !== "number") return fail(pollMs);
  const concurrency = parseRange(env.PIPELINE_CONCURRENCY, 2, 1, 8, "PIPELINE_CONCURRENCY 无效");
  if (typeof concurrency !== "number") return fail(concurrency);
  const dimensions = parseDimensions(env.EMBED_DIMENSIONS);
  if (typeof dimensions !== "number") return fail(dimensions);
  const vision = parseSide(env, "VISION", {
    basePlaceholder: VISION_BASE_PLACEHOLDER,
    keyPlaceholder: VISION_KEY_PLACEHOLDER,
    modelPlaceholder: VISION_MODEL_PLACEHOLDER,
    timeoutEmpty: 60_000,
    providerInvalid: "VISION_PROVIDER 无效",
    baseInvalid: "VISION_API_BASE_URL 无效",
    modelInvalid: "VISION_MODEL 无效",
    timeoutInvalid: "VISION_TIMEOUT_MS 无效",
    placeholder: "视觉配置仍是占位符",
  });
  if ("ok" in vision) return vision;
  const embed = parseSide(env, "EMBED", {
    basePlaceholder: EMBED_BASE_PLACEHOLDER,
    keyPlaceholder: EMBED_KEY_PLACEHOLDER,
    modelPlaceholder: EMBED_MODEL_PLACEHOLDER,
    timeoutEmpty: 30_000,
    providerInvalid: "EMBED_PROVIDER 无效",
    baseInvalid: "EMBED_API_BASE_URL 无效",
    modelInvalid: "EMBED_MODEL 无效",
    timeoutInvalid: "EMBED_TIMEOUT_MS 无效",
    placeholder: "嵌入配置仍是占位符",
  });
  if ("ok" in embed) return embed;
  return {
    ok: true,
    config: {
      pollMs,
      concurrency,
      vision,
      embed: { ...embed, dimensions: EMBED_VECTOR_DIMENSIONS },
    },
  };
}

function fail(message: string): PipelineConfigResult {
  return { ok: false, exitCode: 1, message };
}

function parseRange(value: string | undefined, empty: number, min: number, max: number, invalid: string): number | string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return empty;
  if (!/^[0-9]+$/.test(trimmed)) return invalid;
  const number = Number(trimmed);
  if (!Number.isInteger(number) || number < min || number > max) return invalid;
  return number;
}

function parseDimensions(value: string | undefined): number | string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "EMBED_DIMENSIONS 缺失";
  if (!/^[0-9]+$/.test(trimmed)) return "EMBED_DIMENSIONS 无效";
  if (Number(trimmed) !== EMBED_VECTOR_DIMENSIONS) return "EMBED_DIMENSIONS 与向量列不一致";
  return EMBED_VECTOR_DIMENSIONS;
}

function parseSide(
  env: NodeJS.ProcessEnv,
  prefix: "VISION" | "EMBED",
  copy: {
    basePlaceholder: string;
    keyPlaceholder: string;
    modelPlaceholder: string;
    timeoutEmpty: number;
    providerInvalid: string;
    baseInvalid: string;
    modelInvalid: string;
    timeoutInvalid: string;
    placeholder: string;
  },
): HttpSide | FakeSide | PipelineConfigResult {
  const provider = env[`${prefix}_PROVIDER`]?.trim() ?? "";
  if (provider !== "" && provider !== "http") return fail(copy.providerInvalid);
  const baseUrl = stripTrailingSlashes(env[`${prefix}_API_BASE_URL`]?.trim() ?? "");
  if (baseUrl !== "" && !validHttpUrl(baseUrl)) return fail(copy.baseInvalid);
  const apiKey = env[`${prefix}_API_KEY`]?.trim() ?? "";
  const model = env[`${prefix}_MODEL`]?.trim() ?? "";
  if (model.length > 200) return fail(copy.modelInvalid);
  const timeout = parseRange(env[`${prefix}_TIMEOUT_MS`], copy.timeoutEmpty, 1000, 120_000, copy.timeoutInvalid);
  if (typeof timeout !== "number") return fail(timeout);
  const placeholder = baseUrl === "" || baseUrl === copy.basePlaceholder || apiKey === "" || apiKey === copy.keyPlaceholder || model === "" || model === copy.modelPlaceholder;
  if (placeholder) {
    if ((env.NODE_ENV?.trim() ?? "") === "production") return fail(copy.placeholder);
    return { kind: "fake", model: model === "" ? "fake" : model };
  }
  return { kind: "http", baseUrl, apiKey, model, timeoutMs: timeout };
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
```

`productionStoragePlaceholderMessage` 加到 `apps/api/src/gateways/storage/config.ts` 并导出：

```typescript
export function productionStoragePlaceholderMessage(env: NodeJS.ProcessEnv): string | null {
  if ((env.NODE_ENV?.trim() ?? "") !== "production") return null;
  const bucket = env.S3_BUCKET?.trim() ?? "";
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim() ?? "";
  if (bucket === "YOUR_BUCKET_NAME" || accessKeyId === "YOUR_ACCESS_KEY" || secretAccessKey === "YOUR_SECRET_KEY") {
    return "对象存储配置仍是占位符";
  }
  return null;
}
```

创建 `apps/api/src/gateways/embed/deterministic.ts`：

```typescript
import { createHash } from "node:crypto";

export function deterministicEmbedding(text: string, dimensions: number): number[] {
  const values: number[] = [];
  let counter = 0;
  while (values.length < dimensions) {
    const digest = createHash("sha256").update(`${text}\0${counter}`).digest();
    for (let index = 0; index + 3 < digest.length && values.length < dimensions; index += 4) {
      const unit = digest.readUInt32BE(index) / 0xffffffff;
      values.push(Math.round((unit * 2 - 1) * 1_000_000) / 1_000_000);
    }
    counter += 1;
  }
  return values;
}
```

创建 `apps/api/src/gateways/vision/http-vision.ts`：

```typescript
import type { VisionGateway } from "../../domain/library/ports.js";

export type VisionHttpConfig = { baseUrl: string; apiKey: string; model: string; timeoutMs: number };

export function createHttpVisionGateway(config: VisionHttpConfig, fetchImpl: typeof fetch = fetch): VisionGateway {
  return {
    async describe(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(`${config.baseUrl}/v1/describe`, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            image: { contentType: input.contentType, dataBase64: input.bytes.toString("base64") },
          }),
        });
        return await classifyVision(response);
      } catch {
        return { ok: false, kind: "vision_unavailable" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function classifyVision(response: Response): Promise<Awaited<ReturnType<VisionGateway["describe"]>>> {
  if (response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504) {
    return { ok: false, kind: "vision_unavailable" };
  }
  if (response.status !== 200) return { ok: false, kind: "vision_rejected" };
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, kind: "vision_rejected" };
  }
  if (typeof json !== "object" || json === null) return { ok: false, kind: "vision_rejected" };
  const record = json as { description?: unknown; tags?: unknown };
  const description = record.description === undefined ? null : record.description;
  const tags = record.tags === undefined ? [] : record.tags;
  if (description !== null && typeof description !== "string") return { ok: false, kind: "vision_rejected" };
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) return { ok: false, kind: "vision_rejected" };
  return { ok: true, description, tags };
}
```

创建 `apps/api/src/gateways/vision/fake-vision.ts`：

```typescript
import type { VisionGateway } from "../../domain/library/ports.js";

export type FakeVisionOptions = {
  description?: string | null;
  tags?: string[];
  failuresBeforeSuccess?: number;
  reject?: boolean;
  throwOnCall?: Error;
};

export function createFakeVisionGateway(options: FakeVisionOptions = {}): VisionGateway & { calls: number } {
  let calls = 0;
  const failures = options.failuresBeforeSuccess ?? 0;
  return {
    get calls() {
      return calls;
    },
    async describe() {
      calls += 1;
      if (options.throwOnCall && calls <= Math.max(failures, 1)) throw options.throwOnCall;
      if (calls <= failures) return { ok: false, kind: "vision_unavailable" };
      if (options.reject) return { ok: false, kind: "vision_rejected" };
      return { ok: true, description: options.description ?? "海边", tags: options.tags ?? ["海"] };
    },
  };
}
```

把 `apps/api/src/gateways/vision/index.ts` 换成：

```typescript
/** 视觉网关占位（Phase 3 调用外部描述 / 标签 API）。 */
export const VISION_GATEWAY = "vision" as const;

export { createFakeVisionGateway } from "./fake-vision.js";
export type { FakeVisionOptions } from "./fake-vision.js";
export { createHttpVisionGateway } from "./http-vision.js";
export type { VisionHttpConfig } from "./http-vision.js";
```

创建 `apps/api/src/gateways/embed/http-embed.ts`：

```typescript
import type { EmbedGateway } from "../../domain/library/ports.js";

export type EmbedHttpConfig = { baseUrl: string; apiKey: string; model: string; timeoutMs: number };

export function createHttpEmbedGateway(config: EmbedHttpConfig, fetchImpl: typeof fetch = fetch): EmbedGateway {
  return {
    async embed(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(`${config.baseUrl}/v1/embeddings`, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ model: config.model, input: input.text }),
        });
        return await classifyEmbed(response);
      } catch {
        return { ok: false, kind: "embed_unavailable" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function classifyEmbed(response: Response): Promise<Awaited<ReturnType<EmbedGateway["embed"]>>> {
  if (response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504) {
    return { ok: false, kind: "embed_unavailable" };
  }
  if (response.status !== 200) return { ok: false, kind: "embed_rejected" };
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, kind: "embed_rejected" };
  }
  if (typeof json !== "object" || json === null) return { ok: false, kind: "embed_rejected" };
  const embedding = (json as { embedding?: unknown }).embedding;
  if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) {
    return { ok: false, kind: "embed_rejected" };
  }
  return { ok: true, values: embedding };
}
```

`NaN` 与 `Infinity` 的 `typeof` 也是 `number`，原样放进 `values`。不要在这个文件改写成拒绝。

创建 `apps/api/src/gateways/embed/fake-embed.ts`：

```typescript
import type { EmbedGateway } from "../../domain/library/ports.js";
import { deterministicEmbedding } from "./deterministic.js";

export type FakeEmbedOptions = {
  dimensions?: number;
  failuresBeforeSuccess?: number;
  reject?: boolean;
  nan?: boolean;
  values?: number[];
};

export function createFakeEmbedGateway(options: FakeEmbedOptions = {}): EmbedGateway & { calls: number } {
  let calls = 0;
  const dimensions = options.dimensions ?? 1536;
  const failures = options.failuresBeforeSuccess ?? 0;
  return {
    get calls() {
      return calls;
    },
    async embed(input) {
      calls += 1;
      if (calls <= failures) return { ok: false, kind: "embed_unavailable" };
      if (options.reject) return { ok: false, kind: "embed_rejected" };
      if (options.values) return { ok: true, values: options.values.slice() };
      const values = deterministicEmbedding(input.text, dimensions);
      if (options.nan) values[0] = Number.NaN;
      return { ok: true, values };
    },
  };
}
```

把 `apps/api/src/gateways/embed/index.ts` 换成：

```typescript
/** 嵌入网关占位（Phase 3 调用外部向量 API）。 */
export const EMBED_GATEWAY = "embed" as const;

export { loadPipelineConfig, EMBED_VECTOR_DIMENSIONS } from "./config.js";
export type { PipelineConfig, PipelineConfigResult } from "./config.js";
export { deterministicEmbedding } from "./deterministic.js";
export { createFakeEmbedGateway } from "./fake-embed.js";
export type { FakeEmbedOptions } from "./fake-embed.js";
export { createHttpEmbedGateway } from "./http-embed.js";
export type { EmbedHttpConfig } from "./http-embed.js";
```

在 `apps/api/src/gateways/index.ts` 已有的 `VISION_GATEWAY` 与 `EMBED_GATEWAY` 导出后面追加：

```typescript
export { createFakeVisionGateway, createHttpVisionGateway } from "./vision/index.js";
export { createFakeEmbedGateway, createHttpEmbedGateway, loadPipelineConfig, EMBED_VECTOR_DIMENSIONS } from "./embed/index.js";
export { productionStoragePlaceholderMessage } from "./storage/config.js";
export { createFakeExifReader, createExifrReader } from "./exif/index.js";
export { createFakeThumbnailEncoder, createSharpThumbnailEncoder } from "./thumbnail/index.js";
```

这四行依赖 Task 5 已经导出的 EXIF 与缩略图工厂。不要删除文件里已有的导出。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-config.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gateways/vision apps/api/src/gateways/embed apps/api/src/gateways/storage/config.ts apps/api/src/gateways/index.ts apps/api/test/pipeline-config.test.ts
git commit -m "feat: 增加视觉嵌入网关与流水线配置"
```

---

### Task 7: runOnce 编排

**Files:**
- Create: `apps/api/src/adapters/pipeline/deps.ts`
- Create: `apps/api/src/adapters/pipeline/failure-message.ts`
- Create: `apps/api/src/adapters/pipeline/run-once.ts`
- Modify: `apps/api/src/adapters/index.ts`
- Test: `apps/api/test/pipeline-run.test.ts`

**Interfaces:**
- Consumes: `PipelineStore`、`ObjectStorage.getObject` / `putObject` / `headObject` / `deleteObject`、四个假网关、`exifFill`、`embeddingInput`、`checkEmbedding`、`failureDisposition`、`shouldCallVision`、`visionWrite`、`normalizeVisionDescription`、`normalizeVisionTags`、`thumbObjectKey`、`pipelineFailureMessage`
- Produces:
  - `PipelineDeps`，字段为 `store`、`storage`、`exif`、`thumbnail`、`vision`、`embed`、`log`、`visionModel: string`、`embedModel: string`、`embedDimensions: number`
  - `WorkerControl = { stopped: boolean; inflight: Map<string, Date> }`
  - `runOnce(deps: PipelineDeps, now: Date, limit: number, control?: WorkerControl): Promise<void>`
  - `pipelineFailureMessage(code: PipelineErrorCode): string`

- [ ] **Step 1: 写会失败的一次领取测试**

创建 `apps/api/test/pipeline-run.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { runOnce } from "../src/adapters/pipeline/run-once.js";
import type { PipelineDeps } from "../src/adapters/pipeline/deps.js";
import type { PipelineLogFields } from "../src/domain/library/ports.js";
import { createPipelineStore } from "../src/dao/pipeline-store.js";
import { createUserRepository } from "../src/dao/user-repository.js";
import { createFakeEmbedGateway } from "../src/gateways/embed/fake-embed.js";
import { createFakeExifReader } from "../src/gateways/exif/fake-exif-reader.js";
import { createFakeObjectStorage } from "../src/gateways/storage/fake-object-storage.js";
import { createFakeThumbnailEncoder } from "../src/gateways/thumbnail/fake-encoder.js";
import { createFakeVisionGateway } from "../src/gateways/vision/fake-vision.js";
import type { User } from "../src/domain/identity/model.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";

const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
const now = new Date("2030-06-01T00:00:00.000Z");
const ownerId = "11111111-1111-4111-8111-111111111111";
const photoId = "33333333-3333-4333-8333-333333333333";
const jobId = "55555555-5555-4555-8555-555555555555";

let tail: Promise<unknown> = Promise.resolve();
function serial(name: string, fn: () => Promise<void>): void {
  test(name, () => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  });
}

test.before(async () => {
  await applySchema(pool);
});

test.after(async () => {
  await pool.end();
});

async function reset(): Promise<void> {
  await pool.query("TRUNCATE TABLE users CASCADE");
  const users = createUserRepository(pool);
  const user: User = { id: ownerId, email: "run@example.com", passwordHash: "hash", createdAt: now };
  assert.equal(await users.insert(user), "ok");
}

async function insertPhoto(input: {
  id: string;
  description?: string | null;
  tags?: string[];
  takenAt?: Date | null;
  latitude?: number | null;
  longitude?: number | null;
  locationText?: string | null;
  status?: string;
  errorMessage?: string | null;
  thumbKey?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO photos (
       id, owner_id, object_key, thumb_key, content_type, byte_size, taken_at, location_text,
       latitude, longitude, description, tags, status, error_message, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'image/jpeg', 4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13
     )`,
    [
      input.id,
      ownerId,
      `owners/${ownerId}/photos/${input.id}/original`,
      input.thumbKey ?? null,
      input.takenAt ?? null,
      input.locationText ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
      input.description ?? null,
      input.tags ?? [],
      input.status ?? "processing",
      input.errorMessage ?? null,
      now,
    ],
  );
}

async function insertJob(input: {
  id: string;
  photoId: string;
  runAfter?: Date;
  status?: string;
  attempts?: number;
  lastError?: string | null;
  lockedAt?: Date | null;
  step?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO jobs (
       id, type, photo_id, payload, status, attempts, last_error, run_after, locked_at, created_at, updated_at
     ) VALUES ($1, 'process_photo', $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $9)`,
    [
      input.id,
      input.photoId,
      JSON.stringify({ step: input.step ?? "exif" }),
      input.status ?? "pending",
      input.attempts ?? 0,
      input.lastError ?? null,
      input.runAfter ?? now,
      input.lockedAt ?? null,
      now,
    ],
  );
}

function harness(options?: {
  vision?: ReturnType<typeof createFakeVisionGateway>;
  embed?: ReturnType<typeof createFakeEmbedGateway>;
  thumbnail?: ReturnType<typeof createFakeThumbnailEncoder>;
  exif?: ReturnType<typeof createFakeExifReader>;
}) {
  const storage = createFakeObjectStorage();
  const logs: Array<{ message: string; fields: PipelineLogFields }> = [];
  const vision = options?.vision ?? createFakeVisionGateway({ description: "海边", tags: ["海", "黄昏"] });
  const embed = options?.embed ?? createFakeEmbedGateway({ dimensions: 1536 });
  const thumbnail = options?.thumbnail ?? createFakeThumbnailEncoder();
  const exif = options?.exif ?? createFakeExifReader({ takenAt: new Date("2020-01-02T03:04:05.000Z"), latitude: 1.5, longitude: 2.5 });
  const deps: PipelineDeps = {
    store: createPipelineStore(pool),
    storage,
    exif,
    thumbnail,
    vision,
    embed,
    visionModel: "vision-test",
    embedModel: "embed-test",
    embedDimensions: 1536,
    log: {
      info(message, fields) {
        logs.push({ message, fields });
      },
      warn(message, fields) {
        logs.push({ message, fields });
      },
    },
  };
  return { deps, storage, logs, vision, embed, thumbnail };
}

serial("假网关把照片做成 ready", async () => {
  await reset();
  await insertPhoto({ id: photoId });
  await insertJob({ id: jobId, photoId });
  const { deps, storage } = harness();
  await deps.storage.putObject({ key: `owners/${ownerId}/photos/${photoId}/original`, contentType: "image/jpeg", body: Buffer.from("orig") });
  storage.putObjectCalls = 0;
  await runOnce(deps, now, 2);
  const photo = await pool.query(`SELECT status, error_message, thumb_key, taken_at, latitude, longitude, description, tags FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].status, "ready");
  assert.equal(photo.rows[0].error_message, null);
  assert.equal(photo.rows[0].thumb_key, `owners/${ownerId}/photos/${photoId}/thumb`);
  assert.equal(photo.rows[0].description, "海边");
  assert.deepEqual(photo.rows[0].tags, ["海", "黄昏"]);
  const thumb = await storage.getObject({ key: photo.rows[0].thumb_key });
  assert.ok((thumb?.byteSize ?? 0) >= 1);
  const embedding = await pool.query(`SELECT model, vector_dims(embedding) AS dims FROM photo_embeddings WHERE photo_id = $1`, [photoId]);
  assert.equal(embedding.rows[0].model, "embed-test");
  assert.equal(embedding.rows[0].dims, 1536);
});

serial("已有拍摄时间和坐标不被 EXIF 覆盖", async () => {
  await reset();
  const taken = new Date("2019-01-01T00:00:00.000Z");
  await insertPhoto({ id: photoId, takenAt: taken, latitude: 9, longitude: 8, locationText: "用户地点" });
  await insertJob({ id: jobId, photoId });
  const { deps } = harness();
  await deps.storage.putObject({ key: `owners/${ownerId}/photos/${photoId}/original`, contentType: "image/jpeg", body: Buffer.from("orig") });
  await runOnce(deps, now, 2);
  const photo = await pool.query(`SELECT taken_at, latitude, longitude, location_text FROM photos WHERE id = $1`, [photoId]);
  assert.equal(new Date(photo.rows[0].taken_at).toISOString(), taken.toISOString());
  assert.equal(Number(photo.rows[0].latitude), 9);
  assert.equal(Number(photo.rows[0].longitude), 8);
  assert.equal(photo.rows[0].location_text, "用户地点");
});

serial("已有描述和标签时不调用视觉", async () => {
  await reset();
  await insertPhoto({ id: photoId, description: "用户", tags: ["自己的"] });
  await insertJob({ id: jobId, photoId });
  const vision = createFakeVisionGateway({ description: "模型", tags: ["模型"] });
  const { deps } = harness({ vision });
  await deps.storage.putObject({ key: `owners/${ownerId}/photos/${photoId}/original`, contentType: "image/jpeg", body: Buffer.from("orig") });
  await runOnce(deps, now, 2);
  assert.equal(vision.calls, 0);
  const photo = await pool.query(`SELECT description, tags FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].description, "用户");
  assert.deepEqual(photo.rows[0].tags, ["自己的"]);
});

serial("视觉两次不可用后第三次成功，退避不睡眠", async () => {
  await reset();
  await insertPhoto({ id: photoId });
  await insertJob({ id: jobId, photoId });
  const vision = createFakeVisionGateway({ failuresBeforeSuccess: 2, description: "海边", tags: ["海"] });
  const { deps } = harness({ vision });
  await deps.storage.putObject({ key: `owners/${ownerId}/photos/${photoId}/original`, contentType: "image/jpeg", body: Buffer.from("orig") });
  await runOnce(deps, now, 2);
  const first = await pool.query(`SELECT status, attempts, run_after FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(first.rows[0].status, "pending");
  assert.equal(first.rows[0].attempts, 1);
  assert.equal(new Date(first.rows[0].run_after).toISOString(), new Date(now.getTime() + 30_000).toISOString());
  const processing = await pool.query(`SELECT status, error_message FROM photos WHERE id = $1`, [photoId]);
  assert.equal(processing.rows[0].status, "processing");
  assert.equal(processing.rows[0].error_message, "vision_unavailable");
  const secondNow = new Date(now.getTime() + 30_000);
  await runOnce(deps, secondNow, 2);
  const second = await pool.query(`SELECT status, attempts FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(second.rows[0].attempts, 2);
  assert.notEqual(second.rows[0].status, "done");
  await runOnce(deps, new Date(secondNow.getTime() + 60_000), 2);
  const photo = await pool.query(`SELECT status FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].status, "ready");
});

serial("错误维度与 NaN 不写向量", async () => {
  await reset();
  await insertPhoto({ id: photoId });
  await insertJob({ id: jobId, photoId });
  const embed = createFakeEmbedGateway({ values: [1, 2, 3] });
  const { deps, storage } = harness({ embed });
  const key = `owners/${ownerId}/photos/${photoId}/original`;
  await storage.putObject({ key, contentType: "image/jpeg", body: Buffer.from("orig") });
  await runOnce(deps, now, 2);
  const rows = await pool.query(`SELECT count(*)::int AS n FROM photo_embeddings WHERE photo_id = $1`, [photoId]);
  assert.equal(rows.rows[0].n, 0);
  const job = await pool.query(`SELECT status, last_error FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(job.rows[0].status, "failed");
  assert.equal(job.rows[0].last_error, "dimension_mismatch");
  const photo = await pool.query(`SELECT status, error_message FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].status, "failed");
  assert.equal(photo.rows[0].error_message, "dimension_mismatch");
  assert.equal((await storage.getObject({ key }))?.body.toString(), "orig");

  await reset();
  await insertPhoto({ id: photoId });
  await insertJob({ id: jobId, photoId });
  const nan = createFakeEmbedGateway({ nan: true });
  const again = harness({ embed: nan });
  await again.storage.putObject({ key, contentType: "image/jpeg", body: Buffer.from("orig") });
  await runOnce(again.deps, now, 2);
  const nanJob = await pool.query(`SELECT last_error FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(nanJob.rows[0].last_error, "invalid_embedding");
  const nanRows = await pool.query(`SELECT count(*)::int AS n FROM photo_embeddings WHERE photo_id = $1`, [photoId]);
  assert.equal(nanRows.rows[0].n, 0);
});

serial("缩略图解码失败立即终态", async () => {
  await reset();
  await insertPhoto({ id: photoId });
  await insertJob({ id: jobId, photoId });
  const thumbnail = createFakeThumbnailEncoder({ fail: true });
  const { deps } = harness({ thumbnail });
  await deps.storage.putObject({ key: `owners/${ownerId}/photos/${photoId}/original`, contentType: "image/jpeg", body: Buffer.from("orig") });
  await runOnce(deps, now, 2);
  const job = await pool.query(`SELECT status, attempts FROM jobs WHERE photo_id = $1`, [photoId]);
  assert.equal(job.rowCount, 1);
  assert.equal(job.rows[0].status, "failed");
  assert.equal(job.rows[0].attempts, 1);
  const photo = await pool.query(`SELECT status, error_message FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].status, "failed");
  assert.equal(photo.rows[0].error_message, "thumbnail_failed");
});

serial("租约回收保留 vision_unavailable，日志才出现 interrupted", async () => {
  await reset();
  await insertPhoto({ id: photoId, errorMessage: "vision_unavailable" });
  const lockedAt = new Date(now.getTime() - 600_000);
  await insertJob({ id: jobId, photoId, status: "running", attempts: 5, lastError: "vision_unavailable", lockedAt });
  const { deps, logs } = harness();
  await runOnce(deps, now, 2);
  const job = await pool.query(`SELECT status, last_error FROM jobs WHERE id = $1`, [jobId]);
  assert.equal(job.rows[0].status, "failed");
  assert.equal(job.rows[0].last_error, "vision_unavailable");
  const photo = await pool.query(`SELECT status, error_message FROM photos WHERE id = $1`, [photoId]);
  assert.equal(photo.rows[0].status, "failed");
  assert.equal(photo.rows[0].error_message, "vision_unavailable");
  assert.equal(logs.some((entry) => entry.message === "任务租约回收" && entry.fields.errorCode === "interrupted"), true);
  const stored = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM jobs WHERE last_error = 'interrupted') +
       (SELECT count(*)::int FROM photos WHERE error_message = 'interrupted') AS n`,
  );
  assert.equal(stored.rows[0].n, 0);
});

serial("并发 2 领走两条到期任务，未来任务保持 pending", async () => {
  await reset();
  const ids = ["33333333-3333-4333-8333-333333333331", "33333333-3333-4333-8333-333333333332", "33333333-3333-4333-8333-333333333334"];
  const jobs = ["55555555-5555-4555-8555-555555555551", "55555555-5555-4555-8555-555555555552", "55555555-5555-4555-8555-555555555553"];
  const { deps } = harness();
  for (let index = 0; index < ids.length; index += 1) {
    await insertPhoto({ id: ids[index] as string });
    await insertJob({
      id: jobs[index] as string,
      photoId: ids[index] as string,
      runAfter: index === 2 ? new Date(now.getTime() + 60_000) : now,
    });
    await deps.storage.putObject({
      key: `owners/${ownerId}/photos/${ids[index]}/original`,
      contentType: "image/jpeg",
      body: Buffer.from("orig"),
    });
  }
  await runOnce(deps, now, 2);
  const done = await pool.query(`SELECT status FROM jobs WHERE id = ANY($1::uuid[]) ORDER BY id`, [jobs.slice(0, 2)]);
  assert.deepEqual(done.rows.map((row) => row.status), ["done", "done"]);
  const later = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [jobs[2]]);
  assert.equal(later.rows[0].status, "pending");
});

serial("已经 ready 的照片不会再次调用视觉、嵌入和 putObject", async () => {
  await reset();
  await insertPhoto({ id: photoId, status: "ready", thumbKey: `owners/${ownerId}/photos/${photoId}/thumb` });
  await insertJob({ id: jobId, photoId, status: "done", step: "done" });
  const { deps, storage, vision, embed } = harness();
  storage.putObjectCalls = 0;
  await runOnce(deps, now, 2);
  assert.equal(vision.calls, 0);
  assert.equal(embed.calls, 0);
  assert.equal(storage.putObjectCalls, 0);
});
```

日志用数组收集 `{ message, fields }`。`runOnce` 的 `limit` 用数字参数，不要读 `PIPELINE_CONCURRENCY`。测试里不要 `setTimeout`。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-run.test.ts
```

Expected: 退出码非 0。`runOnce` 未定义。

- [ ] **Step 3: 写一次领取**

创建 `apps/api/src/adapters/pipeline/deps.ts`：

```typescript
import type { EmbedGateway, ExifReader, ObjectStorage, PipelineLog, PipelineStore, ThumbnailEncoder, VisionGateway } from "../../domain/library/ports.js";

export type { PipelineLog, PipelineLogFields } from "../../domain/library/ports.js";

export type PipelineDeps = {
  store: PipelineStore;
  storage: ObjectStorage;
  exif: ExifReader;
  thumbnail: ThumbnailEncoder;
  vision: VisionGateway;
  embed: EmbedGateway;
  log: PipelineLog;
  visionModel: string;
  embedModel: string;
  embedDimensions: number;
};

export type WorkerControl = {
  stopped: boolean;
  inflight: Map<string, Date>;
};
```

创建 `apps/api/src/adapters/pipeline/failure-message.ts`：

```typescript
import type { PipelineErrorCode } from "../../domain/library/pipeline.js";

export function pipelineFailureMessage(code: PipelineErrorCode): string {
  switch (code) {
    case "storage":
    case "original_missing":
      return "对象存储失败";
    case "thumbnail_failed":
      return "缩略图失败";
    case "vision_unavailable":
    case "vision_rejected":
      return "视觉调用失败";
    case "embed_unavailable":
    case "embed_rejected":
      return "嵌入调用失败";
    case "dimension_mismatch":
    case "invalid_embedding":
      return "维度不一致";
  }
}
```

创建 `apps/api/src/adapters/pipeline/run-once.ts`。编排顺序固定，锁内不调用存储、EXIF、编码器、视觉或嵌入：

```typescript
import type { Photo } from "../../domain/library/model.js";
import type { ClaimedJob } from "../../domain/library/ports.js";
import {
  checkEmbedding,
  embeddingInput,
  exifFill,
  failureDisposition,
  normalizeVisionDescription,
  normalizeVisionTags,
  shouldCallVision,
  thumbObjectKey,
  visionWrite,
  type PipelineErrorCode,
  type PipelineStep,
} from "../../domain/library/pipeline.js";
import type { PipelineDeps, WorkerControl } from "./deps.js";
import { pipelineFailureMessage } from "./failure-message.js";

export async function runOnce(deps: PipelineDeps, now: Date, limit: number, control?: WorkerControl): Promise<void> {
  const reclaimed = await deps.store.reclaimExpired(now);
  for (const job of reclaimed) {
    deps.log.info("任务租约回收", {
      jobId: job.id,
      jobType: job.type,
      photoId: job.photoId,
      attempt: job.attempts,
      errorCode: "interrupted",
    });
  }
  if (limit < 1) return;
  const claimed = await deps.store.claim(now, limit);
  for (const job of claimed) {
    control?.inflight.set(job.id, job.lockedAt);
    if (control?.stopped) continue;
    await runClaimed(deps, job, now);
    control?.inflight.delete(job.id);
  }
}

async function runClaimed(deps: PipelineDeps, job: ClaimedJob, now: Date): Promise<void> {
  let step: PipelineStep = job.type === "reembed" ? "embed" : job.step;
  let original: Buffer | null = null;
  for (let hop = 0; hop < 6 && step !== "done"; hop += 1) {
    if ((step === "exif" || step === "thumbnail" || step === "vision") && !original) {
      const loaded = await loadOriginal(deps, job, now);
      if (loaded === "stop") return;
      original = loaded;
    }
    if (step === "exif") {
      if (await runExif(deps, job, original as Buffer, now) === "stop") return;
      step = "thumbnail";
      continue;
    }
    if (step === "thumbnail") {
      if (await runThumbnail(deps, job, original as Buffer, now) === "stop") return;
      step = "vision";
      continue;
    }
    if (step === "vision") {
      if (await runVision(deps, job, original as Buffer, now) === "stop") return;
      step = "embed";
      continue;
    }
    if (step === "embed") {
      const next = await runEmbed(deps, job, now);
      if (next === "thumbnail") {
        step = "thumbnail";
        continue;
      }
      return;
    }
    return;
  }
}

async function loadOriginal(deps: PipelineDeps, job: ClaimedJob, now: Date): Promise<Buffer | "stop"> {
  const photo = await deps.store.readPhoto(job.photoId);
  if (!photo) {
    deps.log.warn("照片已删除", fields(job, photo, job.step));
    return "stop";
  }
  try {
    const object = await deps.storage.getObject({ key: photo.objectKey });
    if (!object) {
      await finishFailure(deps, job, "original_missing", now, photo, job.step);
      return "stop";
    }
    return object.body;
  } catch (error) {
    await finishFailure(deps, job, "storage", now, photo, job.step, errorName(error));
    return "stop";
  }
}

async function runExif(deps: PipelineDeps, job: ClaimedJob, bytes: Buffer, now: Date): Promise<"ok" | "stop"> {
  const photo = await deps.store.readPhoto(job.photoId);
  if (!photo) {
    deps.log.warn("照片已删除", fields(job, null, "exif"));
    return "stop";
  }
  const reading = await deps.exif.read(bytes);
  const advanced = await deps.store.applyExif({
    jobId: job.id,
    lockedAt: job.lockedAt,
    photoId: photo.id,
    fill: exifFill(photo, reading),
    now,
  });
  return advanced === "ok" ? "ok" : "stop";
}

async function runThumbnail(deps: PipelineDeps, job: ClaimedJob, bytes: Buffer, now: Date): Promise<"ok" | "stop"> {
  const photo = await deps.store.readPhoto(job.photoId);
  if (!photo) {
    deps.log.warn("照片已删除", fields(job, null, "thumbnail"));
    return "stop";
  }
  const expected = thumbObjectKey(photo.ownerId, photo.id);
  if (photo.thumbKey === expected) {
    try {
      const head = await deps.storage.headObject({ key: expected });
      if (head && head.byteSize >= 1) {
        const advanced = await deps.store.noteThumbPresent({ jobId: job.id, lockedAt: job.lockedAt, now });
        return advanced === "ok" ? "ok" : "stop";
      }
    } catch (error) {
      await finishFailure(deps, job, "storage", now, photo, "thumbnail", errorName(error));
      return "stop";
    }
  }
  let encoded: { bytes: Buffer; contentType: "image/jpeg" };
  try {
    encoded = await deps.thumbnail.encode(bytes);
  } catch (error) {
    const code = errorName(error) === "ThumbnailEncodeError" ? "thumbnail_failed" : "storage";
    await finishFailure(deps, job, code, now, photo, "thumbnail", errorName(error));
    return "stop";
  }
  try {
    await deps.storage.putObject({ key: expected, contentType: "image/jpeg", body: encoded.bytes });
  } catch (error) {
    await finishFailure(deps, job, "storage", now, photo, "thumbnail", errorName(error));
    return "stop";
  }
  const committed = await deps.store.commitThumb({
    jobId: job.id,
    lockedAt: job.lockedAt,
    photoId: photo.id,
    thumbKey: expected,
    now,
  });
  if (committed === "missing") {
    try {
      await deps.storage.deleteObject({ key: expected });
    } catch (error) {
      deps.log.warn("对象存储失败", { ...fields(job, photo, "thumbnail"), errorName: errorName(error) });
    }
    deps.log.warn("照片已删除", fields(job, photo, "thumbnail"));
    return "stop";
  }
  return committed === "ok" ? "ok" : "stop";
}

async function runVision(deps: PipelineDeps, job: ClaimedJob, bytes: Buffer, now: Date): Promise<"ok" | "stop"> {
  const photo = await deps.store.readPhoto(job.photoId);
  if (!photo) {
    deps.log.warn("照片已删除", fields(job, null, "vision"));
    return "stop";
  }
  if (!shouldCallVision(photo)) {
    const advanced = await deps.store.skipVision({ jobId: job.id, lockedAt: job.lockedAt, now });
    return advanced === "ok" ? "ok" : "stop";
  }
  try {
    const described = await deps.vision.describe({ model: deps.visionModel, contentType: photo.contentType, bytes });
    if (!described.ok) {
      await finishFailure(deps, job, described.kind, now, photo, "vision");
      return "stop";
    }
    const write = visionWrite(photo, {
      description: normalizeVisionDescription(described.description),
      tags: normalizeVisionTags(described.tags),
    });
    const advanced = await deps.store.applyVision({
      jobId: job.id,
      lockedAt: job.lockedAt,
      photoId: photo.id,
      description: write.description,
      tags: write.tags,
      now,
    });
    return advanced === "ok" ? "ok" : "stop";
  } catch (error) {
    await finishFailure(deps, job, "vision_unavailable", now, photo, "vision", errorName(error));
    return "stop";
  }
}

async function runEmbed(deps: PipelineDeps, job: ClaimedJob, now: Date): Promise<"stop" | "thumbnail"> {
  const photo = await deps.store.readPhoto(job.photoId);
  if (!photo) {
    deps.log.warn("照片已删除", fields(job, null, "embed"));
    return "stop";
  }
  const text = embeddingInput(photo);
  let embedded: Awaited<ReturnType<PipelineDeps["embed"]["embed"]>>;
  try {
    embedded = await deps.embed.embed({ model: deps.embedModel, text });
  } catch (error) {
    await finishFailure(deps, job, "embed_unavailable", now, photo, "embed", errorName(error));
    return "stop";
  }
  if (!embedded.ok) {
    await finishFailure(deps, job, embedded.kind, now, photo, "embed");
    return "stop";
  }
  const checked = checkEmbedding(embedded.values, deps.embedDimensions);
  if (!checked.ok) {
    await finishFailure(deps, job, checked.code, now, photo, "embed");
    return "stop";
  }
  try {
    const committed = await deps.store.commitEmbedding(
      {
        jobId: job.id,
        lockedAt: job.lockedAt,
        photoId: photo.id,
        jobType: job.type,
        values: embedded.values,
        dimensions: deps.embedDimensions,
        model: deps.embedModel,
        now,
      },
      (locked) => {
        if (embeddingInput(locked) !== text) return "text_changed";
        if (job.type === "process_photo" && locked.thumbKey === null) return "need_thumbnail";
        return "write";
      },
    );
    if (committed === "text_changed") {
      await deps.store.releaseRunning({ jobId: job.id, lockedAt: job.lockedAt, now });
      return "stop";
    }
    if (committed === "need_thumbnail") {
      const rewound = await deps.store.rewindToThumbnail({ jobId: job.id, lockedAt: job.lockedAt, now });
      return rewound === "ok" ? "thumbnail" : "stop";
    }
    if (committed === "missing") deps.log.warn("照片已删除", fields(job, photo, "embed"));
    return "stop";
  } catch (error) {
    const name = errorName(error);
    if (name === "DimensionMismatch") {
      await finishFailure(deps, job, "dimension_mismatch", now, photo, "embed", name);
      return "stop";
    }
    if (name === "InvalidEmbedding") {
      await finishFailure(deps, job, "invalid_embedding", now, photo, "embed", name);
      return "stop";
    }
    throw error;
  }
}

async function finishFailure(
  deps: PipelineDeps,
  job: ClaimedJob,
  code: PipelineErrorCode,
  now: Date,
  photo: Photo | null,
  step: PipelineStep,
  errorNameValue?: string,
): Promise<void> {
  const disposition = failureDisposition(code, job.attempts);
  if (disposition.outcome === "retry") {
    await deps.store.retryJob({
      jobId: job.id,
      lockedAt: job.lockedAt,
      photoId: job.photoId,
      jobType: job.type,
      code,
      runAfter: new Date(now.getTime() + disposition.delayMs),
      now,
    });
  } else {
    await deps.store.failJob({
      jobId: job.id,
      lockedAt: job.lockedAt,
      photoId: job.photoId,
      jobType: job.type,
      code,
      now,
    });
  }
  deps.log.warn(pipelineFailureMessage(code), { ...fields(job, photo, step), errorCode: code, errorName: errorNameValue });
}

function fields(job: ClaimedJob, photo: Photo | null, step: PipelineStep) {
  return {
    userId: photo?.ownerId,
    photoId: job.photoId,
    objectKey: photo?.objectKey,
    jobId: job.id,
    jobType: job.type,
    step,
    attempt: job.attempts,
  };
}

function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error && typeof error.name === "string") return error.name;
  return "Error";
}
```

`adapters/index.ts` 增加 `export { runOnce } from "./pipeline/run-once.js";`。适配层源码不要出现 `/dao`、`/gateways`、`sharp`、`exifr`、`@aws-sdk/`、`undici`。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-run.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 退出码 0。若第 4 条停在 `attempts = 1`，检查失败码走的是 `retryJob` 而不是 `failJob`，并且 `run_after` 用的是传入的 `now` 加 30000 毫秒。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/adapters/pipeline apps/api/src/adapters/index.ts apps/api/test/pipeline-run.test.ts
git commit -m "feat: 编排一次照片处理领取"
```

---

### Task 8: 补救入队、PATCH、重试与照片字段

**Files:**
- Modify: `apps/api/src/adapters/library/messages.ts`
- Modify: `apps/api/src/adapters/library/photo-response.ts`
- Modify: `apps/api/src/adapters/library/complete-upload.ts`
- Modify: `apps/api/src/adapters/library/patch-photo.ts`
- Modify: `apps/api/src/adapters/library/get-photo.ts`
- Create: `apps/api/src/adapters/library/retry-photo.ts`
- Modify: `apps/api/src/adapters/index.ts`
- Modify: `apps/api/src/interfaces/http/register-photos.ts`
- Test: `apps/api/test/pipeline-enqueue.test.ts`

**Interfaces:**
- Consumes: `ensureProcessPhoto`、`transactOwned`、`semanticChanged`、`toPhotoResponse`、`isAllowedEmptyJson`
- Produces:
  - `PhotoResponse` 增加 `errorCode: string | null`、`thumbUrl: string | null`、`thumbUrlExpiresAt: string | null`
  - `retryPhoto(deps, actor, photoId, now) -> Promise<LibraryResult<{ photo: PhotoResponse }>>`
  - `notFailed()`：409，`code` 为 `not_failed`，文案「照片不在失败状态」
  - `patchIncomplete()`：500，`code` 为 `internal_error`，文案「修改未能完成」
  - `POST /photos/:id/retry`。正文省略或 `{}` 才合法

- [ ] **Step 1: 写会失败的 HTTP 测试**

创建 `apps/api/test/pipeline-enqueue.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { createFakeObjectStorage, createStorageGate } from "../src/gateways/storage/fake-object-storage.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";
import { ManualClock } from "./manual-clock.js";

const databaseUrl = requireDatabaseUrl();
const START = new Date("2030-06-01T00:00:00.000Z");
const clock = new ManualClock(START);
const pool = new pg.Pool({ connectionString: databaseUrl });
const storage = createFakeObjectStorage();
const testConfig = {
  jwtSecret: "test-jwt-secret-at-least-32-bytes",
  pepper: "test-pepper-at-least-32-bytes-ok",
  accessTtlSeconds: 120,
  refreshTtlSeconds: 30 * 24 * 60 * 60,
  databaseUrl,
};
let app: Awaited<ReturnType<typeof buildApp>>;

let tail: Promise<unknown> = Promise.resolve();
function serial(name: string, fn: () => Promise<void>): void {
  test(name, () => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  });
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function reset(): Promise<void> {
  clock.set(START);
  storage.blockComplete(null);
  await pool.query("TRUNCATE TABLE users CASCADE");
}

async function register(email: string): Promise<{ accessToken: string; userId: string }> {
  const response = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "correct-horse" } });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  return { accessToken: String(body.accessToken), userId: String(body.user.id) };
}

async function upload(token: string): Promise<{ sessionId: string; photoId: string }> {
  const created = await app.inject({
    method: "POST",
    url: "/photos/uploads",
    headers: auth(token),
    payload: { contentType: "image/jpeg", byteSize: 4 },
  });
  assert.equal(created.statusCode, 201);
  const uploadBody = created.json().upload;
  const part = await app.inject({
    method: "PUT",
    url: `/photos/uploads/${uploadBody.id}/parts/1`,
    headers: { ...auth(token), "content-type": "application/octet-stream" },
    payload: Buffer.from("abcd"),
  });
  assert.equal(part.statusCode, 200);
  return { sessionId: String(uploadBody.id), photoId: String(uploadBody.photoId) };
}

test.before(async () => {
  await applySchema(pool);
  app = await buildApp({ logger: false, config: testConfig, clock, pool, storage, signedUrlTtlSeconds: 900 });
});

test.after(async () => {
  await app.close();
  await pool.end();
});

serial("完成响应带空缩略图字段并入队一条 process_photo", async () => {
  await reset();
  const owner = await register("enqueue@example.com");
  const uploaded = await upload(owner.accessToken);
  const completed = await app.inject({
    method: "POST",
    url: `/photos/uploads/${uploaded.sessionId}/complete`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  assert.equal(completed.statusCode, 201);
  const photo = completed.json().photo;
  assert.equal(photo.status, "processing");
  assert.equal(photo.errorCode, null);
  assert.equal(photo.thumbUrl, null);
  assert.equal(photo.thumbUrlExpiresAt, null);
  assert.equal(Object.hasOwn(photo, "errorCode"), true);
  assert.equal(Object.hasOwn(photo, "thumbUrl"), true);
  assert.equal(Object.hasOwn(photo, "thumbUrlExpiresAt"), true);
  const jobs = await pool.query(
    `SELECT type, payload->>'step' AS step FROM jobs WHERE photo_id = $1`,
    [uploaded.photoId],
  );
  assert.equal(jobs.rowCount, 1);
  assert.equal(jobs.rows[0].type, "process_photo");
  assert.equal(jobs.rows[0].step, "exif");
});

serial("completing 期间不入队，再次完成不增加任务", async () => {
  await reset();
  const owner = await register("completing@example.com");
  const uploaded = await upload(owner.accessToken);
  const gate = createStorageGate();
  storage.blockComplete(gate);
  const pending = app.inject({
    method: "POST",
    url: `/photos/uploads/${uploaded.sessionId}/complete`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  await gate.entered;
  const session = await pool.query(`SELECT status FROM upload_sessions WHERE id = $1`, [uploaded.sessionId]);
  assert.equal(session.rows[0].status, "completing");
  const during = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1`, [uploaded.photoId]);
  assert.equal(during.rows[0].n, 0);
  gate.release();
  const completed = await pending;
  assert.equal(completed.statusCode, 201);
  const again = await app.inject({
    method: "POST",
    url: `/photos/uploads/${uploaded.sessionId}/complete`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  assert.equal(again.statusCode, 200);
  const jobs = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1 AND type = 'process_photo'`, [uploaded.photoId]);
  assert.equal(jobs.rows[0].n, 1);
});

serial("failed 且已有历史任务时再次完成不入队", async () => {
  await reset();
  const owner = await register("failed-complete@example.com");
  const uploaded = await upload(owner.accessToken);
  const completed = await app.inject({
    method: "POST",
    url: `/photos/uploads/${uploaded.sessionId}/complete`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  assert.equal(completed.statusCode, 201);
  await pool.query(`UPDATE photos SET status = 'failed', error_message = 'vision_rejected' WHERE id = $1`, [uploaded.photoId]);
  const again = await app.inject({
    method: "POST",
    url: `/photos/uploads/${uploaded.sessionId}/complete`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().photo.status, "failed");
  const jobs = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1 AND type = 'process_photo'`, [uploaded.photoId]);
  assert.equal(jobs.rows[0].n, 1);
});

serial("PATCH 只有描述变化才入队 reembed，重试只接受 failed", async () => {
  await reset();
  const owner = await register("patch@example.com");
  const other = await register("other@example.com");
  const uploaded = await upload(owner.accessToken);
  await app.inject({
    method: "POST",
    url: `/photos/uploads/${uploaded.sessionId}/complete`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  await pool.query(`UPDATE photos SET status = 'ready', description = '旧描述' WHERE id = $1`, [uploaded.photoId]);
  await pool.query(`UPDATE jobs SET status = 'done', payload = '{"step":"done"}'::jsonb WHERE photo_id = $1`, [uploaded.photoId]);
  const changed = await app.inject({
    method: "PATCH",
    url: `/photos/${uploaded.photoId}`,
    headers: auth(owner.accessToken),
    payload: { description: "新描述" },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().photo.status, "ready");
  const reembed = await pool.query(
    `SELECT status FROM jobs WHERE photo_id = $1 AND type = 'reembed' AND status = 'pending'`,
    [uploaded.photoId],
  );
  assert.equal(reembed.rowCount, 1);
  const beforeTaken = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1`, [uploaded.photoId]);
  const taken = await app.inject({
    method: "PATCH",
    url: `/photos/${uploaded.photoId}`,
    headers: auth(owner.accessToken),
    payload: { takenAt: "2020-01-02T03:04:05.000Z" },
  });
  assert.equal(taken.statusCode, 200);
  const same = await app.inject({
    method: "PATCH",
    url: `/photos/${uploaded.photoId}`,
    headers: auth(owner.accessToken),
    payload: { description: "新描述" },
  });
  assert.equal(same.statusCode, 200);
  const after = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1`, [uploaded.photoId]);
  assert.equal(after.rows[0].n, beforeTaken.rows[0].n);

  await pool.query(`UPDATE photos SET status = 'failed', error_message = 'embed_rejected' WHERE id = $1`, [uploaded.photoId]);
  const retried = await app.inject({
    method: "POST",
    url: `/photos/${uploaded.photoId}/retry`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.json().photo.status, "processing");
  assert.equal(retried.json().photo.errorCode, null);
  const processRows = await pool.query(
    `SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1 AND type = 'process_photo' AND status = 'pending'`,
    [uploaded.photoId],
  );
  assert.equal(processRows.rows[0].n, 1);

  await pool.query(`UPDATE photos SET status = 'ready', error_message = NULL WHERE id = $1`, [uploaded.photoId]);
  const blocked = await app.inject({
    method: "POST",
    url: `/photos/${uploaded.photoId}/retry`,
    headers: auth(owner.accessToken),
    payload: {},
  });
  assert.equal(blocked.statusCode, 409);
  assert.deepEqual(blocked.json(), { error: { code: "not_failed", message: "照片不在失败状态" } });
  const foreign = await app.inject({
    method: "POST",
    url: `/photos/${uploaded.photoId}/retry`,
    headers: auth(other.accessToken),
    payload: {},
  });
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().error.message, "未找到");
  const extra = await app.inject({
    method: "POST",
    url: `/photos/${uploaded.photoId}/retry`,
    headers: auth(owner.accessToken),
    payload: { extra: true },
  });
  assert.equal(extra.statusCode, 400);
  assert.equal(extra.json().error.message, "请求不合法");
});
```

第 4 条用 SQL 把已完成照片改成 `failed`，不要先删掉历史 `process_photo`。重试用例同样保留历史行，只断言新出现一条 `pending` 的 `process_photo`。

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-enqueue.test.ts
```

Expected: 退出码非 0。响应没有 `errorCode`，或 retry 路由是 404。

- [ ] **Step 3: 改响应、完成补救、PATCH 与重试**

`LIBRARY_MESSAGES` 增加 `notFailed: "照片不在失败状态"` 与 `patchIncomplete: "修改未能完成"`。`LibraryError["code"]` 增加 `"not_failed"`。增加 `notFailed()` 与 `patchIncomplete()`，状态码分别是 409 与 500。

`PhotoResponse` 在 `status` 后增加 `errorCode: string | null`，在 `originalUrlExpiresAt` 后增加 `thumbUrl: string | null` 与 `thumbUrlExpiresAt: string | null`。`toPhotoResponse` 先签发原图。`photo.thumbKey` 非空时再用同一个 TTL 签发缩略图；为空则两个缩略图字段都是 `null`。返回对象带上 `errorCode: photo.errorCode`。签发抛错继续向外抛，由调用方记录。

`get-photo.ts` 用 try/catch 包住 `toPhotoResponse`。失败时 `deps.log.warn("对象存储失败", { userId, photoId, objectKey, errorName })`，返回 `storageError()`。

`complete-upload.ts` 在 `insertPhotoAndComplete` 返回之后、`findById` 之前：

```typescript
    if (inserted === "exists") {
      await deps.photos.ensureProcessPhoto({
        photoId: current.photoId,
        jobId: deps.ids.nextId(),
        now,
      });
    }
```

这行留在现有的 `try/catch` 里。数据库错误仍返回「上传未能完成」，不删除已经存在的照片。

把 `patch-photo.ts` 换成锁外签发的版本：

```typescript
import { semanticChanged } from "../../domain/library/pipeline.js";
import type { LibraryActor, MetadataPatch, Photo } from "../../domain/library/model.js";
import { isVisiblePhoto } from "../../domain/library/visibility.js";
import type { LibraryDeps } from "./deps.js";
import { errorName } from "./error-name.js";
import type { LibraryResult } from "./messages.js";
import { notFound, patchIncomplete, storageError } from "./messages.js";
import { toPhotoResponse, type PhotoResponse } from "./photo-response.js";

export async function patchPhoto(
  deps: LibraryDeps,
  actor: LibraryActor,
  photoId: string,
  patch: MetadataPatch,
  now: Date,
): Promise<LibraryResult<{ photo: PhotoResponse }>> {
  const existing = await deps.photos.findById(photoId);
  if (!existing || !isVisiblePhoto(existing, actor.userId)) return notFound();
  if (Object.keys(patch).length === 0) return respond(deps, actor.userId, existing, now);
  let saved: Photo | null = null;
  let missing = false;
  try {
    await deps.photos.transactOwned(photoId, actor.userId, async (photo, tx) => {
      if (!photo || !isVisiblePhoto(photo, actor.userId)) {
        missing = true;
        return;
      }
      const next = await tx.update(patch, now);
      if (!next) {
        missing = true;
        return;
      }
      if (semanticChanged(photo, patch)) {
        const active = await tx.activeJobs();
        const busy = active.some((job) => job.type === "process_photo" || job.type === "reembed");
        if (!busy) await tx.insertReembed({ id: deps.ids.nextId(), runAfter: now, now });
      }
      saved = next;
    });
  } catch (error) {
    deps.log.warn("修改未能完成", { userId: actor.userId, photoId, errorName: errorName(error) });
    return patchIncomplete();
  }
  if (missing || !saved) return notFound();
  return respond(deps, actor.userId, saved, now);
}

async function respond(deps: LibraryDeps, userId: string, photo: Photo, now: Date): Promise<LibraryResult<{ photo: PhotoResponse }>> {
  try {
    return { ok: true, status: 200, body: { photo: await toPhotoResponse(deps, photo, now) } };
  } catch (error) {
    deps.log.warn("对象存储失败", { userId, photoId: photo.id, objectKey: photo.objectKey, errorName: errorName(error) });
    return storageError();
  }
}
```

创建 `apps/api/src/adapters/library/retry-photo.ts`：

```typescript
import type { LibraryActor, Photo } from "../../domain/library/model.js";
import { isVisiblePhoto } from "../../domain/library/visibility.js";
import type { LibraryDeps } from "./deps.js";
import { errorName } from "./error-name.js";
import type { LibraryResult } from "./messages.js";
import { notFailed, notFound, patchIncomplete, storageError } from "./messages.js";
import { toPhotoResponse, type PhotoResponse } from "./photo-response.js";

export async function retryPhoto(
  deps: LibraryDeps,
  actor: LibraryActor,
  photoId: string,
  now: Date,
): Promise<LibraryResult<{ photo: PhotoResponse }>> {
  let saved: Photo | null = null;
  let outcome: "missing" | "not_failed" | "ok" = "missing";
  try {
    await deps.photos.transactOwned(photoId, actor.userId, async (photo, tx) => {
      if (!photo || !isVisiblePhoto(photo, actor.userId)) return;
      if (photo.status !== "failed") {
        outcome = "not_failed";
        return;
      }
      const reset = await tx.resetForRetry(now);
      if (!reset) return;
      await tx.deletePendingReembed();
      const active = await tx.activeJobs();
      if (!active.some((job) => job.type === "process_photo")) {
        await tx.insertProcessPhoto({ id: deps.ids.nextId(), runAfter: now, now });
      }
      saved = reset;
      outcome = "ok";
    });
  } catch (error) {
    deps.log.warn("修改未能完成", { userId: actor.userId, photoId, errorName: errorName(error) });
    return patchIncomplete();
  }
  if (outcome === "not_failed") return notFailed();
  if (outcome !== "ok" || !saved) return notFound();
  try {
    return { ok: true, status: 200, body: { photo: await toPhotoResponse(deps, saved, now) } };
  } catch (error) {
    deps.log.warn("对象存储失败", { userId: actor.userId, photoId, objectKey: saved.objectKey, errorName: errorName(error) });
    return storageError();
  }
}
```

`resetForRetry` 返回的照片已经是 `processing` 且 `errorCode` 为空。不要在锁内调用 `toPhotoResponse`。

`adapters/index.ts` 导出 `retryPhoto`。`register-photos.ts` 在 `DELETE /photos/:id` 之前注册：

```typescript
  app.post("/photos/:id/retry", async (request, reply) => {
    const principal = await requirePrincipal(identity, authorizationHeader(request.headers.authorization));
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    if (!isAllowedEmptyJson(request.body)) return sendInvalid(reply, LIBRARY_MESSAGES.invalidBody);
    const photoId = parseUuid((request.params as { id: string }).id);
    if (typeof photoId !== "string") return sendInvalid(reply, photoId.message);
    const result = await retryPhoto(library, toLibraryActor(principal), photoId, clock.now());
    return sendLibraryResult(reply, result);
  });
```

导入 `retryPhoto`。不能通过 PATCH 修改 `status` 或 `errorCode`；现有 `normalizeMetadataPatch` 已经拒绝未知字段，不要放宽它。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-enqueue.test.ts apps/api/test/personal-library.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 退出码 0。Phase 2 的个人库测试仍通过。它们按字段断言，不需要为了三个新键改写整份夹具。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/adapters/library/messages.ts apps/api/src/adapters/library/photo-response.ts apps/api/src/adapters/library/complete-upload.ts apps/api/src/adapters/library/patch-photo.ts apps/api/src/adapters/library/get-photo.ts apps/api/src/adapters/library/retry-photo.ts apps/api/src/adapters/index.ts apps/api/src/interfaces/http/register-photos.ts apps/api/test/pipeline-enqueue.test.ts
git commit -m "feat: 补上重嵌入、失败重试与缩略图字段"
```


---

### Task 9: worker 入口与生产占位符退出

**Files:**
- Create: `apps/api/src/adapters/pipeline/worker-loop.ts`
- Create: `apps/api/src/wire-pipeline.ts`
- Create: `apps/api/src/worker.ts`
- Create: `deploy/systemd/photo-worker.service.example`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/package.json`
- Modify: `deploy/README.md`
- Modify: `apps/api/src/adapters/index.ts`
- Test: `apps/api/test/pipeline-worker.test.ts`

**Interfaces:**
- Consumes: `runOnce`、`WorkerControl`、`loadPipelineConfig`、`productionStoragePlaceholderMessage`、`loadStorageConfig`、`createS3ObjectStorage`、`createExifrReader`、`createSharpThumbnailEncoder`、`createHttpVisionGateway`、`createFakeVisionGateway`、`createHttpEmbedGateway`、`createFakeEmbedGateway`、`createPipelineStore`
- Produces:
  - `runWorkerLoop(input): Promise<void>`。`input` 含 `pollMs`、`concurrency`、`now(): Date`、`sleep(ms): Promise<void>`、`runOnce(now, limit): Promise<void>`、`releaseUnfinished(now): Promise<void>`、`control`
  - `createPipelineLogger(write: (line: string) => void): PipelineLog`
  - `createModelGateways(config, log)` 返回 `{ vision, embed, visionModel, embedModel, embedDimensions }`
  - `createPipelineDeps(...)` 返回 `PipelineDeps`
  - `package.json` 脚本 `worker` 为 `tsx src/worker.ts`，`start:worker` 为 `node dist/worker.js`

- [ ] **Step 1: 写会失败的循环测试**

创建 `apps/api/test/pipeline-worker.test.ts`：

```typescript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runWorkerLoop } from "../src/adapters/pipeline/worker-loop.js";
import type { WorkerControl } from "../src/adapters/pipeline/deps.js";

test("停止后不再领取，并释放仍在执行的任务", async () => {
  const control: WorkerControl = { stopped: false, inflight: new Map() };
  const limits: number[] = [];
  let sleeps = 0;
  let released = 0;
  await runWorkerLoop({
    pollMs: 10,
    concurrency: 2,
    now: () => new Date("2030-01-01T00:00:00.000Z"),
    sleep: async () => {
      sleeps += 1;
    },
    runOnce: async (_now, limit) => {
      limits.push(limit);
      control.stopped = true;
    },
    releaseUnfinished: async () => {
      released += 1;
    },
    control,
  });
  assert.deepEqual(limits, [2]);
  assert.equal(sleeps, 0);
  assert.equal(released, 1);
});

test("worker 源码不监听端口，生产入口检查对象存储占位符", async () => {
  const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  const api = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const unit = await readFile(new URL("../../../deploy/systemd/photo-worker.service.example", import.meta.url), "utf8");
  assert.equal(worker.includes(".listen("), false);
  assert.equal(worker.includes("SIGTERM"), true);
  assert.equal(worker.includes("SIGINT"), true);
  assert.equal(worker.includes("60000"), true);
  assert.equal(api.includes("对象存储配置仍是占位符"), true);
  assert.equal(api.includes("VISION_"), false);
  assert.equal(api.includes("EMBED_"), false);
  assert.match(unit, /dist\/worker\.js/);
  assert.equal(unit.includes("PORT"), false);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-worker.test.ts
```

Expected: 退出码非 0。`runWorkerLoop` 或 `worker.ts` 不存在。

- [ ] **Step 3: 写循环、组合根与单元草图**

创建 `apps/api/src/adapters/pipeline/worker-loop.ts`：

```typescript
import type { WorkerControl } from "./deps.js";

export const SHUTDOWN_WAIT_MS = 60_000;

export async function runWorkerLoop(input: {
  pollMs: number;
  concurrency: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  runOnce: (now: Date, limit: number) => Promise<void>;
  releaseUnfinished: (now: Date) => Promise<void>;
  control: WorkerControl;
}): Promise<void> {
  while (!input.control.stopped) {
    const limit = input.concurrency - input.control.inflight.size;
    await input.runOnce(input.now(), limit);
    if (input.control.stopped) break;
    await input.sleep(input.pollMs);
  }
  await input.releaseUnfinished(input.now());
}
```

`adapters/index.ts` 导出 `runWorkerLoop`。

创建 `apps/api/src/wire-pipeline.ts`。这个文件留在 `src/` 根下，不要移进五层目录。Task 10 会把 `createPipelineLogger` 收成白名单；本任务先原样序列化字段。

```typescript
import pg from "pg";
import type { PipelineDeps, PipelineLog } from "./adapters/pipeline/deps.js";
import { createPipelineStore } from "./dao/pipeline-store.js";
import type { EmbedGateway, ExifReader, ObjectStorage, ThumbnailEncoder, VisionGateway } from "./domain/library/ports.js";
import { createFakeEmbedGateway } from "./gateways/embed/fake-embed.js";
import { createHttpEmbedGateway } from "./gateways/embed/http-embed.js";
import type { PipelineConfig } from "./gateways/embed/config.js";
import { createFakeVisionGateway } from "./gateways/vision/fake-vision.js";
import { createHttpVisionGateway } from "./gateways/vision/http-vision.js";

export function createPipelineLogger(write: (line: string) => void): PipelineLog {
  return {
    info(message, fields) {
      write(JSON.stringify({ level: "info", message, ...fields }));
    },
    warn(message, fields) {
      write(JSON.stringify({ level: "warn", message, ...fields }));
    },
  };
}

export function createModelGateways(config: PipelineConfig, log: PipelineLog): {
  vision: VisionGateway;
  embed: EmbedGateway;
  visionModel: string;
  embedModel: string;
  embedDimensions: number;
} {
  const vision = config.vision.kind === "fake"
    ? createFakeVisionGateway({ description: "未配置视觉模型", tags: ["未配置"] })
    : createHttpVisionGateway(config.vision);
  log.info(config.vision.kind === "fake" ? "视觉网关使用假实现" : "视觉网关使用 HTTP", {});
  const embed = config.embed.kind === "fake"
    ? createFakeEmbedGateway({ dimensions: config.embed.dimensions })
    : createHttpEmbedGateway(config.embed);
  log.info(config.embed.kind === "fake" ? "嵌入网关使用假实现" : "嵌入网关使用 HTTP", {});
  return {
    vision,
    embed,
    visionModel: config.vision.model,
    embedModel: config.embed.model,
    embedDimensions: config.embed.dimensions,
  };
}

export function createPipelineDeps(input: {
  pool: pg.Pool;
  storage: ObjectStorage;
  exif: ExifReader;
  thumbnail: ThumbnailEncoder;
  vision: VisionGateway;
  embed: EmbedGateway;
  log: PipelineLog;
  visionModel: string;
  embedModel: string;
  embedDimensions: number;
}): PipelineDeps {
  return {
    store: createPipelineStore(input.pool),
    storage: input.storage,
    exif: input.exif,
    thumbnail: input.thumbnail,
    vision: input.vision,
    embed: input.embed,
    log: input.log,
    visionModel: input.visionModel,
    embedModel: input.embedModel,
    embedDimensions: input.embedDimensions,
  };
}
```

假网关与 HTTP 网关的 INFO 字段保持空对象。不要导入 `PipelineLogFields`。

创建 `apps/api/src/worker.ts`：

```typescript
import pg from "pg";
import { runOnce } from "./adapters/pipeline/run-once.js";
import { runWorkerLoop } from "./adapters/pipeline/worker-loop.js";
import type { WorkerControl } from "./adapters/pipeline/deps.js";
import { loadAuthConfig } from "./gateways/auth/config.js";
import { loadPipelineConfig } from "./gateways/embed/config.js";
import { createExifrReader } from "./gateways/exif/exifr-reader.js";
import { createS3ObjectStorage } from "./gateways/storage/s3-object-storage.js";
import { loadStorageConfig, productionStoragePlaceholderMessage } from "./gateways/storage/config.js";
import { createSharpThumbnailEncoder } from "./gateways/thumbnail/sharp-encoder.js";
import { createModelGateways, createPipelineDeps, createPipelineLogger } from "./wire-pipeline.js";

const auth = loadAuthConfig(process.env);
let storageConfig: ReturnType<typeof loadStorageConfig>;
try {
  storageConfig = loadStorageConfig(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : "对象存储配置无效");
  process.exit(1);
}
const storagePlaceholder = productionStoragePlaceholderMessage(process.env);
if (storagePlaceholder) {
  console.error(storagePlaceholder);
  process.exit(1);
}
const pipeline = loadPipelineConfig(process.env);
if (!pipeline.ok) {
  console.error(pipeline.message);
  process.exit(pipeline.exitCode);
}

const pool = new pg.Pool({ connectionString: auth.databaseUrl });
const log = createPipelineLogger((line) => {
  console.log(line);
});
const models = createModelGateways(pipeline.config, log);
const deps = createPipelineDeps({
  pool,
  storage: createS3ObjectStorage(storageConfig),
  exif: createExifrReader(),
  thumbnail: createSharpThumbnailEncoder(),
  vision: models.vision,
  embed: models.embed,
  log,
  visionModel: models.visionModel,
  embedModel: models.embedModel,
  embedDimensions: models.embedDimensions,
});
const control: WorkerControl = { stopped: false, inflight: new Map() };
let stopRequested = false;

async function releaseUnfinished(now: Date): Promise<void> {
  for (const [jobId, lockedAt] of control.inflight) {
    await deps.store.releaseRunning({ jobId, lockedAt, now });
  }
  control.inflight.clear();
}

const loop = runWorkerLoop({
  pollMs: pipeline.config.pollMs,
  concurrency: pipeline.config.concurrency,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  runOnce: (now, limit) => runOnce(deps, now, limit, control),
  releaseUnfinished,
  control,
});

async function requestStop(): Promise<void> {
  if (stopRequested) return;
  stopRequested = true;
  control.stopped = true;
  await Promise.race([loop, new Promise((resolve) => setTimeout(resolve, 60000))]);
  await releaseUnfinished(new Date());
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void requestStop();
});
process.on("SIGINT", () => {
  void requestStop();
});

await loop;
await pool.end();
```

不要调用 `listen`。不要 `import` `buildApp`。不要导入 `SHUTDOWN_WAIT_MS`：等待字面量必须是 `60000`，源码测试按这个数字匹配。

把 `apps/api/src/index.ts` 现有的 `loadStorageConfig` 导入换成：

```typescript
import { loadStorageConfig, productionStoragePlaceholderMessage } from "./gateways/storage/config.js";
```

```typescript
const storagePlaceholder = productionStoragePlaceholderMessage(process.env);
if (storagePlaceholder) {
  console.error(storagePlaceholder);
  process.exit(1);
}
```

把这段检查放在 `loadStorageConfig` 的 `try/catch` 成功之后、`const port` 之前。不要在 `index.ts` 读取 `VISION_` 或 `EMBED_`。

`apps/api/package.json` 的 `scripts` 增加：

```json
    "worker": "tsx src/worker.ts",
    "start:worker": "node dist/worker.js"
```

创建 `deploy/systemd/photo-worker.service.example`：

```ini
[Unit]
Description=AI Native 共享相册处理流水线
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/photo-album/apps/api
EnvironmentFile=/etc/photo-album/api.env
ExecStart=/usr/bin/node dist/worker.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

在 `deploy/README.md` 的 Phase 3 段落后面追加：

```markdown
Worker 单元草图是 `systemd/photo-worker.service.example`。`EnvironmentFile` 与 API 相同，`ExecStart` 指向 `dist/worker.js`，不监听端口。
```

在 `deploy/README.md` 布局表里，`systemd/photo-api.service.example` 那一行下面插入：

```markdown
| `systemd/photo-worker.service.example` | 处理流水线 worker 的 systemd 单元草图 |
```

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-worker.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/adapters/pipeline/worker-loop.ts apps/api/src/adapters/index.ts apps/api/src/wire-pipeline.ts apps/api/src/worker.ts apps/api/src/index.ts apps/api/package.json deploy/systemd/photo-worker.service.example deploy/README.md apps/api/test/pipeline-worker.test.ts
git commit -m "feat: 增加独立的处理流水线 worker"
```

---

### Task 10: 流水线日志红线

**Files:**
- Modify: `apps/api/src/interfaces/http/auth-logger.ts`
- Modify: `apps/api/src/wire-pipeline.ts`
- Test: `apps/api/test/pipeline-log.test.ts`

**Interfaces:**
- Consumes: 现有 redact 路径必须保留：`req.body`、`req.headers.authorization`、`body`、`password`、`refreshToken`、`secret`、`accessToken`、`originalUrl`、`photo.originalUrl`、`photos[*].originalUrl`
- Produces: 追加 `thumbUrl`、`photo.thumbUrl`、`photos[*].thumbUrl`、`dataBase64`、`embedding`。`createPipelineLogger` 只写出 `userId`、`photoId`、`objectKey`、`jobId`、`jobType`、`step`、`attempt`、`errorCode`、`errorName` 和 `message`

- [ ] **Step 1: 写会失败的日志测试**

创建 `apps/api/test/pipeline-log.test.ts`。日志断言对象是 `createPipelineLogger` 写出的字符串，测试自己不要过滤字段。

```typescript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { runOnce } from "../src/adapters/pipeline/run-once.js";
import type { PipelineDeps } from "../src/adapters/pipeline/deps.js";
import { createPipelineStore } from "../src/dao/pipeline-store.js";
import { createUserRepository } from "../src/dao/user-repository.js";
import type { User } from "../src/domain/identity/model.js";
import { createFakeEmbedGateway } from "../src/gateways/embed/fake-embed.js";
import { createFakeExifReader } from "../src/gateways/exif/fake-exif-reader.js";
import { createFakeObjectStorage } from "../src/gateways/storage/fake-object-storage.js";
import { createFakeThumbnailEncoder } from "../src/gateways/thumbnail/fake-encoder.js";
import { createFakeVisionGateway } from "../src/gateways/vision/fake-vision.js";
import { createPipelineLogger } from "../src/wire-pipeline.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";

const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
const now = new Date("2030-06-01T00:00:00.000Z");
const ownerId = "11111111-1111-4111-8111-111111111111";
const photoId = "33333333-3333-4333-8333-333333333333";
const jobId = "55555555-5555-4555-8555-555555555555";

test.before(async () => {
  await applySchema(pool);
});

test.after(async () => {
  await pool.end();
});

test("redact 保留身份路径并增加缩略图、base64 和向量", async () => {
  const source = await readFile(new URL("../src/interfaces/http/auth-logger.ts", import.meta.url), "utf8");
  for (const path of [
    "req.body",
    "req.headers.authorization",
    "body",
    "password",
    "refreshToken",
    "secret",
    "accessToken",
    "originalUrl",
    "photo.originalUrl",
    "photos[*].originalUrl",
    "thumbUrl",
    "photo.thumbUrl",
    "photos[*].thumbUrl",
    "dataBase64",
    "embedding",
  ]) {
    assert.equal(source.includes(`"${path}"`), true, path);
  }
});

test("视觉异常的 message 不进入流水线日志", async () => {
  await pool.query("TRUNCATE TABLE users CASCADE");
  const users = createUserRepository(pool);
  const user: User = { id: ownerId, email: "log@example.com", passwordHash: "hash", createdAt: now };
  assert.equal(await users.insert(user), "ok");
  await pool.query(
    `INSERT INTO photos (
       id, owner_id, object_key, content_type, byte_size, tags, status, created_at, updated_at
     ) VALUES ($1, $2, $3, 'image/jpeg', 4, '{}', 'processing', $4, $4)`,
    [photoId, ownerId, `owners/${ownerId}/photos/${photoId}/original`, now],
  );
  await pool.query(
    `INSERT INTO jobs (id, type, photo_id, payload, status, run_after, created_at, updated_at)
     VALUES ($1, 'process_photo', $2, '{"step":"vision"}'::jsonb, 'pending', $3, $3, $3)`,
    [jobId, photoId, now],
  );
  const storage = createFakeObjectStorage();
  await storage.putObject({
    key: `owners/${ownerId}/photos/${photoId}/original`,
    contentType: "image/jpeg",
    body: Buffer.from("orig"),
  });
  const lines: string[] = [];
  const deps: PipelineDeps = {
    store: createPipelineStore(pool),
    storage,
    exif: createFakeExifReader(),
    thumbnail: createFakeThumbnailEncoder(),
    vision: createFakeVisionGateway({
      throwOnCall: Object.assign(new Error("SECRET-KEY X-Amz-Signature dataBase64"), { name: "VisionBoom" }),
    }),
    embed: createFakeEmbedGateway(),
    log: createPipelineLogger((line) => lines.push(line)),
    visionModel: "vision-test",
    embedModel: "embed-test",
    embedDimensions: 1536,
  };
  await runOnce(deps, now, 1);
  const text = lines.join("\n");
  assert.equal(text.includes("视觉调用失败"), true);
  assert.equal(text.includes("VisionBoom"), true);
  assert.equal(text.includes("SECRET-KEY"), false);
  assert.equal(text.includes("X-Amz-Signature"), false);
  assert.equal(text.includes("dataBase64"), false);
});
```


- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-log.test.ts
```

Expected: 退出码非 0。新 redact 路径还不在，或日志里出现了哨兵。

- [ ] **Step 3: 收紧 redact 与流水线日志**

`REDACT.paths` 在现有路径之后追加 `"thumbUrl"`、`"photo.thumbUrl"`、`"photos[*].thumbUrl"`、`"dataBase64"`、`"embedding"`。不要删旧路径。

把 `createPipelineLogger` 换成：

```typescript
const PIPELINE_LOG_KEYS = ["userId", "photoId", "objectKey", "jobId", "jobType", "step", "attempt", "errorCode", "errorName"] as const;

export function createPipelineLogger(write: (line: string) => void): PipelineLog {
  const emit = (level: "info" | "warn", message: string, fields: PipelineLogFields) => {
    const safe: Record<string, unknown> = { level, message };
    for (const key of PIPELINE_LOG_KEYS) {
      if (fields[key] !== undefined) safe[key] = fields[key];
    }
    write(JSON.stringify(safe));
  };
  return {
    info(message, fields) {
      emit("info", message, fields);
    },
    warn(message, fields) {
      emit("warn", message, fields);
    },
  };
}
```

`pipeline-log.test.ts` 的后半段要使用这个 logger，而不是测试里自己过滤字段。这样哨兵只可能从实现泄漏。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test --test-concurrency=1 apps/api/test/pipeline-log.test.ts apps/api/test/identity-auth.test.ts
```

Expected: 退出码 0。身份测试要求的旧 redact 路径仍然存在。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/interfaces/http/auth-logger.ts apps/api/src/wire-pipeline.ts apps/api/test/pipeline-log.test.ts
git commit -m "fix: 收紧流水线日志，避免密钥和签名 URL 落盘"
```


---

### Task 11: 设计第 11 节的 HTTP 集成

**Files:**
- Test: `apps/api/test/processing-pipeline.test.ts`

**Interfaces:**
- Consumes: `buildApp`、`runOnce`、`PipelineDeps`、假存储与四个假网关、`createPipelineStore`
- Produces: 一条从上传到 `ready`、重嵌入、删除的测试。不新增生产代码，除非某条断言证明前面的任务漏了行为；漏了就在本任务补上对应的那几行，不要重写整条流水线

- [ ] **Step 1: 写集成测试**

创建 `apps/api/test/processing-pipeline.test.ts`。`buildApp` 显式注入同一个 `createFakeObjectStorage()`。`runOnce` 使用这同一个存储实例。`DATABASE_URL` 缺失即失败。用 `serial` 串行。注册、单分片上传、完成的帮助函数与 Task 8 相同。

```typescript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { runOnce } from "../src/adapters/pipeline/run-once.js";
import type { PipelineDeps } from "../src/adapters/pipeline/deps.js";
import { buildApp } from "../src/app.js";
import { createPipelineStore } from "../src/dao/pipeline-store.js";
import { createFakeEmbedGateway } from "../src/gateways/embed/fake-embed.js";
import { createFakeExifReader } from "../src/gateways/exif/fake-exif-reader.js";
import { createFakeObjectStorage } from "../src/gateways/storage/fake-object-storage.js";
import { createFakeThumbnailEncoder } from "../src/gateways/thumbnail/fake-encoder.js";
import { createFakeVisionGateway } from "../src/gateways/vision/fake-vision.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";
import { ManualClock } from "./manual-clock.js";

const databaseUrl = requireDatabaseUrl();
const START = new Date("2030-07-01T00:00:00.000Z");
const clock = new ManualClock(START);
const pool = new pg.Pool({ connectionString: databaseUrl });
const storage = createFakeObjectStorage();
const vision = createFakeVisionGateway({ description: "海边", tags: ["海", "黄昏"] });
const embed = createFakeEmbedGateway({ dimensions: 1536 });
const exif = createFakeExifReader({ takenAt: new Date("2020-01-02T03:04:05.000Z"), latitude: 1.5, longitude: 2.5 });
const thumbnail = createFakeThumbnailEncoder();
const appConfig = {
  jwtSecret: "test-jwt-secret-at-least-32-bytes",
  pepper: "test-pepper-at-least-32-bytes-ok",
  accessTtlSeconds: 120,
  refreshTtlSeconds: 30 * 24 * 60 * 60,
  databaseUrl,
};
let app: Awaited<ReturnType<typeof buildApp>>;

let tail: Promise<unknown> = Promise.resolve();
function serial(name: string, fn: () => Promise<void>): void {
  test(name, () => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  });
}

function pipeline(): PipelineDeps {
  return {
    store: createPipelineStore(pool),
    storage,
    exif,
    thumbnail,
    vision,
    embed,
    log: { info() {}, warn() {} },
    visionModel: "vision-test",
    embedModel: "embed-test",
    embedDimensions: 1536,
  };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function reset(): Promise<void> {
  clock.set(START);
  storage.putObjectCalls = 0;
  storage.deletedKeys.length = 0;
  await pool.query("TRUNCATE TABLE users CASCADE");
}

async function register(email: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "correct-horse" } });
  assert.equal(response.statusCode, 201);
  return String(response.json().accessToken);
}

async function uploadAndComplete(token: string): Promise<{ sessionId: string; photoId: string }> {
  const created = await app.inject({
    method: "POST",
    url: "/photos/uploads",
    headers: auth(token),
    payload: { contentType: "image/jpeg", byteSize: 4 },
  });
  assert.equal(created.statusCode, 201);
  const body = created.json().upload;
  const part = await app.inject({
    method: "PUT",
    url: `/photos/uploads/${body.id}/parts/1`,
    headers: { ...auth(token), "content-type": "application/octet-stream" },
    payload: Buffer.from("abcd"),
  });
  assert.equal(part.statusCode, 200);
  const completed = await app.inject({
    method: "POST",
    url: `/photos/uploads/${body.id}/complete`,
    headers: auth(token),
    payload: {},
  });
  assert.equal(completed.statusCode, 201);
  return { sessionId: String(body.id), photoId: String(body.photoId) };
}

test.before(async () => {
  await applySchema(pool);
  app = await buildApp({ logger: false, config: appConfig, clock, pool, storage, signedUrlTtlSeconds: 900 });
});

test.after(async () => {
  await app.close();
  await pool.end();
});

serial("上传后 runOnce 变为 ready，详情带缩略图 URL", async () => {
  await reset();
  const token = await register("ready@example.com");
  const uploaded = await uploadAndComplete(token);
  await runOnce(pipeline(), clock.now(), 2);
  const detail = await app.inject({ method: "GET", url: `/photos/${uploaded.photoId}`, headers: auth(token) });
  assert.equal(detail.statusCode, 200);
  const photo = detail.json().photo;
  assert.equal(photo.status, "ready");
  assert.equal(photo.errorCode, null);
  assert.equal(photo.description, "海边");
  assert.deepEqual(photo.tags, ["海", "黄昏"]);
  assert.equal(typeof photo.thumbUrl, "string");
  assert.equal(typeof photo.thumbUrlExpiresAt, "string");
  assert.equal(typeof photo.originalUrl, "string");
  const row = await pool.query(`SELECT thumb_key, owner_id FROM photos WHERE id = $1`, [uploaded.photoId]);
  assert.equal(row.rows[0].thumb_key, `owners/${row.rows[0].owner_id}/photos/${uploaded.photoId}/thumb`);
  const thumb = await storage.getObject({ key: row.rows[0].thumb_key });
  assert.ok((thumb?.byteSize ?? 0) >= 1);
  const embedding = await pool.query(`SELECT model, vector_dims(embedding) AS dims FROM photo_embeddings WHERE photo_id = $1`, [uploaded.photoId]);
  assert.equal(embedding.rows[0].model, "embed-test");
  assert.equal(embedding.rows[0].dims, 1536);
});

serial("用户先写的时间和坐标留下来，空照片才补 EXIF", async () => {
  await reset();
  const token = await register("exif@example.com");
  const kept = await app.inject({
    method: "POST",
    url: "/photos/uploads",
    headers: auth(token),
    payload: { contentType: "image/jpeg", byteSize: 4 },
  });
  const keptUpload = kept.json().upload;
  await app.inject({
    method: "PUT",
    url: `/photos/uploads/${keptUpload.id}/parts/1`,
    headers: { ...auth(token), "content-type": "application/octet-stream" },
    payload: Buffer.from("abcd"),
  });
  const keptDone = await app.inject({ method: "POST", url: `/photos/uploads/${keptUpload.id}/complete`, headers: auth(token), payload: {} });
  assert.equal(keptDone.statusCode, 201);
  const patched = await app.inject({
    method: "PATCH",
    url: `/photos/${keptUpload.photoId}`,
    headers: auth(token),
    payload: { takenAt: "2019-05-01T00:00:00.000Z", latitude: 9, longitude: 8, locationText: "用户地点" },
  });
  assert.equal(patched.statusCode, 200);
  const empty = await uploadAndComplete(token);
  await runOnce(pipeline(), clock.now(), 2);
  const keptRow = await pool.query(`SELECT taken_at, latitude, longitude, location_text FROM photos WHERE id = $1`, [keptUpload.photoId]);
  assert.equal(new Date(keptRow.rows[0].taken_at).toISOString(), "2019-05-01T00:00:00.000Z");
  assert.equal(Number(keptRow.rows[0].latitude), 9);
  assert.equal(Number(keptRow.rows[0].longitude), 8);
  assert.equal(keptRow.rows[0].location_text, "用户地点");
  const emptyRow = await pool.query(`SELECT taken_at, latitude, longitude, location_text FROM photos WHERE id = $1`, [empty.photoId]);
  assert.equal(new Date(emptyRow.rows[0].taken_at).toISOString(), "2020-01-02T03:04:05.000Z");
  assert.equal(Number(emptyRow.rows[0].latitude), 1.5);
  assert.equal(Number(emptyRow.rows[0].longitude), 2.5);
  assert.equal(emptyRow.rows[0].location_text, null);
});

serial("只写标签时视觉可以填描述，两个都写了则不调用视觉", async () => {
  await reset();
  const token = await register("tags@example.com");
  const tagged = await app.inject({
    method: "POST",
    url: "/photos/uploads",
    headers: auth(token),
    payload: { contentType: "image/jpeg", byteSize: 4 },
  });
  const taggedBody = tagged.json().upload;
  await app.inject({
    method: "PUT",
    url: `/photos/uploads/${taggedBody.id}/parts/1`,
    headers: { ...auth(token), "content-type": "application/octet-stream" },
    payload: Buffer.from("abcd"),
  });
  const taggedDone = await app.inject({ method: "POST", url: `/photos/uploads/${taggedBody.id}/complete`, headers: auth(token), payload: {} });
  assert.equal(taggedDone.statusCode, 201);
  const tagPatch = await app.inject({
    method: "PATCH",
    url: `/photos/${taggedBody.photoId}`,
    headers: auth(token),
    payload: { tags: ["用户标签"] },
  });
  assert.equal(tagPatch.statusCode, 200);
  const both = await uploadAndComplete(token);
  const bothPatch = await app.inject({
    method: "PATCH",
    url: `/photos/${both.photoId}`,
    headers: auth(token),
    payload: { description: "用户描述", tags: ["自己的"] },
  });
  assert.equal(bothPatch.statusCode, 200);
  const callsBefore = vision.calls;
  await runOnce(pipeline(), clock.now(), 2);
  const taggedRow = await pool.query(`SELECT description, tags FROM photos WHERE id = $1`, [taggedBody.photoId]);
  assert.equal(taggedRow.rows[0].description, "海边");
  assert.deepEqual(taggedRow.rows[0].tags, ["用户标签"]);
  const bothRow = await pool.query(`SELECT description, tags FROM photos WHERE id = $1`, [both.photoId]);
  assert.equal(bothRow.rows[0].description, "用户描述");
  assert.deepEqual(bothRow.rows[0].tags, ["自己的"]);
  assert.equal(vision.calls, callsBefore + 1);
});

serial("ready 后修改描述会重嵌入，失败且没有缩略图时不升为 ready", async () => {
  await reset();
  const token = await register("reembed@example.com");
  const uploaded = await uploadAndComplete(token);
  await runOnce(pipeline(), clock.now(), 2);
  const before = await pool.query(`SELECT embedding::text AS embedding FROM photo_embeddings WHERE photo_id = $1`, [uploaded.photoId]);
  const calls = vision.calls;
  const changed = await app.inject({
    method: "PATCH",
    url: `/photos/${uploaded.photoId}`,
    headers: auth(token),
    payload: { description: "改过的描述" },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().photo.status, "ready");
  await runOnce(pipeline(), clock.now(), 2);
  const after = await pool.query(`SELECT embedding::text AS embedding FROM photo_embeddings WHERE photo_id = $1`, [uploaded.photoId]);
  assert.notEqual(after.rows[0].embedding, before.rows[0].embedding);
  assert.equal(vision.calls, calls);

  await pool.query(`UPDATE photos SET status = 'failed', error_message = 'thumbnail_failed', thumb_key = NULL WHERE id = $1`, [uploaded.photoId]);
  await pool.query(`UPDATE jobs SET status = 'done' WHERE photo_id = $1`, [uploaded.photoId]);
  await app.inject({
    method: "PATCH",
    url: `/photos/${uploaded.photoId}`,
    headers: auth(token),
    payload: { description: "失败后的描述" },
  });
  await runOnce(pipeline(), clock.now(), 2);
  const stayed = await pool.query(`SELECT status FROM photos WHERE id = $1`, [uploaded.photoId]);
  assert.equal(stayed.rows[0].status, "failed");
});

serial("有缩略图的失败照片在重嵌入成功后变为 ready，删除会级联任务和向量", async () => {
  await reset();
  const token = await register("delete@example.com");
  const uploaded = await uploadAndComplete(token);
  await runOnce(pipeline(), clock.now(), 2);
  await pool.query(`UPDATE photos SET status = 'failed', error_message = 'embed_rejected' WHERE id = $1`, [uploaded.photoId]);
  await pool.query(`UPDATE jobs SET status = 'done' WHERE photo_id = $1`, [uploaded.photoId]);
  await app.inject({
    method: "PATCH",
    url: `/photos/${uploaded.photoId}`,
    headers: auth(token),
    payload: { description: "补嵌入" },
  });
  await runOnce(pipeline(), clock.now(), 2);
  const ready = await pool.query(`SELECT status, error_message FROM photos WHERE id = $1`, [uploaded.photoId]);
  assert.equal(ready.rows[0].status, "ready");
  assert.equal(ready.rows[0].error_message, null);
  const removed = await app.inject({ method: "DELETE", url: `/photos/${uploaded.photoId}`, headers: auth(token) });
  assert.equal(removed.statusCode, 204);
  const embeddings = await pool.query(`SELECT count(*)::int AS n FROM photo_embeddings WHERE photo_id = $1`, [uploaded.photoId]);
  const jobs = await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE photo_id = $1`, [uploaded.photoId]);
  assert.equal(embeddings.rows[0].n, 0);
  assert.equal(jobs.rows[0].n, 0);
  const owner = await pool.query(`SELECT owner_id FROM photos WHERE id = $1`, [uploaded.photoId]);
  assert.equal(owner.rowCount, 0);
  assert.equal(storage.deletedKeys.some((key) => key.endsWith("/original")), true);
  assert.equal(storage.deletedKeys.some((key) => key.endsWith("/thumb")), true);
});

serial("不设置视觉和嵌入变量时仍能完成 Phase 2 上传", async () => {
  await reset();
  const source = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  assert.equal(source.includes("VISION_"), false);
  assert.equal(source.includes("EMBED_"), false);
  assert.equal(source.includes("PIPELINE_"), false);
  const token = await register("novision@example.com");
  const uploaded = await uploadAndComplete(token);
  assert.equal(typeof uploaded.photoId, "string");
});
```

照片行在上传完成之后才存在。断言里的 PATCH 都发生在 `complete` 返回之后、`runOnce` 之前。不要对还不存在的 `photoId` 调用 PATCH。

- [ ] **Step 2: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test --test-concurrency=1 apps/api/test/processing-pipeline.test.ts
```

Expected: 退出码 0，`# fail 0`。若「只写标签」的视觉调用次数不是 1，检查那张照片在完成前标签已经非空、描述仍为空，并且另一张两个字段都有值。

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/processing-pipeline.test.ts
git commit -m "test: 覆盖处理流水线的上传、重嵌入与删除"
```

若为了让断言通过改了生产代码，把那些文件一起放进同一次提交。

---

### Task 12: 边界检查与阶段完成

**Files:**
- Modify: `scripts/check-layer-boundaries.mjs`
- Modify: `apps/api/test/library-boundaries.test.ts`
- Modify: `specs/phases/03-processing-pipeline.md`
- Modify: `specs/SPEC.md`

**Interfaces:**
- Consumes: Task 11 的集成测试已经通过
- Produces: `domainPackages` 含 `sharp` 与 `exifr`。阶段规格状态 `done`，六条验收框勾上。`specs/SPEC.md` 阶段 3 为 `done`

这个任务只有在下面的三条命令都成功之后才能改阶段状态。测试失败时不要把状态改成 `done`。

- [ ] **Step 1: 扩展边界扫描**

`scripts/check-layer-boundaries.mjs` 的 `domainPackages` 里，`"undici"` 那一项后面增加两项。不要从名单里删掉已有的包。改完后这一段是：

```javascript
  "undici",
  "sharp",
  "exifr",
  "http",
```

把 `apps/api/test/library-boundaries.test.ts` 整文件换成：

```typescript
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const apiRoot = path.join(repoRoot, "apps/api");
const boundaryScriptPath = path.join(repoRoot, "scripts/check-layer-boundaries.mjs");

async function readAllTypeScriptSources(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  let combined = "";
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      combined += await readAllTypeScriptSources(full);
    } else if (entry.name.endsWith(".ts")) {
      combined += await readFile(full, "utf8");
    }
  }
  return combined;
}

test("个人库 domain 与 adapters 源码边界", async () => {
  const domainSource = await readAllTypeScriptSources(path.join(apiRoot, "src/domain/library"));
  const libraryAdapters = await readAllTypeScriptSources(path.join(apiRoot, "src/adapters/library"));
  const pipelineAdapters = await readAllTypeScriptSources(path.join(apiRoot, "src/adapters/pipeline"));
  const markers = ["@aws-sdk/", "aws-sdk", "minio", "sharp", "exifr", "undici"] as const;

  for (const marker of markers) {
    assert.equal(domainSource.includes(marker), false, `domain/library 不得出现 ${marker}`);
    assert.equal(libraryAdapters.includes(marker), false, `adapters/library 不得出现 ${marker}`);
    assert.equal(pipelineAdapters.includes(marker), false, `adapters/pipeline 不得出现 ${marker}`);
  }

  assert.equal(/Date\.now|new Date\(\)/.test(domainSource), false, "domain/library 不得直接读取系统时钟");
  assert.equal(domainSource.includes("domain/identity"), false, "domain/library 不得引用 identity 包");
  for (const source of [libraryAdapters, pipelineAdapters]) {
    assert.equal(/\/dao/.test(source), false, "adapters 不得 import dao");
    assert.equal(/\/gateways/.test(source), false, "adapters 不得 import gateways");
  }

  const boundaryScript = await readFile(boundaryScriptPath, "utf8");
  assert.equal(boundaryScript.includes('"aws-sdk"'), true);
  assert.equal(boundaryScript.includes('"minio"'), true);
  assert.equal(boundaryScript.includes("@aws-sdk/"), true);
  assert.equal(boundaryScript.includes('"sharp"'), true);
  assert.equal(boundaryScript.includes('"exifr"'), true);
});
```

不要在 `domain/library`、`adapters/library`、`adapters/pipeline` 的注释里写下 `sharp`、`exifr`、`undici` 或 `@aws-sdk/`。需要说明时写「图像解码库」「EXIF 解析库」「HTTP 客户端」「对象存储 SDK」。

- [ ] **Step 2: 跑验收命令**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npm test
npx tsc -p apps/api/tsconfig.json --noEmit
npm run build -w apps/api
```

Expected: `npm test` 先打印 `分层边界检查通过`，然后 API 测试 `# fail 0`，退出码 0。`tsc` 与 `build` 退出码 0。身份测试和 `GET /health` 在不配置 `S3_*`、`VISION_*`、`EMBED_*` 时仍然通过。

- [ ] **Step 3: 勾上阶段验收**

`specs/phases/03-processing-pipeline.md` 的状态行改为：

```markdown
**状态：** done
```

验收列表改为：

```markdown
- [x] 上传后的照片最终变为 `ready` 或在外部 API 失败时变为 `failed`，原图仍可访问
- [x] `ready` 的照片具备缩略图、描述或标签（模型有返回时）、以及一条嵌入
- [x] 嵌入维度与配置一致，不匹配时任务失败并可观察错误，而不是写坏向量列
- [x] 覆盖描述或标签后能再次嵌入
- [x] worker 不向日志打印 API Key、对象存储密钥或口令
- [x] 领域层边界检查仍然通过
```

不要修改设计文件开头的「状态：已定稿（待实现）」。

`specs/SPEC.md` 阶段 3 那一行改为：

```markdown
| 3 | [phases/03-processing-pipeline.md](phases/03-processing-pipeline.md) | done | EXIF、缩略图、视觉描述、嵌入、任务 |
```

不要勾选「任何阶段的完成定义」那一组模板复选框。

- [ ] **Step 4: Commit**

```bash
git add scripts/check-layer-boundaries.mjs apps/api/test/library-boundaries.test.ts specs/phases/03-processing-pipeline.md specs/SPEC.md
git commit -m "docs: 将 Phase 3 状态标记为 done"
```

---

## 自检（计划作者已完成，实现时不要重做这一节）

实现代理跳过本节。下列是写计划时对照设计合同的覆盖记录。

| 设计 | 落点 | 结论 |
|------|------|------|
| §2 `process_photo` 单 job 四步，`reembed` 只嵌入 | Global Constraints；Task 7 `runClaimed` | 已覆盖 |
| §2 同事务入队、`failed` 后再 complete 不入队、`completing` 不入队 | Task 3 插入；Task 8 `ensureProcessPhoto` 与 completing 测试 | 已覆盖 |
| §2 PATCH 语义变化才 `reembed` | Task 2 `semanticChanged`；Task 8 `patchPhoto` | 已覆盖 |
| §2 retry、attempts、30/60/120/240、终态码 | Task 2 `failureDisposition`；Task 3 `retryJob` / `failJob`；Task 7 | 已覆盖 |
| §2 `interrupted` 不覆盖业务码、不入库 | Task 3 `reclaimExpired`；Task 7 第 8 条 | 已覆盖 |
| §4.3 EXIF 只补空、不成对不写、不写地点 | Task 2 `exifFill`；Task 5 无偏移 UTC；Task 11 | 已覆盖 |
| §4.5 视觉归一化、截断 4000、标签 32 | Task 2 | 已覆盖 |
| §4.5 `embeddingInput` 与字面量 `photo` | Task 2 | 已覆盖 |
| §5.5 缩略图键、JPEG、长边 512、质量 80 | Task 2 `thumbObjectKey`；Task 5 `sharp` 参数 | 已覆盖 |
| §7.5 `EMBED_DIMENSIONS=1536`，领域与 DAO 各挡一次 | Task 6 配置；Task 2 `checkEmbedding`；Task 3 `formatVectorLiteral` | 已覆盖 |
| §3.4 / §9 假网关、production 占位符 exit 1、API 只在 S3 占位符退出 | Task 6；Task 9 `worker.ts` 与 `index.ts` | 已覆盖 |
| §10 日志红线、thumbUrl / dataBase64 / embedding | Task 10 | 已覆盖 |
| §3 领域不引用 sharp / exifr | Task 12 禁止名单与源码扫描 | 已覆盖 |
| §11 第 1、11 条 | Task 8 | 已覆盖 |
| §11 第 2、3、4、9、10、12 条 | Task 11，底层步骤在 Task 7 | 已覆盖 |
| §11 第 5、6、7、8、15、16、18 条 | Task 7 | 已覆盖 |
| §11 第 13 条 | Task 6；Task 11 断言 `buildApp` 不读视觉变量 | 已覆盖 |
| §11 第 14 条 | Task 10 | 已覆盖 |
| §11 第 17 条 | Task 12 | 已覆盖 |
| §12 不做搜索、共享册、人脸、网页、Redis、HNSW、清扫上传会话 | Global Constraints，无对应实现任务 | 已覆盖 |
| §13 六条阶段验收 | Task 12 才勾选 | 已覆盖 |
| 子代理使用 Composer 2.5，不用 fast | Global Constraints 与执行交接 | 已覆盖 |

文本在嵌入返回后发生变化时，Task 7 的 `commitEmbedding` 计划函数返回 `text_changed`，随后 `releaseRunning` 把 `attempts` 减 1。`process_photo` 在缩略图键为空时退回 `thumbnail`，同一次尝试里继续，不把 job 放回 `pending`。

占位符扫描：计划正文的实现步骤都已展开成可照抄的代码。`runOnce`、`PipelineDeps`、`ensureProcessPhoto`、`formatVectorLiteral`、`loadPipelineConfig`、`PhotoResponse.errorCode` 在前后任务里的名字一致。

## 执行交接

计划保存在 `docs/superpowers/plans/2026-11-06-openalbum-phase3-processing-pipeline.md`。实现时二选一：

1. **Subagent-Driven（推荐）**：每个任务一个新的子代理，任务之间做审查。子代理使用 Composer 2.5，不用 fast 模式。所需技能是 `superpowers:subagent-driven-development`。
2. **Inline Execution**：在同一会话里按 `superpowers:executing-plans` 批量执行，并在检查点停下来审查。

写这份计划的提交不实现处理流水线代码。
