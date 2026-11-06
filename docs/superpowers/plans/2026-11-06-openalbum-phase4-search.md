# OpenAlbum Phase 4 — 检索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主人用 `POST /photos/search` 在自己的个人库里按关键词或自然语言检索，只返回本人 `ready` 照片，并带上与列表相同的签名 URL 和始终出现的 `score`。

**Architecture:** 纯规则放在 `domain/search`，该目录不 import `domain/library`。`adapters/search` 编排一次嵌入、检索端口和 `toPhotoResponse`。SQL 只在 `dao/search-repository.ts`。语义检索复用 Phase 3 的 `EmbedGateway` 与 `formatVectorLiteral`，不新建视觉网关，也不建 HNSW / IVFFlat。

**Tech Stack:** Node/TS, Fastify, pg, pgvector, 现有假嵌入与假对象存储, docker postgres, node:test

## Global Constraints

下列约束每个任务都要遵守。数值与硬规则抄自 [`docs/superpowers/specs/2026-11-06-openalbum-phase4-search-design.md`](../specs/2026-11-06-openalbum-phase4-search-design.md) 与 [`specs/phases/04-search.md`](../../../specs/phases/04-search.md)。未写进该设计的行为不得自行补充。

- 路径只有 `POST /photos/search`。不注册 `GET /photos/search`，不读查询字符串。查询字符串上任何一个参数都是 400 `validation_error`，文案「请求不合法」。
- 正文必填字符串 `mode`：`keyword` 或 `semantic`。没有默认值。必填字符串 `q`。`String.prototype.trim` 之后长度为 0 是 400 `empty_query`，文案「查询为空」。长度按 UTF-16 码元，大于 500 是 400 `query_too_long`，文案「查询过长」。等于 500 合法。`q` 缺失或不是字符串是 400 `validation_error`，文案「请求不合法」，不是「查询为空」。中间空白保留。不因为控制字符拒绝 `q`。过滤器不能代替 `q`。
- 未知键一律 `invalid_body`，包括 `semantic`、`topK`、`offset`、`image`、`albumId`、`ownerId`、`sort`、`threshold`。正文是数组、`null`、字符串或数字时由路由映射为 400 `validation_error`，文案「请求不合法」，不进入领域函数，也不落到现有错误处理的 500「服务器错误」。
- 关键词：整段 trim 后的 `q` 是一个字面子串，不分词，不按空白拆开。`keywordPattern` 先把 `\` 换成 `\\`，再把 `%` 换成 `\%`，再把 `_` 换成 `\_`，然后两端加 `%`。DAO 使用 `ILIKE $pattern ESCAPE '\'`（JavaScript 模板字面量写成 `ESCAPE '\\'`，发出去的 SQL 是一个反斜杠）。描述 `ILIKE` 或任一标签 `ILIKE`，二者 OR。不匹配 `location_text`、`content_type`、`error_message`、对象键或用户 id。ASCII 大小写由 `ILIKE` 折叠。验收不断言非 ASCII 折叠。
- 可选 `tags`：省略或 `[]` 变成 `tags: null`。非空时与 Phase 2 PATCH 标签规则相同，大小写敏感，去重并保留第一次出现的顺序，最多 32 个，trim 后长度 1–64，拒绝 U+0000–U+001F 与 U+007F。`null` 不是合法值。过滤是 `photos.tags @> $tags::text[]`（AND）。`tags === null` 表示不加标签条件，不用空数组。
- 可选 `takenFrom`、`takenTo`：时刻正则 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$`，并且 `new Date` 不是 Invalid Date。闭区间，作用在 `taken_at`。任一端出现时 `taken_at` 为空的行排除。两端都空则不看 `taken_at`。`takenFrom > takenTo` 为 400 `validation_error`，文案「时间范围不合法」。相等合法。键存在而值为 `null`、数字或其他类型是 `invalid_time`，文案「拍摄时间不合法」。
- 可选 `status`：省略或字符串 `"ready"` 都只检索 `ready`。`processing`、`failed`、`null`、数组以及其他任何值是 `invalid_body`。结果里不会出现非 `ready` 行。`GET /photos` 仍返回三种状态，元素不增加 `score`。
- `limit` 省略为 50。必须是 JSON 整数且 `Number.isInteger` 为真，闭区间 1 到 100。字符串、小数、`null` 为 `invalid_body`。没有独立 `topK`，没有相似度阈值，不用 offset。DAO 收到的 `limit` 是页面大小加 1。返回前 `limit` 条。没有第 `limit + 1` 条时 `nextCursor` 为 `null`。游标用本页最后一条，不用多取的那一条。空结果是 `"photos": []` 与 `"nextCursor": null`，HTTP 200。
- 关键词排序 `created_at DESC, id DESC`。键集是 `(created_at, id)` 严格小于游标中的一对。明文 `k\n<createdAt ISO>\n<uuid>`。`createdAt ISO` 是 `createdAt.toISOString()`，必须匹配上面的时刻正则。语义排序是第 4.4 节的 round 表达式 `DESC`，然后 `id ASC`。键集是分数严格小于游标分数，或分数相等且 `id` 大于游标 id。明文 `s\n<score_text>\n<uuid>`。两种游标都是无填充的 base64url（不含 `=`），UTF-8。uuid 匹配 `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`，解码后转成小写。这两条正则写在 `domain/search`，不 import `domain/library/cursor.ts`。模式字母必须等于本次 `mode`，否则 `invalid_body`。游标不编码过滤器。别人的照片 id 拼出来的游标仍然加上 `owner_id`。
- `score_text` 必须匹配 `^-?(?:0|[1-9]\d*)\.\d{6}$`，并且拒绝字面量 `-0.000000`。`00.100000` 非法。对不上时这次请求 500 `internal_error`，文案「服务器错误」，不返回这一页。JSON 的 `score` 是 `Number(score_text)`。游标继续使用 `score_text`，禁止用 JSON 数字再 `toFixed`。关键词的 `score` 为 `null`。`score` 键始终出现。
- 语义 SQL 固定使用余弦距离 `<=>` 和 `round((1 - (photo_embeddings.embedding <=> $vector::vector))::numeric, 6)`。不用 `<->`，不用 `<#>`。不按 `photo_embeddings.model` 过滤。不设阈值。`score` 可以为负。
- 每条 SQL 都带 `owner_id = 当前用户的 userId`。JWT 与 API Key 等价。不因为 `credentialKind` 返回 403。不读 `albums`、`album_members`、`album_photos`。语义再 `INNER JOIN photo_embeddings`。`processing` 与 `failed` 即使已有向量也不是命中。没有嵌入行的 `ready` 照片可以出现在关键词结果里，不会出现在语义结果里。
- 查询文本 trim 之后原样交给 `EmbedGateway.embed({ model, text })`。不调用 `embeddingInput`，不把空查询改写成 `photo`。请求路径只调用一次嵌入，不睡眠，不套用 worker 的 5 次退避。本路由不返回 429。
- 未注入嵌入网关：语义 503 `embed_unavailable`，文案「嵌入暂不可用」，不查询向量。关键词仍可用。注入了网关但 `embedModel` 缺失或 trim 后空白：502 `embed_rejected`，文案「嵌入被拒绝」，调用次数为 0。网关 `embed_unavailable` 为 503；`embed_rejected` 为 502。`checkEmbedding(values, 1536)` 失败，或 DAO `formatVectorLiteral` 抛出 `name` 为 `DimensionMismatch` / `InvalidEmbedding`（含绝对值大于等于 `1e21`），都是 502 `embed_rejected`。不把异常 `message`、上游正文、向量、维度数字或查询文本写进响应。日志里的 `errorCode` 用 `embed_unavailable`、`embed_rejected`、`dimension_mismatch`、`invalid_embedding`。HTTP 的 `error.code` 不直接暴露 `dimension_mismatch`。
- 生产占位符（`NODE_ENV` trim 后等于 `production`，且嵌入侧命中 `https://YOUR_EMBED_API_BASE`、`YOUR_EMBED_API_KEY`、`YOUR_EMBED_MODEL` 或对应空白；比较前只 trim，基址还去掉末尾斜杠）不让 API `exit`。`console.error` 的固定文案是 `嵌入配置仍是占位符，语义检索不可用`。不构造假网关，`buildApp` 不接收 `embed`。同一占位符下 `loadPipelineConfig` 仍然失败，文案仍然是 `嵌入配置仍是占位符`，`exitCode` 为 1。不得把 worker 改成占位也继续跑。非 production 占位构造 `createFakeEmbedGateway({ dimensions: 1536 })`，模型名空白时用 `fake`，否则用 trim 后的模型字符串，INFO 文案 `嵌入网关使用假实现`。合法 HTTP 配置 INFO 文案 `嵌入网关使用 HTTP`。两条 INFO 不出现密钥、完整基址和模型字符串。
- `buildApp` 不读 `EMBED_*`、`NODE_ENV`、`VISION_*`、`PIPELINE_*`。`apps/api/src/app.ts` 源码不得出现子串 `EMBED_`、`VISION_`、`PIPELINE_`。未传入 `embed` 时语义检索 503。测试注入的假网关不看 `NODE_ENV`。漏注入不得偷偷改成假网关。
- API 加载函数只读取 `EMBED_PROVIDER`、`EMBED_API_BASE_URL`、`EMBED_API_KEY`、`EMBED_MODEL`、`EMBED_TIMEOUT_MS`、`EMBED_DIMENSIONS` 和 `NODE_ENV`。维度、超时、provider、基址语法不合法时 `console.error` Phase 3 的对应文案并 `exit 1`，不 `listen`。`EMBED_DIMENSIONS` 空白是 `EMBED_DIMENSIONS 缺失`，非整数是 `EMBED_DIMENSIONS 无效`，其他整数是 `EMBED_DIMENSIONS 与向量列不一致`。超时空白为 30000，闭区间 1000 到 120000，否则 `EMBED_TIMEOUT_MS 无效`。provider 只接受空白或 `http`。基址非空但带 userinfo 或不是合法 `http`/`https` URL 时文案 `EMBED_API_BASE_URL 无效`，且文案不含用户信息。不读取 `VISION_*` 与 `PIPELINE_*`，这两侧非法不得让 API 加载函数失败。
- 本阶段不改 `photos` 与 `photo_embeddings` 的列，不创建索引，不执行 `CREATE INDEX ... USING hnsw` 或 `ivfflat`，不添加 `pg_trgm`。`deploy/db/schema.sql` 只允许替换 `photo_embeddings` 表定义下方那一行旧注释。`deploy/env.example` 不增加变量，只给已有 `EMBED_*` 补注释。应用不读取行数来切换计划，不设对应环境变量。HNSW 草案（`m = 16`，`ef_construction = 64`，`vector_cosine_ops`）只写在注释里指向设计第 7 节，不写成可执行语句。门槛是全表嵌入行数大于等于 100000，或语义检索数据库侧 p95 大于 200 毫秒且该用户 `ready` 照片大于等于 10000。那次后续提交才能建索引，本计划的任何任务都不建。
- 签名复用 `toPhotoResponse`。任一条签名失败：整次请求 500 `storage_error`，文案「对象存储不可用」，不返回缺 URL 的半截列表。`ready` 照片的 `thumb_key` 按 Phase 3 非空；若行为空，`thumbUrl` 与 `thumbUrlExpiresAt` 为 `null`，不因此把该行从关键词结果去掉。响应不包含 `objectKey`、`thumbKey`、`sourceUserId`、`sourceKeyId`、`errorMessage`、嵌入向量、`model`、距离原始值。
- 持有数据库连接期间不做嵌入 HTTP，也不做签名。嵌入在 SQL 之前。签名在 SQL 之后。检索用例不写 `photos`、`photo_embeddings`、`jobs`，也不写身份表。API Key 的 `last_used_at` 仍由现有身份解析更新，且只更新一次。
- 先鉴权，再解析正文。未授权时不返回正文校验错误。401 `unauthorized`，文案「未授权」。错误外壳是 `{ "error": { "code", "message" } }`。
- 检索失败日志只许带 `userId`、`mode`、`errorCode`，外加静态中文「嵌入调用失败」或「嵌入结果无效」。不记录 `q`、向量、`score_text`、签名 URL、`Authorization`、API Key。对象存储失败沿用照片库已有字段：`userId`、`photoId`、`objectKey`、`errorName`，静态中文「对象存储失败」。不得把 redact 名单里已有的 `req.body`、`embedding`、`originalUrl`、`thumbUrl` 删掉。不必把 `photos[*].score` 加入 redact，本阶段也不要加。
- `domain/search` 不 import `domain/library`、`domain/identity`、`domain/album`、DAO、网关、`pg`、`fastify`、`undici`，以及 `node:http` / `node:https`。领域层不发 HTTP、不写 SQL、不调用 `fetch`。`adapters/search` 只从照片库适配层 import `adapters/library/photo-response.js`。`adapters/library` 不 import `adapters/search`。适配层源码不得出现 `/dao` 与 `/gateways`。不修改 `scripts/check-layer-boundaries.mjs`。不引入新的 npm 依赖。不改 `apps/web`。不改 `GET /photos` 的过滤、排序和响应字段。
- 明确不做：共享册内搜索、跨用户公开搜、以图搜图、网页、人脸、查询语法、按 `model` 过滤、检索时重嵌入、应用层限流、在 CVM 上加载嵌入模型、把 `processing` 或 `failed` 放进结果。
- 新测试放在 `apps/api/test/`，使用 `node:test` 与 `tsx`。需要数据库的测试使用真实 PostgreSQL，`DATABASE_URL` 缺失时失败，不跳过。`npm test` 已是 `node scripts/check-layer-boundaries.mjs && npm run test -w apps/api`，API 测试 `--test-concurrency=1`。不要改回并行。单文件命令也带上 `--test-concurrency=1`。
- 按任务编号顺序执行。后一个任务假设前一个任务已经提交。不要提前实现后续任务的路由或 SQL。
- 实现本计划时，子代理使用 Composer 2.5，不使用 fast 模式。
- 设计文件开头的「状态：已定稿（待实现）」不要改。阶段状态只按本计划 Task 1 与 Task 9 更新。写这份计划的提交不实现检索代码，也不改阶段状态。

**开工前阅读：**

- `docs/superpowers/specs/2026-11-06-openalbum-phase4-search-design.md`
- `specs/phases/04-search.md`
- `specs/SPEC.md`
- `specs/domain/overview.md`
- `docs/superpowers/specs/2026-11-06-openalbum-phase3-processing-pipeline-design.md`
- `docs/superpowers/plans/2026-11-06-openalbum-phase3-processing-pipeline.md`
- `apps/api/src/domain/search/index.ts`
- `apps/api/src/domain/library/cursor.ts`
- `apps/api/src/domain/library/pipeline.ts`
- `apps/api/src/domain/library/ports.ts`
- `apps/api/src/dao/photo-repository.ts`
- `apps/api/src/dao/vector-literal.ts`
- `apps/api/src/gateways/embed/config.ts`
- `apps/api/src/gateways/embed/fake-embed.ts`
- `apps/api/src/gateways/embed/deterministic.ts`
- `apps/api/src/adapters/library/photo-response.ts`
- `apps/api/src/adapters/library/list-photos.ts`
- `apps/api/src/interfaces/http/register-photos.ts`
- `apps/api/src/interfaces/http/auth-logger.ts`
- `apps/api/src/app.ts`
- `apps/api/src/index.ts`
- `apps/api/src/worker.ts`
- `apps/api/test/pipeline-worker.test.ts`
- `apps/api/test/processing-pipeline.test.ts`
- `scripts/check-layer-boundaries.mjs`
- `deploy/db/schema.sql`
- `deploy/env.example`

**开工前命令：** 下文所有命令都在仓库根目录执行。

```bash
npm install
docker compose up -d
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
```

`node --import tsx` 依赖 `npm install` 把 `tsx` 提升到仓库根的 `node_modules`。单文件命令都写成 `node --import tsx --test --test-concurrency=1 <文件>`。

---

## File Structure

| 路径 | 职责 |
|------|------|
| `deploy/db/schema.sql` | 只替换 `photo_embeddings` 下方那一行旧注释。不建索引，不改列 |
| `deploy/env.example` | 给已有 `EMBED_*` 补「API 也读取」的注释。不新增变量，不改占位符原文 |
| `specs/SPEC.md` | Task 1 把阶段 4 改为 `in_progress`；只有 Task 9 改为 `done` |
| `specs/phases/04-search.md` | Task 1 把状态改为 `in_progress` 且不勾验收；只有 Task 9 改为 `done` 并勾上验收 |
| `apps/api/src/domain/search/cursor.ts` | 关键词与语义游标的编码、解码、`isScoreText` |
| `apps/api/src/domain/search/query.ts` | `parseSearchBody`、`keywordPattern` |
| `apps/api/src/domain/search/ports.ts` | `SearchPhoto`、`SearchHit`、`SearchPort` |
| `apps/api/src/domain/search/index.ts` | 保留 `SEARCH_CONTEXT`，导出上述符号 |
| `apps/api/src/dao/photo-repository.ts` | 导出已有的 `PHOTO_COLUMNS`。不改列表 SQL |
| `apps/api/src/dao/search-repository.ts` | `createSearchRepository`：关键词 `ILIKE` 与语义余弦 |
| `apps/api/src/dao/index.ts` | 导出 `createSearchRepository` |
| `apps/api/src/adapters/search/messages.ts` | 检索错误码与中文文案 |
| `apps/api/src/adapters/search/deps.ts` | `SearchDeps`、`SearchLog`、`SearchSigningDeps` |
| `apps/api/src/adapters/search/search-photos.ts` | `searchPhotos` |
| `apps/api/src/gateways/embed/config.ts` | `embedCredentialsArePlaceholder`、`loadApiEmbedConfig`。`loadPipelineConfig` 的生产占位退出保持不变 |
| `apps/api/src/wire-search.ts` | 组合根装配检索端口与日志。禁止移入五层目录 |
| `apps/api/src/interfaces/http/send-search-result.ts` | 把 `SearchResult` 写成 JSON |
| `apps/api/src/interfaces/http/register-photos.ts` | `POST /photos/search`：先鉴权，再读原始正文 |
| `apps/api/src/interfaces/http/error-handler.ts` | 仅这个路径上逃逸的 400/415 收成「请求不合法」，避免 500 |
| `apps/api/src/app.ts` | 可选 `embed` 与 `embedModel`。源码不出现 `EMBED_` |
| `apps/api/src/index.ts` | 对象存储检查通过后加载嵌入配置。生产占位不退出 |
| `apps/api/src/adapters/index.ts` | 导出 `searchPhotos` 与 `SearchDeps` |
| `apps/api/test/search-schema.test.ts` | 注释、环境示例、阶段开工状态。连接数据库只为确认没有 hnsw 索引 |
| `apps/api/test/search-rules.test.ts` | 纯规则，不连接数据库 |
| `apps/api/test/search-dao.test.ts` | 关键词与语义 SQL，真实 PostgreSQL |
| `apps/api/test/search-usecase.test.ts` | 用例编排，注入端口与假嵌入，不连接数据库 |
| `apps/api/test/search-config.test.ts` | API 嵌入加载与 worker 占位符退出，不连接数据库 |
| `apps/api/test/search-http.test.ts` | 鉴权顺序、查询字符串、非对象正文 |
| `apps/api/test/search-fixtures.ts` | 集成测试的插行、注册与 API Key |
| `apps/api/test/search.test.ts` | 设计第 10 节的集成断言 |
| `apps/api/test/library-boundaries.test.ts` | 追加检索源码边界。不改分层脚本 |
| `apps/api/test/pipeline-worker.test.ts` | 去掉「API 源码不得出现 `EMBED_`」。改为断言 `loadApiEmbedConfig` 与固定中文，并且仍然没有 `VISION_` / `PIPELINE_` |

不创建 `apps/web` 下的文件，不新增 npm 依赖，不修改 `scripts/check-layer-boundaries.mjs`，不修改 `apps/api/src/worker.ts`。

---

### Task 1: 索引注释、嵌入环境注释与阶段开工

**Files:**
- Modify: `deploy/db/schema.sql`（`photo_embeddings` 表定义下方那一行注释）
- Modify: `deploy/env.example`（`# --- 嵌入 ---` 到 `EMBED_DIMENSIONS=1536` 这一段的注释）
- Modify: `specs/SPEC.md`（阶段 4 那一行的状态）
- Modify: `specs/phases/04-search.md`（状态行）
- Test: `apps/api/test/search-schema.test.ts`

**Interfaces:**
- Consumes: 现有 `applySchema` 会执行整个 `deploy/db/schema.sql`。`photo_embeddings.embedding` 已是 `vector(1536)`。环境示例里的占位赋值行必须保持逐字不变
- Produces: `schema.sql` 不再包含 `数据量上来之后再加 IVFFlat / HNSW（Phase 4）。`，改为下面 Step 3 的注释，且全文件不出现 `USING hnsw` 与 `ivfflat`。`specs/SPEC.md` 阶段 4 为 `in_progress`。`specs/phases/04-search.md` 状态为 `in_progress`，五条验收仍是 `- [ ]`。设计文件状态行仍是 `已定稿（待实现）`

- [ ] **Step 1: 写会失败的结构测试**

创建 `apps/api/test/search-schema.test.ts`：

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

test("schema 只改嵌入索引注释，不创建 hnsw 或 ivfflat", async () => {
  const schema = await readFile(new URL("../../../deploy/db/schema.sql", import.meta.url), "utf8");
  assert.equal(schema.includes("数据量上来之后再加 IVFFlat / HNSW（Phase 4）。"), false);
  assert.match(schema, /本阶段不建 ANN 索引/);
  assert.match(schema, /100000/);
  assert.match(schema, /200 毫秒/);
  assert.match(schema, /10000/);
  assert.match(schema, /m = 16/);
  assert.match(schema, /ef_construction = 64/);
  assert.match(schema, /2026-11-06-openalbum-phase4-search-design\.md/);
  assert.equal(/using\s+hnsw/i.test(schema), false);
  assert.equal(/ivfflat/i.test(schema), false);

  const indexes = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'photo_embeddings'`,
  );
  const joined = indexes.rows.map((row) => String(row.indexdef)).join("\n");
  assert.equal(/hnsw/i.test(joined), false);
  assert.equal(/ivfflat/i.test(joined), false);

  const embedding = await pool.query(
    `SELECT atttypmod FROM pg_attribute
     WHERE attrelid = 'photo_embeddings'::regclass AND attname = 'embedding'`,
  );
  assert.equal(embedding.rows[0].atttypmod, 1536);
});

test("env 示例不新增变量，并写明 API 也读取 EMBED", async () => {
  const example = await readFile(new URL("../../../deploy/env.example", import.meta.url), "utf8");
  assert.match(example, /^EMBED_PROVIDER=http$/m);
  assert.match(example, /^EMBED_API_BASE_URL=https:\/\/YOUR_EMBED_API_BASE$/m);
  assert.match(example, /^EMBED_API_KEY=YOUR_EMBED_API_KEY$/m);
  assert.match(example, /^EMBED_MODEL=YOUR_EMBED_MODEL$/m);
  assert.match(example, /^EMBED_TIMEOUT_MS=30000$/m);
  assert.match(example, /^EMBED_DIMENSIONS=1536$/m);
  assert.match(example, /API 进程也读取 EMBED_PROVIDER/);
  assert.match(example, /语义检索返回 503/);
  assert.match(example, /嵌入配置仍是占位符/);
  assert.equal(example.includes("SEARCH_"), false);
  assert.equal(example.includes("HNSW_"), false);
});

test("阶段 4 已开工且设计状态未被改掉", async () => {
  const phase = await readFile(new URL("../../../specs/phases/04-search.md", import.meta.url), "utf8");
  assert.match(phase, /\*\*状态：\*\* in_progress/);
  assert.equal((phase.match(/- \[x\]/g) ?? []).length, 0);
  assert.ok((phase.match(/- \[ \]/g) ?? []).length >= 5);
  const spec = await readFile(new URL("../../../specs/SPEC.md", import.meta.url), "utf8");
  assert.match(spec, /\| 4 \|.*\| in_progress \|/);
  const design = await readFile(
    new URL("../../../docs/superpowers/specs/2026-11-06-openalbum-phase4-search-design.md", import.meta.url),
    "utf8",
  );
  assert.match(design, /状态：已定稿（待实现）/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
node --import tsx --test --test-concurrency=1 apps/api/test/search-schema.test.ts
```

Expected: FAIL。断言找不到 `本阶段不建 ANN 索引`，或阶段状态仍是 `planned`。退出码非 0。

- [ ] **Step 3: 只改注释和阶段状态**

把 `deploy/db/schema.sql` 里这一行：

```sql
-- 数据量上来之后再加 IVFFlat / HNSW（Phase 4）。
```

换成：

```sql
-- 本阶段不建 ANN 索引。切换条件见 docs/superpowers/specs/2026-11-06-openalbum-phase4-search-design.md 第 7 节。
-- 全表 photo_embeddings 行数达到 100000，或语义检索数据库侧 p95 超过 200 毫秒且该用户 ready 照片达到 10000 时，
-- 才允许后续提交使用 HNSW（vector_cosine_ops，m = 16，ef_construction = 64）。在那之前禁止创建该索引。
```

不要加 `CREATE INDEX`。不要写 `USING hnsw` 或 `ivfflat`。不要改 `photos` 与 `photo_embeddings` 的列。

把 `deploy/env.example` 里从 `# --- 嵌入 ---` 到 `EMBED_DIMENSIONS=1536` 的注释换成下面这一段。赋值行保持逐字不变：

```text
# --- 嵌入 ---
# API 进程也读取 EMBED_PROVIDER、EMBED_API_BASE_URL、EMBED_API_KEY、EMBED_MODEL、EMBED_TIMEOUT_MS、EMBED_DIMENSIONS。
# EMBED_DIMENSIONS 不是 1536 时 API 退出，文案与 worker 相同。
# 生产占位符不让 API 退出：不构造假网关，语义检索返回 503，关键词仍可用。worker 在生产占位符上仍然退出，文案仍是「嵌入配置仍是占位符」。
EMBED_PROVIDER=http
EMBED_API_BASE_URL=https://YOUR_EMBED_API_BASE
EMBED_API_KEY=YOUR_EMBED_API_KEY
EMBED_MODEL=YOUR_EMBED_MODEL
# 空白时 30000。十进制整数，闭区间 1000 到 120000。其他值时 worker 与 API 都退出，文案 EMBED_TIMEOUT_MS 无效。
EMBED_TIMEOUT_MS=30000
# 必须是 1536，与 schema.sql 的 vector(1536) 相同。空白时 worker 与 API 退出，文案 EMBED_DIMENSIONS 缺失；非整数文案 EMBED_DIMENSIONS 无效；其他整数字面量文案 EMBED_DIMENSIONS 与向量列不一致。
EMBED_DIMENSIONS=1536
```

`specs/phases/04-search.md` 的状态行改为：

```markdown
**状态：** in_progress
```

不要把任何 `- [ ]` 改成 `- [x]`。

`specs/SPEC.md` 阶段 4 那一行改为：

```markdown
| 4 | [phases/04-search.md](phases/04-search.md) | in_progress | 关键词与向量检索 |
```

不要改设计文件。不要勾选「任何阶段的完成定义」。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
node --import tsx --test --test-concurrency=1 apps/api/test/search-schema.test.ts
```

Expected: 三个测试通过，`# fail 0`，退出码 0。

- [ ] **Step 5: Commit**

```bash
git add deploy/db/schema.sql deploy/env.example specs/SPEC.md specs/phases/04-search.md apps/api/test/search-schema.test.ts
git commit -m "docs: 将 Phase 4 检索标为开工并写明暂不建索引"
```

---

### Task 2: 检索领域规则、字面量转义与游标

**Files:**
- Create: `apps/api/src/domain/search/cursor.ts`
- Create: `apps/api/src/domain/search/query.ts`
- Create: `apps/api/src/domain/search/ports.ts`
- Modify: `apps/api/src/domain/search/index.ts`
- Test: `apps/api/test/search-rules.test.ts`

**Interfaces:**
- Consumes: 现有 `export const SEARCH_CONTEXT = "search"`。不连接数据库
- Produces:
  - `parseSearchBody(body: Record<string, unknown>): { ok: true; query: ParsedSearch } | { ok: false; reason: SearchParseFailure }`
  - `SearchParseFailure = "invalid_body" | "empty_query" | "query_too_long" | "invalid_tags" | "invalid_time" | "invalid_range"`
  - `ParsedSearch` 是判别联合：`mode: "keyword"` 时 `cursor: KeywordCursor | null`；`mode: "semantic"` 时 `cursor: SemanticCursor | null`。共同字段 `q: string`、`takenFrom: Date | null`、`takenTo: Date | null`、`tags: string[] | null`、`limit: number`
  - `KeywordCursor = { createdAt: Date; id: string }`
  - `SemanticCursor = { scoreText: string; id: string }`
  - `keywordPattern(q: string): string`
  - `encodeKeywordCursor(createdAt: Date, id: string): string`
  - `decodeKeywordCursor(raw: string): KeywordCursor | null`
  - `encodeSemanticCursor(scoreText: string, id: string): string`
  - `decodeSemanticCursor(raw: string): SemanticCursor | null`
  - `isScoreText(value: string): boolean`
  - `SearchPhoto` 字段与 `Photo` 同构，`status` 字面量是 `"ready"`。本文件的类型源码不出现 `domain/library`
  - `SearchHit = { photo: SearchPhoto; scoreText: string | null }`
  - `SearchKeywordInput` 与 `SearchSemanticInput` 见 Step 3 的 `ports.ts`
  - `SearchPort = { searchKeyword(input: SearchKeywordInput): Promise<SearchHit[]>; searchSemantic(input: SearchSemanticInput): Promise<SearchHit[]> }`

- [ ] **Step 1: 写会失败的规则测试**

创建 `apps/api/test/search-rules.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeKeywordCursor,
  decodeSemanticCursor,
  encodeKeywordCursor,
  encodeSemanticCursor,
  keywordPattern,
  parseSearchBody,
} from "../src/domain/search/index.js";

test("空查询与缺失 q 的原因不同，500 个码元合法", () => {
  assert.equal(parseSearchBody({ mode: "keyword" }).ok, false);
  const missing = parseSearchBody({ mode: "keyword", q: 1 });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "invalid_body");
  const empty = parseSearchBody({ mode: "keyword", q: "   " });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, "empty_query");
  const exact = parseSearchBody({ mode: "keyword", q: "啊".repeat(500) });
  assert.equal(exact.ok, true);
  if (exact.ok) assert.equal(exact.query.q, "啊".repeat(500));
  const emoji = parseSearchBody({ mode: "semantic", q: "😀".repeat(250) });
  assert.equal(emoji.ok, true);
  const tooLong = parseSearchBody({ mode: "keyword", q: `${"😀".repeat(250)}a` });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.reason, "query_too_long");
  const kept = parseSearchBody({ mode: "keyword", q: "  红 船  " });
  assert.equal(kept.ok, true);
  if (kept.ok) assert.equal(kept.query.q, "红 船");
});

test("未知键、status、limit 与 mode", () => {
  for (const key of ["semantic", "topK", "offset", "image", "albumId", "ownerId", "sort", "threshold"]) {
    const parsed = parseSearchBody({ mode: "keyword", q: "海", [key]: 1 });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.reason, "invalid_body");
  }
  const ready = parseSearchBody({ mode: "keyword", q: "海", status: "ready" });
  assert.equal(ready.ok, true);
  const omitted = parseSearchBody({ mode: "semantic", q: "海" });
  assert.equal(omitted.ok, true);
  if (omitted.ok) assert.equal(omitted.query.limit, 50);
  for (const status of ["processing", "failed", null, ["ready"]]) {
    const parsed = parseSearchBody({ mode: "keyword", q: "海", status });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.reason, "invalid_body");
  }
  for (const limit of ["20", 0, 101, 1.5, null]) {
    const parsed = parseSearchBody({ mode: "keyword", q: "海", limit });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.reason, "invalid_body");
  }
  const page = parseSearchBody({ mode: "keyword", q: "海", limit: 1 });
  assert.equal(page.ok, true);
  if (page.ok) assert.equal(page.query.limit, 1);
  assert.equal(parseSearchBody({ q: "海" }).ok, false);
  assert.equal(parseSearchBody({ mode: "both", q: "海" }).ok, false);
});

test("时间区间与标签", () => {
  const same = parseSearchBody({
    mode: "keyword",
    q: "海",
    takenFrom: "2026-01-01T00:00:00.000Z",
    takenTo: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(same.ok, true);
  if (same.ok) assert.equal(same.query.takenFrom?.toISOString(), "2026-01-01T00:00:00.000Z");
  const inverted = parseSearchBody({
    mode: "keyword",
    q: "海",
    takenFrom: "2026-02-01T00:00:00.000Z",
    takenTo: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(inverted.ok, false);
  if (!inverted.ok) assert.equal(inverted.reason, "invalid_range");
  for (const takenFrom of [null, 1, "2026-01-01"]) {
    const parsed = parseSearchBody({ mode: "keyword", q: "海", takenFrom });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.reason, "invalid_time");
  }
  const none = parseSearchBody({ mode: "keyword", q: "海" });
  assert.equal(none.ok, true);
  if (none.ok) {
    assert.equal(none.query.takenFrom, null);
    assert.equal(none.query.takenTo, null);
    assert.equal(none.query.tags, null);
  }
  const emptyTags = parseSearchBody({ mode: "keyword", q: "海", tags: [] });
  assert.equal(emptyTags.ok, true);
  if (emptyTags.ok) assert.equal(emptyTags.query.tags, null);
  const tags = parseSearchBody({ mode: "keyword", q: "海", tags: [" Seaside ", "Seaside", "Trip"] });
  assert.equal(tags.ok, true);
  if (tags.ok) assert.deepEqual(tags.query.tags, ["Seaside", "Trip"]);
  const badTags = parseSearchBody({ mode: "keyword", q: "海", tags: ["a\u0000"] });
  assert.equal(badTags.ok, false);
  if (!badTags.ok) assert.equal(badTags.reason, "invalid_tags");
  const nullTags = parseSearchBody({ mode: "keyword", q: "海", tags: null });
  assert.equal(nullTags.ok, false);
  if (!nullTags.ok) assert.equal(nullTags.reason, "invalid_tags");
});

test("keywordPattern 先转义反斜杠", () => {
  assert.equal(keywordPattern("100%_ok"), "%100\\%\\_ok%");
  assert.equal(keywordPattern("a\\b%_"), "%a\\\\b\\%\\_%");
  assert.equal(keywordPattern("%"), "%\\%%");
  assert.equal(keywordPattern("_"), "%\\_%");
});

test("游标往返，关键词游标不能当语义游标，拒绝 -0.000000", () => {
  const createdAt = new Date("2026-11-06T02:31:00.000Z");
  const id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAA1";
  const keyword = encodeKeywordCursor(createdAt, id);
  assert.equal(keyword.includes("="), false);
  const decoded = decodeKeywordCursor(keyword);
  assert.equal(decoded?.createdAt.toISOString(), createdAt.toISOString());
  assert.equal(decoded?.id, id.toLowerCase());
  assert.equal(decodeSemanticCursor(keyword), null);
  const semantic = encodeSemanticCursor("1.000000", id);
  assert.equal(decodeSemanticCursor(semantic)?.scoreText, "1.000000");
  assert.equal(decodeSemanticCursor(semantic)?.id, id.toLowerCase());
  assert.equal(decodeKeywordCursor(semantic), null);
  assert.equal(decodeSemanticCursor(encodeSemanticCursor("-0.000000", id)), null);
  assert.equal(decodeSemanticCursor(encodeSemanticCursor("00.100000", id)), null);
  assert.equal(decodeSemanticCursor(encodeSemanticCursor("-0.250000", id))?.scoreText, "-0.250000");
  assert.equal(decodeKeywordCursor(""), null);
  assert.equal(decodeKeywordCursor(`${keyword}=`), null);
  const listCursor = Buffer.from(`${createdAt.toISOString()}\n${id.toLowerCase()}`, "utf8").toString("base64url");
  const reused = parseSearchBody({ mode: "keyword", q: "海", cursor: listCursor });
  assert.equal(reused.ok, false);
  if (!reused.ok) assert.equal(reused.reason, "invalid_body");
  const wrongMode = parseSearchBody({ mode: "semantic", q: "海", cursor: keyword });
  assert.equal(wrongMode.ok, false);
  if (!wrongMode.ok) assert.equal(wrongMode.reason, "invalid_body");
  const okSemantic = parseSearchBody({ mode: "semantic", q: "海", cursor: semantic });
  assert.equal(okSemantic.ok, true);
  if (okSemantic.ok && okSemantic.query.mode === "semantic") {
    assert.equal(okSemantic.query.cursor?.scoreText, "1.000000");
  }
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/api/test/search-rules.test.ts
```

Expected: FAIL，信息包含 `does not provide an export named 'parseSearchBody'`。退出码非 0。

- [ ] **Step 3: 写领域实现**

创建 `apps/api/src/domain/search/cursor.ts`：

```typescript
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const SCORE_TEXT = /^-?(?:0|[1-9]\d*)\.\d{6}$/;

export type KeywordCursor = { createdAt: Date; id: string };
export type SemanticCursor = { scoreText: string; id: string };

export function encodeKeywordCursor(createdAt: Date, id: string): string {
  return Buffer.from(`k\n${createdAt.toISOString()}\n${id.toLowerCase()}`, "utf8").toString("base64url");
}

export function encodeSemanticCursor(scoreText: string, id: string): string {
  return Buffer.from(`s\n${scoreText}\n${id.toLowerCase()}`, "utf8").toString("base64url");
}

export function isScoreText(value: string): boolean {
  return SCORE_TEXT.test(value) && value !== "-0.000000";
}

function decodeParts(raw: string): [string, string, string] | null {
  if (raw.length === 0 || raw.includes("=")) return null;
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const parts = text.split("\n");
  if (parts.length !== 3) return null;
  return [parts[0] ?? "", parts[1] ?? "", parts[2] ?? ""];
}

export function decodeKeywordCursor(raw: string): KeywordCursor | null {
  const parts = decodeParts(raw);
  if (!parts || parts[0] !== "k" || !INSTANT.test(parts[1]) || !UUID.test(parts[2])) return null;
  const createdAt = new Date(parts[1]);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: parts[2].toLowerCase() };
}

export function decodeSemanticCursor(raw: string): SemanticCursor | null {
  const parts = decodeParts(raw);
  if (!parts || parts[0] !== "s" || !isScoreText(parts[1]) || !UUID.test(parts[2])) return null;
  return { scoreText: parts[1], id: parts[2].toLowerCase() };
}
```

创建 `apps/api/src/domain/search/query.ts`：

```typescript
import { decodeKeywordCursor, decodeSemanticCursor, type KeywordCursor, type SemanticCursor } from "./cursor.js";

const ALLOWED = new Set(["mode", "q", "takenFrom", "takenTo", "tags", "status", "limit", "cursor"]);
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export type SearchParseFailure =
  | "invalid_body"
  | "empty_query"
  | "query_too_long"
  | "invalid_tags"
  | "invalid_time"
  | "invalid_range";

type CommonQuery = {
  q: string;
  takenFrom: Date | null;
  takenTo: Date | null;
  tags: string[] | null;
  limit: number;
};

export type ParsedSearch =
  | (CommonQuery & { mode: "keyword"; cursor: KeywordCursor | null })
  | (CommonQuery & { mode: "semantic"; cursor: SemanticCursor | null });

function fail(reason: SearchParseFailure): { ok: false; reason: SearchParseFailure } {
  return { ok: false, reason };
}

function forbiddenTagControls(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseTags(present: boolean, value: unknown): string[] | null | "invalid" {
  if (!present) return null;
  if (!Array.isArray(value) || value.length > 32) return "invalid";
  if (value.length === 0) return null;
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || forbiddenTagControls(item)) return "invalid";
    const trimmed = item.trim();
    if (trimmed.length < 1 || trimmed.length > 64) return "invalid";
    if (!tags.includes(trimmed)) tags.push(trimmed);
  }
  return tags;
}

function parseInstant(present: boolean, value: unknown): Date | null | "invalid" {
  if (!present) return null;
  if (typeof value !== "string" || !INSTANT.test(value)) return "invalid";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "invalid";
  return parsed;
}

export function keywordPattern(q: string): string {
  return `%${q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export function parseSearchBody(
  body: Record<string, unknown>,
): { ok: true; query: ParsedSearch } | { ok: false; reason: SearchParseFailure } {
  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) return fail("invalid_body");
  }
  if (body.mode !== "keyword" && body.mode !== "semantic") return fail("invalid_body");
  if (!("q" in body) || typeof body.q !== "string") return fail("invalid_body");
  const q = body.q.trim();
  if (q.length === 0) return fail("empty_query");
  if (q.length > 500) return fail("query_too_long");
  if ("status" in body && body.status !== "ready") return fail("invalid_body");
  let limit = 50;
  if ("limit" in body) {
    if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 100) {
      return fail("invalid_body");
    }
    limit = body.limit;
  }
  const takenFrom = parseInstant("takenFrom" in body, body.takenFrom);
  if (takenFrom === "invalid") return fail("invalid_time");
  const takenTo = parseInstant("takenTo" in body, body.takenTo);
  if (takenTo === "invalid") return fail("invalid_time");
  if (takenFrom && takenTo && takenFrom.getTime() > takenTo.getTime()) return fail("invalid_range");
  const tags = parseTags("tags" in body, body.tags);
  if (tags === "invalid") return fail("invalid_tags");
  let cursor: KeywordCursor | SemanticCursor | null = null;
  if ("cursor" in body) {
    if (typeof body.cursor !== "string") return fail("invalid_body");
    const decoded = body.mode === "keyword" ? decodeKeywordCursor(body.cursor) : decodeSemanticCursor(body.cursor);
    if (!decoded) return fail("invalid_body");
    cursor = decoded;
  }
  const common = { q, takenFrom, takenTo, tags, limit };
  if (body.mode === "keyword") {
    return { ok: true, query: { ...common, mode: "keyword", cursor: cursor as KeywordCursor | null } };
  }
  return { ok: true, query: { ...common, mode: "semantic", cursor: cursor as SemanticCursor | null } };
}
```

创建 `apps/api/src/domain/search/ports.ts`：

```typescript
import type { KeywordCursor, SemanticCursor } from "./cursor.js";

export type SearchPhoto = {
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
  status: "ready";
  sourceUserId: string | null;
  sourceKeyId: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SearchHit = {
  photo: SearchPhoto;
  scoreText: string | null;
};

export type SearchKeywordInput = {
  ownerId: string;
  pattern: string;
  takenFrom: Date | null;
  takenTo: Date | null;
  tags: string[] | null;
  cursor: KeywordCursor | null;
  limit: number;
};

export type SearchSemanticInput = {
  ownerId: string;
  values: number[];
  dimensions: 1536;
  takenFrom: Date | null;
  takenTo: Date | null;
  tags: string[] | null;
  cursor: SemanticCursor | null;
  limit: number;
};

export type SearchPort = {
  searchKeyword(input: SearchKeywordInput): Promise<SearchHit[]>;
  searchSemantic(input: SearchSemanticInput): Promise<SearchHit[]>;
};
```

把 `apps/api/src/domain/search/index.ts` 整文件换成：

```typescript
/** 检索上下文（Phase 4）：关键词与向量召回。 */
export const SEARCH_CONTEXT = "search" as const;

export {
  decodeKeywordCursor,
  decodeSemanticCursor,
  encodeKeywordCursor,
  encodeSemanticCursor,
  isScoreText,
} from "./cursor.js";
export type { KeywordCursor, SemanticCursor } from "./cursor.js";
export type { SearchHit, SearchKeywordInput, SearchPhoto, SearchPort, SearchSemanticInput } from "./ports.js";
export { keywordPattern, parseSearchBody } from "./query.js";
export type { ParsedSearch, SearchParseFailure } from "./query.js";
```

`ports.ts` 与 `query.ts` 只能 import 本目录。不要 import `domain/library`。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/api/test/search-rules.test.ts
```

Expected: 五个测试通过，`# fail 0`，退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/domain/search apps/api/test/search-rules.test.ts
git commit -m "feat: 添加检索查询、字面量转义与游标规则"
```

---

### Task 3: 检索 DAO 的关键词与语义 SQL

**Files:**
- Modify: `apps/api/src/dao/photo-repository.ts`（把 `PHOTO_COLUMNS` 改成导出）
- Create: `apps/api/src/dao/search-repository.ts`
- Modify: `apps/api/src/dao/index.ts`
- Test: `apps/api/test/search-dao.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `SearchPort`、`SearchKeywordInput`、`SearchSemanticInput`、`SearchHit`、`keywordPattern`。已导出的 `mapPhotoRow` 与 `formatVectorLiteral`。`formatVectorLiteral` 在长度不符时抛 `name === "DimensionMismatch"`，在非有限数或绝对值大于等于 `1e21` 时抛 `name === "InvalidEmbedding"`
- Produces: `createSearchRepository(pool: pg.Pool): SearchPort`。`searchKeyword` 与 `searchSemantic` 的参数顺序见 Step 3 的 SQL。语义命中的 `scoreText` 是数据库 `::text`，不是 JavaScript `toFixed`

- [ ] **Step 1: 写会失败的 DAO 测试**

创建 `apps/api/test/search-dao.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { createSearchRepository } from "../src/dao/index.js";
import { formatVectorLiteral } from "../src/dao/vector-literal.js";
import type { User } from "../src/domain/identity/model.js";
import { keywordPattern } from "../src/domain/search/index.js";
import { createUserRepository } from "../src/dao/user-repository.js";
import { deterministicEmbedding } from "../src/gateways/embed/deterministic.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";

const pool = new pg.Pool({ connectionString: requireDatabaseUrl() });
const now = new Date("2030-01-01T00:00:00.000Z");

let tail: Promise<unknown> = Promise.resolve();
function serial(name: string, fn: () => Promise<void>): void {
  test(name, () => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
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

async function seedUser(userId: string): Promise<void> {
  const users = createUserRepository(pool);
  const user: User = {
    id: userId,
    email: `${userId}@example.com`,
    passwordHash: "hash",
    createdAt: now,
  };
  assert.equal(await users.insert(user), "ok");
}

async function insertPhoto(input: {
  id: string;
  ownerId: string;
  description: string | null;
  tags?: string[];
  status?: "processing" | "ready" | "failed";
  takenAt?: Date | null;
  locationText?: string | null;
  createdAt?: Date;
  embedding?: number[] | null;
  model?: string;
}): Promise<void> {
  const createdAt = input.createdAt ?? now;
  await pool.query(
    `INSERT INTO photos (
       id, owner_id, object_key, thumb_key, content_type, byte_size,
       taken_at, location_text, description, tags, status, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'image/jpeg', 100,
       $5, $6, $7, $8, $9, $10, $10
     )`,
    [
      input.id,
      input.ownerId,
      `owners/${input.ownerId}/photos/${input.id}/original`,
      `owners/${input.ownerId}/photos/${input.id}/thumb`,
      input.takenAt === undefined ? createdAt : input.takenAt,
      input.locationText ?? null,
      input.description,
      input.tags ?? [],
      input.status ?? "ready",
      createdAt,
    ],
  );
  if (input.embedding) {
    await pool.query(
      `INSERT INTO photo_embeddings (photo_id, embedding, model) VALUES ($1, $2::vector, $3)`,
      [input.id, formatVectorLiteral(input.embedding, 1536), input.model ?? "model-a"],
    );
  }
}

const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";

serial("关键词命中描述或标签，不命中地点、别人、非 ready，并按键集翻页", async () => {
  await reset();
  await seedUser(ownerA);
  await seedUser(ownerB);
  const boat = "33333333-3333-4333-8333-333333333331";
  const side = "33333333-3333-4333-8333-333333333332";
  const place = "33333333-3333-4333-8333-333333333333";
  const other = "33333333-3333-4333-8333-333333333334";
  const processing = "33333333-3333-4333-8333-333333333335";
  await insertPhoto({
    id: boat,
    ownerId: ownerA,
    description: "Red Boat",
    tags: ["Seaside"],
    createdAt: new Date("2030-01-03T00:00:00.000Z"),
  });
  await insertPhoto({
    id: side,
    ownerId: ownerA,
    description: null,
    tags: ["Seaside"],
    createdAt: new Date("2030-01-02T00:00:00.000Z"),
  });
  await insertPhoto({
    id: place,
    ownerId: ownerA,
    description: "湖",
    tags: [],
    locationText: "red harbor",
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
  });
  await insertPhoto({ id: other, ownerId: ownerB, description: "Red Boat", tags: ["Seaside"] });
  await insertPhoto({ id: processing, ownerId: ownerA, description: "Red Boat", status: "processing" });
  const search = createSearchRepository(pool);
  const red = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("red"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(red.map((hit) => hit.photo.id), [boat]);
  assert.equal(red[0]?.scoreText, null);
  assert.equal(red[0]?.photo.status, "ready");
  const folded = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("Red"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(folded.map((hit) => hit.photo.id), [boat]);
  const byTag = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("side"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(byTag.map((hit) => hit.photo.id), [boat, side]);
  const page = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("side"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: { createdAt: byTag[0]!.photo.createdAt, id: byTag[0]!.photo.id },
    limit: 10,
  });
  assert.deepEqual(page.map((hit) => hit.photo.id), [side]);
});

serial("百分号与下划线按字面匹配，空格短语不分词", async () => {
  await reset();
  await seedUser(ownerA);
  const literal = "44444444-4444-4444-8444-444444444441";
  const wildcard = "44444444-4444-4444-8444-444444444442";
  const phrase = "44444444-4444-4444-8444-444444444443";
  const split = "44444444-4444-4444-8444-444444444444";
  const slash = "44444444-4444-4444-8444-444444444445";
  await insertPhoto({ id: literal, ownerId: ownerA, description: "100%_ok" });
  await insertPhoto({ id: wildcard, ownerId: ownerA, description: "100XXok" });
  await insertPhoto({ id: phrase, ownerId: ownerA, description: "红 船" });
  await insertPhoto({ id: split, ownerId: ownerA, description: "红", tags: ["船"] });
  await insertPhoto({ id: slash, ownerId: ownerA, description: "a\\b" });
  const search = createSearchRepository(pool);
  const exact = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("100%_ok"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(exact.map((hit) => hit.photo.id), [literal]);
  const percent = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("%"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(percent.map((hit) => hit.photo.id), [literal]);
  const underscore = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("_"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(underscore.map((hit) => hit.photo.id), [literal]);
  const spaced = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("红 船"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(spaced.map((hit) => hit.photo.id), [phrase]);
  const escaped = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("a\\b"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(escaped.map((hit) => hit.photo.id), [slash]);
});

serial("标签过滤与拍摄时间是 AND，NULL 拍摄时间在任一端出现时排除", async () => {
  await reset();
  await seedUser(ownerA);
  const both = "55555555-5555-4555-8555-555555555551";
  const lower = "55555555-5555-4555-8555-555555555552";
  const outside = "55555555-5555-4555-8555-555555555553";
  const undated = "55555555-5555-4555-8555-555555555554";
  const from = new Date("2026-01-01T00:00:00.000Z");
  const to = new Date("2026-12-31T23:59:59.999Z");
  await insertPhoto({
    id: both,
    ownerId: ownerA,
    description: "boat",
    tags: ["Seaside", "Trip"],
    takenAt: new Date("2026-06-01T00:00:00.000Z"),
  });
  await insertPhoto({
    id: lower,
    ownerId: ownerA,
    description: "boat",
    tags: ["seaside"],
    takenAt: new Date("2026-06-01T00:00:00.000Z"),
  });
  await insertPhoto({
    id: outside,
    ownerId: ownerA,
    description: "boat",
    tags: ["Seaside", "Trip"],
    takenAt: new Date("2025-06-01T00:00:00.000Z"),
  });
  await insertPhoto({
    id: undated,
    ownerId: ownerA,
    description: "boat",
    tags: ["Seaside", "Trip"],
    takenAt: null,
  });
  const search = createSearchRepository(pool);
  const filtered = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("boat"),
    takenFrom: from,
    takenTo: to,
    tags: ["Seaside", "Trip"],
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(filtered.map((hit) => hit.photo.id), [both]);
  const open = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("boat"),
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.equal(open.some((hit) => hit.photo.id === undated), true);
  const onlyFrom = await search.searchKeyword({
    ownerId: ownerA,
    pattern: keywordPattern("boat"),
    takenFrom: from,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.equal(onlyFrom.some((hit) => hit.photo.id === undated), false);
});

serial("语义按余弦相似度排序，排除非 ready 与无向量，不按 model 过滤", async () => {
  await reset();
  await seedUser(ownerA);
  const redOld = "66666666-6666-4666-8666-666666666661";
  const redNew = "66666666-6666-4666-8666-666666666662";
  const blue = "66666666-6666-4666-8666-666666666663";
  const failed = "66666666-6666-4666-8666-666666666664";
  const bare = "66666666-6666-4666-8666-666666666665";
  const redVector = deterministicEmbedding("red", 1536);
  const blueVector = deterministicEmbedding("blue", 1536);
  await insertPhoto({ id: redNew, ownerId: ownerA, description: "red", embedding: redVector, model: "new-model" });
  await insertPhoto({ id: redOld, ownerId: ownerA, description: "red", embedding: redVector, model: "old-model" });
  await insertPhoto({ id: blue, ownerId: ownerA, description: "blue", embedding: blueVector, model: "new-model" });
  await insertPhoto({ id: failed, ownerId: ownerA, description: "red", status: "failed", embedding: redVector });
  await insertPhoto({ id: bare, ownerId: ownerA, description: "red", embedding: null });
  const search = createSearchRepository(pool);
  const hits = await search.searchSemantic({
    ownerId: ownerA,
    values: redVector,
    dimensions: 1536,
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(hits.map((hit) => hit.photo.id), [redOld, redNew, blue]);
  assert.equal(hits[0]?.scoreText, "1.000000");
  assert.equal(hits[1]?.scoreText, "1.000000");
  assert.match(hits[2]?.scoreText ?? "", /^-?(?:0|[1-9]\d*)\.\d{6}$/);
  assert.notEqual(hits[2]?.scoreText, "1.000000");
  const second = await search.searchSemantic({
    ownerId: ownerA,
    values: redVector,
    dimensions: 1536,
    takenFrom: null,
    takenTo: null,
    tags: null,
    cursor: { scoreText: hits[0]!.scoreText ?? "", id: hits[0]!.photo.id },
    limit: 10,
  });
  assert.deepEqual(second.map((hit) => hit.photo.id), [redNew, blue]);
  const expected = await pool.query(
    `SELECT p.id::text AS id
     FROM photos p
     INNER JOIN photo_embeddings e ON e.photo_id = p.id
     WHERE p.owner_id = $1 AND p.status = 'ready'
     ORDER BY round((1 - (e.embedding <=> $2::vector))::numeric, 6) DESC, p.id ASC`,
    [ownerA, formatVectorLiteral(redVector, 1536)],
  );
  assert.deepEqual(
    hits.map((hit) => hit.photo.id),
    expected.rows.map((row) => String(row.id)),
  );
});

serial("向量字面量在发 SQL 前拒绝坏向量", async () => {
  await reset();
  const search = createSearchRepository(pool);
  await assert.rejects(
    () =>
      search.searchSemantic({
        ownerId: ownerA,
        values: [1, 2, 3],
        dimensions: 1536,
        takenFrom: null,
        takenTo: null,
        tags: null,
        cursor: null,
        limit: 1,
      }),
    (error: unknown) => error instanceof Error && error.name === "DimensionMismatch",
  );
  const huge = deterministicEmbedding("red", 1536);
  huge[0] = 1e21;
  await assert.rejects(
    () =>
      search.searchSemantic({
        ownerId: ownerA,
        values: huge,
        dimensions: 1536,
        takenFrom: null,
        takenTo: null,
        tags: null,
        cursor: null,
        limit: 1,
      }),
    (error: unknown) => error instanceof Error && error.name === "InvalidEmbedding",
  );
});

serial("检索 SQL 使用余弦距离，不按 model 过滤，也不建近似索引语句", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/dao/search-repository.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /<=>/);
  assert.equal(source.includes("<->"), false);
  assert.equal(source.includes("<#>"), false);
  assert.equal(source.includes("e.model"), false);
  assert.equal(/using\s+hnsw/i.test(source), false);
  assert.equal(/ivfflat/i.test(source), false);
  assert.match(source, /ESCAPE '\\'/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
node --import tsx --test --test-concurrency=1 apps/api/test/search-dao.test.ts
```

Expected: FAIL，信息包含 `does not provide an export named 'createSearchRepository'`。退出码非 0。

- [ ] **Step 3: 实现参数化 SQL**

`apps/api/src/dao/photo-repository.ts` 里把

```typescript
const PHOTO_COLUMNS = `id, owner_id, object_key, thumb_key, content_type, byte_size,
```

改成

```typescript
export const PHOTO_COLUMNS = `id, owner_id, object_key, thumb_key, content_type, byte_size,
```

不要改 `LIST_SQL` 或其他语句。

创建 `apps/api/src/dao/search-repository.ts`：

```typescript
import pg from "pg";
import type { SearchHit, SearchPhoto, SearchPort } from "../domain/search/ports.js";
import { mapPhotoRow, PHOTO_COLUMNS } from "./photo-repository.js";
import { formatVectorLiteral } from "./vector-literal.js";

const KEYWORD_SQL = `SELECT ${PHOTO_COLUMNS}
FROM photos p
WHERE p.owner_id = $1
  AND p.status = 'ready'
  AND ($2::timestamptz IS NULL OR p.taken_at >= $2)
  AND ($3::timestamptz IS NULL OR p.taken_at <= $3)
  AND ($4::text[] IS NULL OR p.tags @> $4::text[])
  AND (
    p.description ILIKE $5 ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM unnest(p.tags) AS tag
      WHERE tag ILIKE $5 ESCAPE '\\'
    )
  )
  AND (
    $6::timestamptz IS NULL
    OR (p.created_at, p.id) < ($6::timestamptz, $7::uuid)
  )
ORDER BY p.created_at DESC, p.id DESC
LIMIT $8`;

const SCORE_EXPR = `round((1 - (e.embedding <=> $2::vector))::numeric, 6)`;

const SEMANTIC_SQL = `SELECT ${PHOTO_COLUMNS},
       ${SCORE_EXPR}::text AS score_text
FROM photos p
INNER JOIN photo_embeddings e ON e.photo_id = p.id
WHERE p.owner_id = $1
  AND p.status = 'ready'
  AND ($3::timestamptz IS NULL OR p.taken_at >= $3)
  AND ($4::timestamptz IS NULL OR p.taken_at <= $4)
  AND ($5::text[] IS NULL OR p.tags @> $5::text[])
  AND (
    $6::numeric IS NULL
    OR ${SCORE_EXPR} < $6::numeric
    OR (
      ${SCORE_EXPR} = $6::numeric
      AND p.id > $7::uuid
    )
  )
ORDER BY ${SCORE_EXPR} DESC, p.id ASC
LIMIT $8`;

function readyPhoto(row: Record<string, unknown>): SearchPhoto {
  const photo = mapPhotoRow(row);
  if (!photo || photo.status !== "ready") {
    throw Object.assign(new Error("internal_error"), { name: "InternalError" });
  }
  return {
    id: photo.id,
    ownerId: photo.ownerId,
    objectKey: photo.objectKey,
    thumbKey: photo.thumbKey,
    contentType: photo.contentType,
    byteSize: photo.byteSize,
    takenAt: photo.takenAt,
    locationText: photo.locationText,
    latitude: photo.latitude,
    longitude: photo.longitude,
    description: photo.description,
    tags: photo.tags,
    status: "ready",
    sourceUserId: photo.sourceUserId,
    sourceKeyId: photo.sourceKeyId,
    errorCode: photo.errorCode,
    createdAt: photo.createdAt,
    updatedAt: photo.updatedAt,
  };
}

export function createSearchRepository(pool: pg.Pool): SearchPort {
  return {
    async searchKeyword(input) {
      const result = await pool.query(KEYWORD_SQL, [
        input.ownerId,
        input.takenFrom,
        input.takenTo,
        input.tags,
        input.pattern,
        input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null,
        input.limit,
      ]);
      return result.rows.map((row) => ({ photo: readyPhoto(row), scoreText: null }));
    },
    async searchSemantic(input) {
      const literal = formatVectorLiteral(input.values, input.dimensions);
      const result = await pool.query(SEMANTIC_SQL, [
        input.ownerId,
        literal,
        input.takenFrom,
        input.takenTo,
        input.tags,
        input.cursor?.scoreText ?? null,
        input.cursor?.id ?? null,
        input.limit,
      ]);
      return result.rows.map((row) => {
        const scoreText = row.score_text;
        if (typeof scoreText !== "string") {
          throw Object.assign(new Error("internal_error"), { name: "InternalError" });
        }
        const hit: SearchHit = { photo: readyPhoto(row), scoreText };
        return hit;
      });
    },
  };
}
```

模板字面量里的 `ESCAPE '\\'` 发出去的 SQL 是 `ESCAPE '\'`。不要改成四个反斜杠。`formatVectorLiteral` 必须写在 `pool.query` 之前。不要把 `q` 拼进 SQL。不要加 `e.model = ...`。

在 `apps/api/src/dao/index.ts` 的导出列表里加上：

```typescript
export { createSearchRepository } from "./search-repository.js";
```

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
node --import tsx --test --test-concurrency=1 apps/api/test/search-dao.test.ts
```

Expected: 六个测试通过，`# fail 0`，退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/dao/photo-repository.ts apps/api/src/dao/search-repository.ts apps/api/src/dao/index.ts apps/api/test/search-dao.test.ts
git commit -m "feat: 用参数化 SQL 实现关键词与语义检索"
```

---

### Task 4: 检索用例编排

**Files:**
- Create: `apps/api/src/adapters/search/messages.ts`
- Create: `apps/api/src/adapters/search/deps.ts`
- Create: `apps/api/src/adapters/search/search-photos.ts`
- Modify: `apps/api/src/adapters/index.ts`
- Test: `apps/api/test/search-usecase.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `parseSearchBody`、`keywordPattern`、`encodeKeywordCursor`、`encodeSemanticCursor`、`isScoreText`、`SearchPort`。Task 3 的端口由测试用内存对象代替，本任务不连接数据库。`checkEmbedding(values, dimensions)` 来自 `domain/library/pipeline.ts`。`toPhotoResponse(deps, photo, now)` 来自 `adapters/library/photo-response.ts`，只使用 `deps.storage.presignGet` 与 `deps.signedUrlTtlSeconds`
- Produces:
  - `searchPhotos(deps: SearchDeps, actor: LibraryActor, body: Record<string, unknown>, now: Date): Promise<SearchResult<SearchResponseBody>>`
  - `SearchResponseBody = { photos: Array<PhotoResponse & { score: number | null }>; nextCursor: string | null }`
  - `SearchDeps = { port: SearchPort; embed: EmbedGateway | null; embedModel: string | null; library: SearchSigningDeps; log: SearchLog }`
  - `SearchSigningDeps` 的字段与 `LibraryDeps` 相同：`photos`、`sessions`、`storage`、`ids`、`signedUrlTtlSeconds`、`log`。结构上可以传入现有的 `LibraryDeps`，但 `deps.ts` 不 import `adapters/library/deps.ts`
  - `SearchLog.warn(message: string, fields: { userId?: string; mode?: "keyword" | "semantic"; errorCode?: string; photoId?: string; objectKey?: string; errorName?: string }): void`
  - 错误结果：`ok: false`，`status` 为 400、500、502 或 503，`code` 与 `message` 见 Step 3 的 `SEARCH_MESSAGES`

- [ ] **Step 1: 写会失败的用例测试**

创建 `apps/api/test/search-usecase.test.ts`：

```typescript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { searchPhotos } from "../src/adapters/index.js";
import type { SearchDeps, SearchLog } from "../src/adapters/search/deps.js";
import type { LibraryActor } from "../src/domain/library/model.js";
import type { EmbedGateway, ObjectStorage } from "../src/domain/library/ports.js";
import type { SearchHit, SearchPhoto, SearchPort } from "../src/domain/search/ports.js";
import { deterministicEmbedding } from "../src/gateways/embed/deterministic.js";

const actor: LibraryActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  credentialKind: "api_key",
  credentialId: "22222222-2222-4222-8222-222222222222",
};
const now = new Date("2030-01-01T00:00:00.000Z");

function photo(id: string, createdAt: string): SearchPhoto {
  return {
    id,
    ownerId: actor.userId,
    objectKey: `owners/${actor.userId}/photos/${id}/original`,
    thumbKey: `owners/${actor.userId}/photos/${id}/thumb`,
    contentType: "image/jpeg",
    byteSize: 100,
    takenAt: null,
    locationText: null,
    latitude: null,
    longitude: null,
    description: "海边",
    tags: ["黄昏"],
    status: "ready",
    sourceUserId: null,
    sourceKeyId: null,
    errorCode: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function recordingLog(): SearchLog & { lines: Array<{ message: string; fields: unknown }> } {
  const lines: Array<{ message: string; fields: unknown }> = [];
  return {
    lines,
    warn(message, fields) {
      lines.push({ message, fields: { ...fields } });
    },
  };
}

function signingLibrary(events: string[], failOnCall: number | null = null): SearchDeps["library"] {
  let calls = 0;
  const storage = {
    async presignGet(input: { key: string; expiresInSeconds: number; now: Date }) {
      calls += 1;
      events.push("sign");
      if (failOnCall !== null && calls === failOnCall) {
        throw Object.assign(new Error("secret-url"), { name: "StorageDown" });
      }
      const expiresAt = new Date(input.now.getTime() + input.expiresInSeconds * 1000);
      return {
        url: `http://storage.invalid/get?key=${encodeURIComponent(input.key)}&exp=${Math.floor(expiresAt.getTime() / 1000)}`,
        expiresAt,
      };
    },
  } as ObjectStorage;
  return {
    photos: {} as SearchDeps["library"]["photos"],
    sessions: {} as SearchDeps["library"]["sessions"],
    storage,
    ids: { nextId: () => "unused" },
    signedUrlTtlSeconds: 900,
    log: {
      warn(message, fields) {
        events.push(`storage-log:${message}:${fields.errorName ?? ""}`);
      },
    },
  };
}

test("关键词不调用嵌入，默认页大小加 1，score 为 null", async () => {
  const events: string[] = [];
  const seen: Array<{ ownerId: string; limit: number; pattern: string }> = [];
  const hits: SearchHit[] = [
    { photo: photo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "2030-01-01T00:00:00.000Z"), scoreText: null },
  ];
  const port: SearchPort = {
    async searchKeyword(input) {
      events.push("sql");
      seen.push({ ownerId: input.ownerId, limit: input.limit, pattern: input.pattern });
      return hits;
    },
    async searchSemantic() {
      throw new Error("关键词路径不应查询向量");
    },
  };
  let embedCalls = 0;
  const embed: EmbedGateway = {
    async embed() {
      embedCalls += 1;
      return { ok: false, kind: "embed_unavailable" };
    },
  };
  const log = recordingLog();
  const deps: SearchDeps = { port, embed, embedModel: "m", library: signingLibrary(events), log };
  const result = await searchPhotos(deps, actor, { mode: "keyword", q: "  红 船 " }, now);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(embedCalls, 0);
  assert.deepEqual(events, ["sql", "sign"]);
  assert.equal(seen[0]?.ownerId, actor.userId);
  assert.equal(seen[0]?.limit, 51);
  assert.equal(seen[0]?.pattern, "%红 船%");
  assert.equal(result.body.photos.length, 1);
  assert.equal(result.body.photos[0]?.score, null);
  assert.equal(Object.hasOwn(result.body.photos[0] ?? {}, "score"), true);
  assert.equal(result.body.photos[0]?.originalUrl.startsWith("http://storage.invalid/get?key="), true);
  assert.equal(result.body.nextCursor, null);
});

test("limit 加 1 时用本页最后一条做关键词游标", async () => {
  const first = photo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "2030-01-02T00:00:00.000Z");
  const extra = photo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "2030-01-01T00:00:00.000Z");
  const port: SearchPort = {
    async searchKeyword() {
      return [
        { photo: first, scoreText: null },
        { photo: extra, scoreText: null },
      ];
    },
    async searchSemantic() {
      return [];
    },
  };
  const deps: SearchDeps = {
    port,
    embed: null,
    embedModel: null,
    library: signingLibrary([]),
    log: recordingLog(),
  };
  const result = await searchPhotos(deps, actor, { mode: "keyword", q: "海", limit: 1 }, now);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.body.photos.length, 1);
  assert.equal(result.body.photos[0]?.id, first.id);
  const cursor = Buffer.from(result.body.nextCursor ?? "", "base64url").toString("utf8");
  assert.equal(cursor, `k\n${first.createdAt.toISOString()}\n${first.id}`);
  assert.equal(cursor.includes(extra.id), false);
});

test("语义把 trim 后的 q 原样送进嵌入，按调用、SQL、签名的顺序", async () => {
  const events: string[] = [];
  const texts: string[] = [];
  const values = deterministicEmbedding("海边", 1536);
  const embed: EmbedGateway = {
    async embed(input) {
      events.push("embed");
      texts.push(input.text);
      assert.equal(input.model, "embed-model");
      return { ok: true, values: values.slice() };
    },
  };
  const hitPhoto = photo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "2030-01-01T00:00:00.000Z");
  const port: SearchPort = {
    async searchKeyword() {
      throw new Error("语义路径不应走关键词");
    },
    async searchSemantic(input) {
      events.push("sql");
      assert.equal(input.ownerId, actor.userId);
      assert.equal(input.dimensions, 1536);
      assert.equal(input.limit, 51);
      assert.deepEqual(input.values, values);
      return [{ photo: hitPhoto, scoreText: "1.000000" }];
    },
  };
  const deps: SearchDeps = {
    port,
    embed,
    embedModel: "embed-model",
    library: signingLibrary(events),
    log: recordingLog(),
  };
  const result = await searchPhotos(deps, actor, { mode: "semantic", q: "  海边  " }, now);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(texts, ["海边"]);
  assert.deepEqual(events, ["embed", "sql", "sign"]);
  assert.equal(result.body.photos[0]?.score, 1);
  assert.equal(result.body.nextCursor, null);
});

test("嵌入失败或结果无效时不查询向量，响应不含查询文本", async () => {
  let sqlCalls = 0;
  const port: SearchPort = {
    async searchKeyword() {
      return [];
    },
    async searchSemantic() {
      sqlCalls += 1;
      return [];
    },
  };
  const log = recordingLog();
  const unavailable: EmbedGateway = {
    async embed() {
      return { ok: false, kind: "embed_unavailable" };
    },
  };
  const deps: SearchDeps = {
    port,
    embed: unavailable,
    embedModel: "m",
    library: signingLibrary([]),
    log,
  };
  const failed = await searchPhotos(deps, actor, { mode: "semantic", q: "海边日落" }, now);
  assert.deepEqual(failed, { ok: false, status: 503, code: "embed_unavailable", message: "嵌入暂不可用" });
  assert.equal(sqlCalls, 0);
  assert.equal(JSON.stringify(failed).includes("海边日落"), false);
  assert.equal(log.lines[0]?.message, "嵌入调用失败");
  assert.deepEqual(log.lines[0]?.fields, { userId: actor.userId, mode: "semantic", errorCode: "embed_unavailable" });

  let calls = 0;
  deps.embed = {
    async embed() {
      calls += 1;
      return { ok: true, values: [1, 2, 3] };
    },
  };
  const rejected = await searchPhotos(deps, actor, { mode: "semantic", q: "海边日落" }, now);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.status, 502);
    assert.equal(rejected.code, "embed_rejected");
    assert.equal(rejected.message, "嵌入被拒绝");
    assert.equal(JSON.stringify(rejected).includes("1536"), false);
  }
  assert.equal(calls, 1);
  assert.equal(sqlCalls, 0);
  assert.equal(log.lines.at(-1)?.message, "嵌入结果无效");
  assert.equal((log.lines.at(-1)?.fields as { errorCode?: string }).errorCode, "dimension_mismatch");
});

test("没有网关是 503，空白模型不调用网关", async () => {
  let calls = 0;
  const embed: EmbedGateway = {
    async embed() {
      calls += 1;
      return { ok: true, values: deterministicEmbedding("海", 1536) };
    },
  };
  const port: SearchPort = {
    async searchKeyword() {
      return [];
    },
    async searchSemantic() {
      throw new Error("不应查询");
    },
  };
  const missing = await searchPhotos(
    { port, embed: null, embedModel: "m", library: signingLibrary([]), log: recordingLog() },
    actor,
    { mode: "semantic", q: "海" },
    now,
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.status, 503);
  const blank = await searchPhotos(
    { port, embed, embedModel: "   ", library: signingLibrary([]), log: recordingLog() },
    actor,
    { mode: "semantic", q: "海" },
    now,
  );
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.code, "embed_rejected");
  assert.equal(calls, 0);
});

test("DAO 的 InvalidEmbedding 收成 502，坏的 score_text 与签名失败都不返回半截列表", async () => {
  const values = deterministicEmbedding("海", 1536);
  const embed: EmbedGateway = {
    async embed() {
      return { ok: true, values };
    },
  };
  const log = recordingLog();
  const port: SearchPort = {
    async searchKeyword() {
      return [];
    },
    async searchSemantic() {
      throw Object.assign(new Error("vector dump 1,2,3"), { name: "InvalidEmbedding" });
    },
  };
  const invalid = await searchPhotos(
    { port, embed, embedModel: "m", library: signingLibrary([]), log },
    actor,
    { mode: "semantic", q: "海" },
    now,
  );
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.code, "embed_rejected");
    assert.equal(JSON.stringify(invalid).includes("vector dump"), false);
  }
  assert.equal((log.lines.at(-1)?.fields as { errorCode?: string }).errorCode, "invalid_embedding");

  port.searchSemantic = async () => [{ photo: photo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "2030-01-01T00:00:00.000Z"), scoreText: "1.0" }];
  const badScore = await searchPhotos(
    { port, embed, embedModel: "m", library: signingLibrary([]), log: recordingLog() },
    actor,
    { mode: "semantic", q: "海" },
    now,
  );
  assert.equal(badScore.ok, false);
  if (!badScore.ok) assert.equal(badScore.code, "internal_error");

  const events: string[] = [];
  port.searchSemantic = async () => [
    { photo: photo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "2030-01-02T00:00:00.000Z"), scoreText: "1.000000" },
    { photo: photo("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "2030-01-01T00:00:00.000Z"), scoreText: "0.500000" },
  ];
  const stored = await searchPhotos(
    { port, embed, embedModel: "m", library: signingLibrary(events, 2), log: recordingLog() },
    actor,
    { mode: "semantic", q: "海", limit: 2 },
    now,
  );
  assert.equal(stored.ok, false);
  if (!stored.ok) {
    assert.equal(stored.status, 500);
    assert.equal(stored.code, "storage_error");
    assert.equal(stored.message, "对象存储不可用");
  }
  assert.equal(events.includes("storage-log:对象存储失败:StorageDown"), true);
});

test("解析失败不访问端口，源码不把查询改写成 embeddingInput", async () => {
  let calls = 0;
  const port: SearchPort = {
    async searchKeyword() {
      calls += 1;
      return [];
    },
    async searchSemantic() {
      calls += 1;
      return [];
    },
  };
  const deps: SearchDeps = { port, embed: null, embedModel: null, library: signingLibrary([]), log: recordingLog() };
  const empty = await searchPhotos(deps, actor, { mode: "keyword", q: " " }, now);
  assert.deepEqual(empty, { ok: false, status: 400, code: "empty_query", message: "查询为空" });
  const range = await searchPhotos(
    deps,
    actor,
    { mode: "keyword", q: "海", takenFrom: "2026-02-01T00:00:00.000Z", takenTo: "2026-01-01T00:00:00.000Z" },
    now,
  );
  assert.equal(range.ok, false);
  if (!range.ok) assert.equal(range.message, "时间范围不合法");
  const tags = await searchPhotos(deps, actor, { mode: "keyword", q: "海", tags: [""] }, now);
  assert.equal(tags.ok, false);
  if (!tags.ok) assert.equal(tags.message, "标签不合法");
  assert.equal(calls, 0);
  const source = await readFile(new URL("../src/adapters/search/search-photos.ts", import.meta.url), "utf8");
  assert.equal(source.includes("embeddingInput"), false);
  assert.match(source, /text: query\.q/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/api/test/search-usecase.test.ts
```

Expected: FAIL，信息包含 `does not provide an export named 'searchPhotos'`。退出码非 0。

- [ ] **Step 3: 实现用例**

创建 `apps/api/src/adapters/search/messages.ts`：

```typescript
export const SEARCH_MESSAGES = {
  invalidBody: "请求不合法",
  emptyQuery: "查询为空",
  queryTooLong: "查询过长",
  invalidTags: "标签不合法",
  invalidTime: "拍摄时间不合法",
  invalidRange: "时间范围不合法",
  embedRejected: "嵌入被拒绝",
  embedUnavailable: "嵌入暂不可用",
  storageError: "对象存储不可用",
  internalError: "服务器错误",
} as const;

export type SearchError = {
  ok: false;
  status: 400 | 500 | 502 | 503;
  code:
    | "validation_error"
    | "empty_query"
    | "query_too_long"
    | "embed_rejected"
    | "embed_unavailable"
    | "storage_error"
    | "internal_error";
  message: string;
};

export type SearchSuccess<T> = { ok: true; status: 200; body: T };
export type SearchResult<T> = SearchSuccess<T> | SearchError;

function error(status: SearchError["status"], code: SearchError["code"], message: string): SearchError {
  return { ok: false, status, code, message };
}

export function invalidBody(): SearchError {
  return error(400, "validation_error", SEARCH_MESSAGES.invalidBody);
}

export function emptyQuery(): SearchError {
  return error(400, "empty_query", SEARCH_MESSAGES.emptyQuery);
}

export function queryTooLong(): SearchError {
  return error(400, "query_too_long", SEARCH_MESSAGES.queryTooLong);
}

export function invalidTags(): SearchError {
  return error(400, "validation_error", SEARCH_MESSAGES.invalidTags);
}

export function invalidTime(): SearchError {
  return error(400, "validation_error", SEARCH_MESSAGES.invalidTime);
}

export function invalidRange(): SearchError {
  return error(400, "validation_error", SEARCH_MESSAGES.invalidRange);
}

export function embedRejected(): SearchError {
  return error(502, "embed_rejected", SEARCH_MESSAGES.embedRejected);
}

export function embedUnavailable(): SearchError {
  return error(503, "embed_unavailable", SEARCH_MESSAGES.embedUnavailable);
}

export function storageError(): SearchError {
  return error(500, "storage_error", SEARCH_MESSAGES.storageError);
}

export function internalError(): SearchError {
  return error(500, "internal_error", SEARCH_MESSAGES.internalError);
}
```

创建 `apps/api/src/adapters/search/deps.ts`：

```typescript
import type { EmbedGateway, LibraryLog, ObjectStorage, PhotoRepository, UploadSessionRepository } from "../../domain/library/ports.js";
import type { SearchPort } from "../../domain/search/ports.js";

export type SearchLogFields = {
  userId?: string;
  mode?: "keyword" | "semantic";
  errorCode?: string;
  photoId?: string;
  objectKey?: string;
  errorName?: string;
};

export type SearchLog = {
  warn(message: string, fields: SearchLogFields): void;
};

export type SearchSigningDeps = {
  photos: PhotoRepository;
  sessions: UploadSessionRepository;
  storage: ObjectStorage;
  ids: { nextId(): string };
  signedUrlTtlSeconds: number;
  log: LibraryLog;
};

export type SearchDeps = {
  port: SearchPort;
  embed: EmbedGateway | null;
  embedModel: string | null;
  library: SearchSigningDeps;
  log: SearchLog;
};
```

创建 `apps/api/src/adapters/search/search-photos.ts`：

```typescript
import type { LibraryActor, Photo } from "../../domain/library/model.js";
import { checkEmbedding } from "../../domain/library/pipeline.js";
import {
  encodeKeywordCursor,
  encodeSemanticCursor,
  isScoreText,
  keywordPattern,
  parseSearchBody,
  type SearchHit,
  type SearchParseFailure,
  type SearchPhoto,
} from "../../domain/search/index.js";
import { toPhotoResponse, type PhotoResponse } from "../library/photo-response.js";
import type { SearchDeps } from "./deps.js";
import {
  embedRejected,
  embedUnavailable,
  emptyQuery,
  internalError,
  invalidBody,
  invalidRange,
  invalidTags,
  invalidTime,
  queryTooLong,
  storageError,
  type SearchResult,
} from "./messages.js";

export type SearchResponseBody = {
  photos: Array<PhotoResponse & { score: number | null }>;
  nextCursor: string | null;
};

function asPhoto(photo: SearchPhoto): Photo {
  return { ...photo, status: "ready" };
}

function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error && typeof error.name === "string") {
    return error.name;
  }
  return "Error";
}

function mapParseFailure(reason: SearchParseFailure): SearchResult<SearchResponseBody> {
  if (reason === "empty_query") return emptyQuery();
  if (reason === "query_too_long") return queryTooLong();
  if (reason === "invalid_tags") return invalidTags();
  if (reason === "invalid_time") return invalidTime();
  if (reason === "invalid_range") return invalidRange();
  return invalidBody();
}

async function finish(
  deps: SearchDeps,
  actor: LibraryActor,
  now: Date,
  mode: "keyword" | "semantic",
  hits: SearchHit[],
  limit: number,
): Promise<SearchResult<SearchResponseBody>> {
  const page = hits.slice(0, limit);
  const photos: SearchResponseBody["photos"] = [];
  for (const hit of page) {
    try {
      const base = await toPhotoResponse(deps.library, asPhoto(hit.photo), now);
      photos.push({ ...base, score: hit.scoreText === null ? null : Number(hit.scoreText) });
    } catch (error) {
      deps.library.log.warn("对象存储失败", {
        userId: actor.userId,
        photoId: hit.photo.id,
        objectKey: hit.photo.objectKey,
        errorName: errorName(error),
      });
      return storageError();
    }
  }
  const last = page.at(-1);
  const nextCursor =
    hits.length > limit && last
      ? mode === "keyword"
        ? encodeKeywordCursor(last.photo.createdAt, last.photo.id)
        : encodeSemanticCursor(last.scoreText ?? "", last.photo.id)
      : null;
  return { ok: true, status: 200, body: { photos, nextCursor } };
}

export async function searchPhotos(
  deps: SearchDeps,
  actor: LibraryActor,
  body: Record<string, unknown>,
  now: Date,
): Promise<SearchResult<SearchResponseBody>> {
  const parsed = parseSearchBody(body);
  if (!parsed.ok) return mapParseFailure(parsed.reason);
  const query = parsed.query;
  if (query.mode === "keyword") {
    const hits = await deps.port.searchKeyword({
      ownerId: actor.userId,
      pattern: keywordPattern(query.q),
      takenFrom: query.takenFrom,
      takenTo: query.takenTo,
      tags: query.tags,
      cursor: query.cursor,
      limit: query.limit + 1,
    });
    return finish(deps, actor, now, "keyword", hits, query.limit);
  }
  if (!deps.embed) {
    deps.log.warn("嵌入调用失败", { userId: actor.userId, mode: "semantic", errorCode: "embed_unavailable" });
    return embedUnavailable();
  }
  const model = deps.embedModel?.trim() ?? "";
  if (model.length === 0) {
    deps.log.warn("嵌入结果无效", { userId: actor.userId, mode: "semantic", errorCode: "invalid_embedding" });
    return embedRejected();
  }
  const embedded = await deps.embed.embed({ model, text: query.q });
  if (!embedded.ok) {
    deps.log.warn("嵌入调用失败", { userId: actor.userId, mode: "semantic", errorCode: embedded.kind });
    return embedded.kind === "embed_unavailable" ? embedUnavailable() : embedRejected();
  }
  const checked = checkEmbedding(embedded.values, 1536);
  if (!checked.ok) {
    deps.log.warn("嵌入结果无效", { userId: actor.userId, mode: "semantic", errorCode: checked.code });
    return embedRejected();
  }
  let hits: SearchHit[];
  try {
    hits = await deps.port.searchSemantic({
      ownerId: actor.userId,
      values: embedded.values,
      dimensions: 1536,
      takenFrom: query.takenFrom,
      takenTo: query.takenTo,
      tags: query.tags,
      cursor: query.cursor,
      limit: query.limit + 1,
    });
  } catch (error) {
    const name = errorName(error);
    if (name === "DimensionMismatch" || name === "InvalidEmbedding") {
      deps.log.warn("嵌入结果无效", {
        userId: actor.userId,
        mode: "semantic",
        errorCode: name === "DimensionMismatch" ? "dimension_mismatch" : "invalid_embedding",
      });
      return embedRejected();
    }
    deps.log.warn("服务器错误", { userId: actor.userId, mode: "semantic", errorCode: "internal_error" });
    return internalError();
  }
  for (const hit of hits) {
    if (hit.scoreText === null || !isScoreText(hit.scoreText)) {
      deps.log.warn("服务器错误", { userId: actor.userId, mode: "semantic", errorCode: "internal_error" });
      return internalError();
    }
  }
  return finish(deps, actor, now, "semantic", hits, query.limit);
}
```

在 `apps/api/src/adapters/index.ts` 末尾加上：

```typescript
export { searchPhotos } from "./search/search-photos.js";
export type { SearchResponseBody } from "./search/search-photos.js";
export type { SearchDeps } from "./search/deps.js";
```

本任务不注册路由，不改 `app.ts`。用例文件不要出现 `embeddingInput`。不要 import `dao` 或 `gateways`。省略 `limit` 的用例只准备 1 条命中，端口收到的 `limit` 仍是 51。`limit: 1` 且返回 2 条的用例单独断言游标来自本页最后一条。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/api/test/search-usecase.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 用例测试 `# fail 0`。`tsc` 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/adapters/search apps/api/src/adapters/index.ts apps/api/test/search-usecase.test.ts
git commit -m "feat: 编排关键词与语义检索用例"
```

---

### Task 5: API 嵌入配置与生产占位符

**Files:**
- Modify: `apps/api/src/gateways/embed/config.ts`
- Modify: `apps/api/src/gateways/embed/index.ts`
- Test: `apps/api/test/search-config.test.ts`

**Interfaces:**
- Consumes: 现有 `loadPipelineConfig`、`createFakeEmbedGateway`、`createHttpEmbedGateway`、`EMBED_VECTOR_DIMENSIONS`
- Produces:
  - `embedCredentialsArePlaceholder(input: { baseUrl: string; apiKey: string; model: string }): boolean`
  - `API_EMBED_DISABLED_MESSAGE = "嵌入配置仍是占位符，语义检索不可用"`
  - `loadApiEmbedConfig(env: NodeJS.ProcessEnv): ApiEmbedConfigResult`
  - `ApiEmbedConfigResult = { ok: true; config: ApiEmbedConfig } | { ok: false; exitCode: 1; message: string }`
  - `ApiEmbedConfig` 三选一：`{ kind: "disabled"; message: typeof API_EMBED_DISABLED_MESSAGE }`、`{ kind: "fake"; model: string; gateway: EmbedGateway; info: "嵌入网关使用假实现" }`、`{ kind: "http"; model: string; gateway: EmbedGateway; info: "嵌入网关使用 HTTP" }`
  - `loadPipelineConfig` 在 `NODE_ENV=production` 且嵌入占位时仍然 `{ ok: false, exitCode: 1, message: "嵌入配置仍是占位符" }`

本任务不改 `worker.ts`、`index.ts`、`app.ts`。

- [ ] **Step 1: 写会失败的配置测试**

创建 `apps/api/test/search-config.test.ts`：

```typescript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadApiEmbedConfig, loadPipelineConfig } from "../src/gateways/embed/index.js";

function embedEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PIPELINE_POLL_MS: "1",
    PIPELINE_CONCURRENCY: "9",
    VISION_PROVIDER: "nope",
    EMBED_PROVIDER: "http",
    EMBED_API_BASE_URL: "https://embed.example.com",
    EMBED_API_KEY: "real-embed",
    EMBED_MODEL: "embed-model",
    EMBED_TIMEOUT_MS: "",
    EMBED_DIMENSIONS: "1536",
    ...overrides,
  };
}

function workerEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PIPELINE_POLL_MS: "",
    PIPELINE_CONCURRENCY: "",
    VISION_PROVIDER: "http",
    VISION_API_BASE_URL: "https://vision.example.com",
    VISION_API_KEY: "real-vision",
    VISION_MODEL: "vision-model",
    VISION_TIMEOUT_MS: "",
    EMBED_PROVIDER: "http",
    EMBED_API_BASE_URL: "https://embed.example.com",
    EMBED_API_KEY: "YOUR_EMBED_API_KEY",
    EMBED_MODEL: "embed-model",
    EMBED_TIMEOUT_MS: "",
    EMBED_DIMENSIONS: "1536",
    ...overrides,
  };
}

test("API 加载忽略视觉与轮询，维度错误沿用 Phase 3 文案", () => {
  const ok = loadApiEmbedConfig(embedEnv());
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.config.kind, "http");
    if (ok.config.kind === "http") {
      assert.equal(ok.config.model, "embed-model");
      assert.equal(ok.config.info, "嵌入网关使用 HTTP");
      assert.equal(ok.config.info.includes("embed.example.com"), false);
      assert.equal(ok.config.info.includes("embed-model"), false);
    }
  }
  assert.equal(loadApiEmbedConfig(embedEnv({ EMBED_DIMENSIONS: "" })).ok, false);
  const missing = loadApiEmbedConfig(embedEnv({ EMBED_DIMENSIONS: "" }));
  if (!missing.ok) assert.equal(missing.message, "EMBED_DIMENSIONS 缺失");
  const invalid = loadApiEmbedConfig(embedEnv({ EMBED_DIMENSIONS: "abc" }));
  if (!invalid.ok) assert.equal(invalid.message, "EMBED_DIMENSIONS 无效");
  const other = loadApiEmbedConfig(embedEnv({ EMBED_DIMENSIONS: "768" }));
  if (!other.ok) assert.equal(other.message, "EMBED_DIMENSIONS 与向量列不一致");
  const userinfo = loadApiEmbedConfig(embedEnv({ EMBED_API_BASE_URL: "https://user:pass@embed.example.com" }));
  assert.equal(userinfo.ok, false);
  if (!userinfo.ok) {
    assert.equal(userinfo.message, "EMBED_API_BASE_URL 无效");
    assert.equal(userinfo.message.includes("user"), false);
    assert.equal(userinfo.message.includes("pass"), false);
  }
});

test("非 production 占位得到假网关且不发请求", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls.push("fetch");
    throw new Error("不应该请求嵌入");
  };
  try {
    const loaded = loadApiEmbedConfig(embedEnv({ EMBED_API_KEY: "YOUR_EMBED_API_KEY", EMBED_MODEL: "   " }));
    assert.equal(loaded.ok, true);
    if (!loaded.ok || loaded.config.kind !== "fake") return;
    assert.equal(loaded.config.model, "fake");
    assert.equal(loaded.config.info, "嵌入网关使用假实现");
    const embedded = await loaded.config.gateway.embed({ model: loaded.config.model, text: "海边" });
    assert.equal(embedded.ok, true);
    if (embedded.ok) assert.equal(embedded.values.length, 1536);
    assert.deepEqual(calls, []);
    assert.equal(JSON.stringify(loaded.config.info).includes("YOUR_EMBED_API_KEY"), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("production 占位禁用语义且不退出，worker 配置仍然退出", async () => {
  const api = loadApiEmbedConfig(embedEnv({ NODE_ENV: "production", EMBED_API_KEY: "YOUR_EMBED_API_KEY" }));
  assert.equal(api.ok, true);
  if (!api.ok) return;
  assert.equal(api.config.kind, "disabled");
  if (api.config.kind === "disabled") assert.equal(api.config.message, "嵌入配置仍是占位符，语义检索不可用");
  assert.equal("gateway" in api.config, false);
  const worker = loadPipelineConfig(workerEnv());
  assert.equal(worker.ok, false);
  if (!worker.ok) {
    assert.equal(worker.message, "嵌入配置仍是占位符");
    assert.equal(worker.exitCode, 1);
    assert.equal(worker.message.includes("语义检索不可用"), false);
  }
  const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  assert.equal(source.includes("loadPipelineConfig"), true);
  assert.equal(source.includes("语义检索不可用"), false);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/api/test/search-config.test.ts
```

Expected: FAIL，信息包含 `does not provide an export named 'loadApiEmbedConfig'`。退出码非 0。不要改 `apps/api/test/pipeline-config.test.ts`。

- [ ] **Step 3: 抽出占位判断并增加 API 加载函数**

在 `apps/api/src/gateways/embed/config.ts` 增加导入：

```typescript
import type { EmbedGateway } from "../../domain/library/ports.js";
import { createFakeEmbedGateway } from "./fake-embed.js";
import { createHttpEmbedGateway } from "./http-embed.js";
```

在 `parseSide` 上方增加：

```typescript
export const API_EMBED_DISABLED_MESSAGE = "嵌入配置仍是占位符，语义检索不可用";

export function embedCredentialsArePlaceholder(input: { baseUrl: string; apiKey: string; model: string }): boolean {
  return (
    input.baseUrl === "" ||
    input.baseUrl === EMBED_BASE_PLACEHOLDER ||
    input.apiKey === "" ||
    input.apiKey === EMBED_KEY_PLACEHOLDER ||
    input.model === "" ||
    input.model === EMBED_MODEL_PLACEHOLDER
  );
}

export type ApiEmbedConfig =
  | { kind: "disabled"; message: typeof API_EMBED_DISABLED_MESSAGE }
  | { kind: "fake"; model: string; gateway: EmbedGateway; info: "嵌入网关使用假实现" }
  | { kind: "http"; model: string; gateway: EmbedGateway; info: "嵌入网关使用 HTTP" };

export type ApiEmbedConfigResult =
  | { ok: true; config: ApiEmbedConfig }
  | { ok: false; exitCode: 1; message: string };

export function loadApiEmbedConfig(env: NodeJS.ProcessEnv): ApiEmbedConfigResult {
  const provider = env.EMBED_PROVIDER?.trim() ?? "";
  if (provider !== "" && provider !== "http") return fail("EMBED_PROVIDER 无效");
  const baseUrl = stripTrailingSlashes(env.EMBED_API_BASE_URL?.trim() ?? "");
  if (baseUrl !== "" && !validHttpUrl(baseUrl)) return fail("EMBED_API_BASE_URL 无效");
  const apiKey = env.EMBED_API_KEY?.trim() ?? "";
  const model = env.EMBED_MODEL?.trim() ?? "";
  if (model.length > 200) return fail("EMBED_MODEL 无效");
  const timeout = parseRange(env.EMBED_TIMEOUT_MS, 30_000, 1000, 120_000, "EMBED_TIMEOUT_MS 无效");
  if (typeof timeout !== "number") return fail(timeout);
  const dimensions = parseDimensions(env.EMBED_DIMENSIONS);
  if (typeof dimensions !== "number") return fail(dimensions);
  if (embedCredentialsArePlaceholder({ baseUrl, apiKey, model })) {
    if ((env.NODE_ENV?.trim() ?? "") === "production") {
      return { ok: true, config: { kind: "disabled", message: API_EMBED_DISABLED_MESSAGE } };
    }
    return {
      ok: true,
      config: {
        kind: "fake",
        model: model === "" ? "fake" : model,
        gateway: createFakeEmbedGateway({ dimensions: EMBED_VECTOR_DIMENSIONS }),
        info: "嵌入网关使用假实现",
      },
    };
  }
  return {
    ok: true,
    config: {
      kind: "http",
      model,
      gateway: createHttpEmbedGateway({ baseUrl, apiKey, model, timeoutMs: timeout }),
      info: "嵌入网关使用 HTTP",
    },
  };
}
```

把 `parseSide` 里现有的这一行：

```typescript
  const placeholder = baseUrl === "" || baseUrl === copy.basePlaceholder || apiKey === "" || apiKey === copy.keyPlaceholder || model === "" || model === copy.modelPlaceholder;
```

换成：

```typescript
  const placeholder = prefix === "EMBED"
    ? embedCredentialsArePlaceholder({ baseUrl, apiKey, model })
    : baseUrl === "" || baseUrl === copy.basePlaceholder || apiKey === "" || apiKey === copy.keyPlaceholder || model === "" || model === copy.modelPlaceholder;
```

`loadPipelineConfig` 在生产占位时仍返回 `fail("嵌入配置仍是占位符")`。不要改那句文案，不要让它返回 `disabled`。

`apps/api/src/gateways/embed/index.ts` 的配置导出改为：

```typescript
export { API_EMBED_DISABLED_MESSAGE, EMBED_VECTOR_DIMENSIONS, embedCredentialsArePlaceholder, loadApiEmbedConfig, loadPipelineConfig } from "./config.js";
export type { ApiEmbedConfig, ApiEmbedConfigResult, PipelineConfig, PipelineConfigResult } from "./config.js";
```

保留文件里已有的 `EMBED_GATEWAY`、假嵌入与 HTTP 网关导出。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
node --import tsx --test --test-concurrency=1 apps/api/test/search-config.test.ts apps/api/test/pipeline-config.test.ts
```

Expected: 两个文件都是 `# fail 0`，退出码 0。`pipeline-config.test.ts` 的原有文案不变。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gateways/embed/config.ts apps/api/src/gateways/embed/index.ts apps/api/test/search-config.test.ts
git commit -m "feat: 让 API 读取嵌入配置且生产占位不退出"
```

---

### Task 6: HTTP 路由与进程装配

**Files:**
- Create: `apps/api/src/wire-search.ts`
- Create: `apps/api/src/interfaces/http/send-search-result.ts`
- Modify: `apps/api/src/interfaces/http/register-photos.ts`
- Modify: `apps/api/src/interfaces/http/error-handler.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/test/pipeline-worker.test.ts`
- Test: `apps/api/test/search-http.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `searchPhotos(deps, actor, body, now)` 与 `SearchDeps`。Task 5 的 `loadApiEmbedConfig`。现有 `requirePrincipal`、`isPrincipal`、`toLibraryActor` 的内联函数、`sendAuthError`
- Produces: `registerPhotoRoutes(app, identity, library, clock, search)` 的第五个参数类型是 `SearchDeps`。`buildApp` 增加可选 `embed?: EmbedGateway` 与 `embedModel?: string`。未传入时检索依赖里的 `embed` 与 `embedModel` 都是 `null`。`POST /photos/search` 先鉴权再解析正文

- [ ] **Step 1: 写会失败的 HTTP 测试**

创建 `apps/api/test/search-http.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { createFakeObjectStorage } from "../src/gateways/storage/fake-object-storage.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";
import { ManualClock } from "./manual-clock.js";

const databaseUrl = requireDatabaseUrl();
const clock = new ManualClock(new Date("2030-01-01T00:00:00.000Z"));
const pool = new pg.Pool({ connectionString: databaseUrl });
const storage = createFakeObjectStorage();
let app: Awaited<ReturnType<typeof buildApp>>;

const testConfig = {
  jwtSecret: "test-jwt-secret-at-least-32-bytes",
  pepper: "test-pepper-at-least-32-bytes-ok",
  accessTtlSeconds: 120,
  refreshTtlSeconds: 30 * 24 * 60 * 60,
  databaseUrl,
};

let tail: Promise<unknown> = Promise.resolve();
function serial(name: string, fn: () => Promise<void>): void {
  test(name, () => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  });
}

test.before(async () => {
  await applySchema(pool);
  app = await buildApp({
    logger: false,
    config: testConfig,
    clock,
    pool,
    storage,
    signedUrlTtlSeconds: 900,
  });
});

test.after(async () => {
  await app.close();
  await pool.end();
});

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function register(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "correct-horse" },
  });
  assert.equal(response.statusCode, 201);
  return String(response.json().accessToken);
}

serial("未授权时不返回正文错误，授权后才校验正文和查询字符串", async () => {
  await pool.query("TRUNCATE TABLE users CASCADE");
  const unauthenticated = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: { "content-type": "application/json" },
    payload: "{",
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.deepEqual(unauthenticated.json(), { error: { code: "unauthorized", message: "未授权" } });
  const token = await register("search-http@example.com");
  const query = await app.inject({
    method: "POST",
    url: "/photos/search?limit=1",
    headers: auth(token),
    payload: { mode: "keyword", q: "海" },
  });
  assert.equal(query.statusCode, 400);
  assert.deepEqual(query.json(), { error: { code: "validation_error", message: "请求不合法" } });
  const arrayBody = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: auth(token),
    payload: [],
  });
  assert.equal(arrayBody.statusCode, 400);
  assert.deepEqual(arrayBody.json(), { error: { code: "validation_error", message: "请求不合法" } });
  const broken = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: { ...auth(token), "content-type": "application/json" },
    payload: "{",
  });
  assert.equal(broken.statusCode, 400);
  assert.deepEqual(broken.json(), { error: { code: "validation_error", message: "请求不合法" } });
  const missing = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: auth(token),
    payload: { mode: "keyword" },
  });
  assert.deepEqual(missing.json(), { error: { code: "validation_error", message: "请求不合法" } });
  const empty = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: auth(token),
    payload: { mode: "keyword", q: "   " },
  });
  assert.equal(empty.statusCode, 400);
  assert.deepEqual(empty.json(), { error: { code: "empty_query", message: "查询为空" } });
  const get = await app.inject({ method: "GET", url: "/photos/search", headers: auth(token) });
  assert.equal(get.statusCode, 404);
});

serial("未注入嵌入时关键词仍可返回空页，语义为 503", async () => {
  await pool.query("TRUNCATE TABLE users CASCADE");
  const token = await register("search-empty@example.com");
  const keyword = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: auth(token),
    payload: { mode: "keyword", q: "海边" },
  });
  assert.equal(keyword.statusCode, 200);
  assert.deepEqual(keyword.json(), { photos: [], nextCursor: null });
  const semantic = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: auth(token),
    payload: { mode: "semantic", q: "海边" },
  });
  assert.equal(semantic.statusCode, 503);
  assert.deepEqual(semantic.json(), { error: { code: "embed_unavailable", message: "嵌入暂不可用" } });
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
node --import tsx --test --test-concurrency=1 apps/api/test/search-http.test.ts
```

Expected: FAIL，状态码不是 401/400/404/200/503 中该用例要求的那个，因为路由还不存在。退出码非 0。

- [ ] **Step 3: 装配路由和进程入口**

创建 `apps/api/src/interfaces/http/send-search-result.ts`：

```typescript
import type { FastifyReply } from "fastify";
import type { SearchResult } from "../../adapters/search/messages.js";

export function sendSearchResult<T>(reply: FastifyReply, result: SearchResult<T>) {
  if (!result.ok) return reply.code(result.status).send({ error: { code: result.code, message: result.message } });
  return reply.code(result.status).send(result.body);
}
```

创建 `apps/api/src/wire-search.ts`：

```typescript
import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import type { LibraryDeps } from "./adapters/library/deps.js";
import type { SearchDeps, SearchLog } from "./adapters/search/deps.js";
import { createSearchRepository } from "./dao/index.js";
import type { EmbedGateway } from "./domain/library/ports.js";

/**
 * 检索组合根装配。禁止把本文件移进五层目录。
 */
export function searchLogFromFastify(logger: FastifyBaseLogger): SearchLog {
  return {
    warn(message, fields) {
      logger.warn(
        {
          userId: fields.userId,
          mode: fields.mode,
          errorCode: fields.errorCode,
          photoId: fields.photoId,
          objectKey: fields.objectKey,
          errorName: fields.errorName,
        },
        message,
      );
    },
  };
}

export function createSearchDeps(input: {
  pool: pg.Pool;
  library: LibraryDeps;
  embed: EmbedGateway | null;
  embedModel: string | null;
  log: SearchLog;
}): SearchDeps {
  return {
    port: createSearchRepository(input.pool),
    embed: input.embed,
    embedModel: input.embedModel,
    library: input.library,
    log: input.log,
  };
}
```

`apps/api/src/interfaces/http/error-handler.ts` 在通用 500 返回之前增加。只影响 `/photos/search`：

```typescript
    if (routeUrl === "/photos/search") {
      const statusCode =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode)
          : 0;
      if (statusCode === 400 || statusCode === 415) {
        return reply.code(400).send({ error: { code: "validation_error", message: "请求不合法" } });
      }
    }
```

不要把 `error.message` 写进响应。其他路由保持原样。

`registerPhotoRoutes` 增加第五个参数 `search: SearchDeps`。在 `app.get("/photos"` 之前注册：

```typescript
import { Readable } from "node:stream";
import type { FastifyRequest } from "fastify";
import { searchPhotos, type SearchDeps } from "../../adapters/index.js";
import type { Principal } from "../../domain/identity/model.js";
import { sendSearchResult } from "./send-search-result.js";

const rawBodies = new WeakMap<FastifyRequest, Buffer>();
const principals = new WeakMap<FastifyRequest, Principal>();

export function registerPhotoRoutes(
  app: FastifyInstance,
  identity: IdentityDeps,
  library: LibraryDeps,
  clock: Clock,
  search: SearchDeps,
): void {
```

这是在现有函数里改签名并插入路由。不要删除已经存在的上传、列表、详情、PATCH、重试和删除路由。在现有 `addContentTypeParser` 之后加入：

```typescript
  app.post(
    "/photos/search",
    {
      onRequest: async (request, reply) => {
        const principal = await requirePrincipal(identity, authorizationHeader(request.headers.authorization));
        if (!isPrincipal(principal)) return sendAuthError(reply, principal);
        principals.set(request, principal);
      },
      preParsing: async (request, _reply, payload) => {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        rawBodies.set(request, Buffer.concat(chunks));
        return Readable.from([Buffer.from("{}")]);
      },
    },
    async (request, reply) => {
      if (reply.sent) return;
      const principal = principals.get(request);
      if (!principal) return reply.code(401).send({ error: { code: "unauthorized", message: "未授权" } });
      const query = request.query;
      if (query && typeof query === "object" && Object.keys(query as object).length > 0) {
        return reply.code(400).send({ error: { code: "validation_error", message: "请求不合法" } });
      }
      const raw = rawBodies.get(request);
      if (!raw || raw.length === 0) {
        return reply.code(400).send({ error: { code: "validation_error", message: "请求不合法" } });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.code(400).send({ error: { code: "validation_error", message: "请求不合法" } });
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return reply.code(400).send({ error: { code: "validation_error", message: "请求不合法" } });
      }
      const result = await searchPhotos(search, toLibraryActor(principal), parsed as Record<string, unknown>, clock.now());
      return sendSearchResult(reply, result);
    },
  );
```

不要给这条路由加 JSON schema。不要在鉴权前返回 400。`requirePrincipal` 只在 `onRequest` 调用一次。

`apps/api/src/app.ts` 的 `BuildAppOptions` 增加 `embed?: EmbedGateway` 与 `embedModel?: string`。`EmbedGateway` 从 `./domain/library/ports.js` 作 type import。在创建 `library` 之后：

```typescript
  const search = createSearchDeps({
    pool,
    library,
    embed: options.embed ?? null,
    embedModel: options.embedModel ?? null,
    log: searchLogFromFastify(app.log),
  });
  registerPhotoRoutes(app, identity, library, clock, search);
```

删掉原来的 `registerPhotoRoutes(app, identity, library, clock)`。`createSearchDeps` 与 `searchLogFromFastify` 从 `./wire-search.js` 导入。`app.ts` 源码不得出现 `EMBED_`、`VISION_`、`PIPELINE_`、`NODE_ENV`。

`apps/api/src/index.ts` 在对象存储占位符 `exit 1` 之后、`listen` 之前插入。存储检查失败时仍然先退出，不要先读嵌入：

```typescript
import { loadApiEmbedConfig } from "./gateways/embed/config.js";
import type { EmbedGateway } from "./domain/library/ports.js";

const embedLoaded = loadApiEmbedConfig(process.env);
if (!embedLoaded.ok) {
  console.error(embedLoaded.message);
  process.exit(embedLoaded.exitCode);
}

let embed: EmbedGateway | undefined;
let embedModel: string | undefined;
if (embedLoaded.config.kind === "disabled") {
  console.error("嵌入配置仍是占位符，语义检索不可用");
} else {
  embed = embedLoaded.config.gateway;
  embedModel = embedLoaded.config.model;
}

const app = await buildApp({
  config,
  storage,
  signedUrlTtlSeconds: storageConfig.signedUrlTtlSeconds,
  embed,
  embedModel,
});

if (embedLoaded.config.kind === "fake") app.log.info("嵌入网关使用假实现");
if (embedLoaded.config.kind === "http") app.log.info("嵌入网关使用 HTTP");
```

用上面的 `buildApp({...})` 替换现有那次调用。INFO 只传静态字符串，不传基址、密钥或模型。`index.ts` 不得出现 `VISION_` 或 `PIPELINE_`。

`apps/api/test/pipeline-worker.test.ts` 里把：

```typescript
  assert.equal(api.includes("VISION_"), false);
  assert.equal(api.includes("EMBED_"), false);
```

换成：

```typescript
  assert.equal(api.includes("VISION_"), false);
  assert.equal(api.includes("PIPELINE_"), false);
  assert.equal(api.includes("loadApiEmbedConfig"), true);
  assert.equal(api.includes("嵌入配置仍是占位符，语义检索不可用"), true);
```

保留该测试里 worker 不监听、`SIGTERM` 与对象存储占位符的断言。不要修改 `worker.ts`。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
node --import tsx --test --test-concurrency=1 apps/api/test/search-http.test.ts apps/api/test/pipeline-worker.test.ts apps/api/test/storage-startup.test.ts apps/api/test/health.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 四个测试文件 `# fail 0`。`tsc` 退出码 0。`storage-startup` 仍因 `S3_SIGNED_URL_TTL 超过 7 天` 退出，且 stderr 不含 `SECRET`。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/wire-search.ts apps/api/src/interfaces/http/send-search-result.ts apps/api/src/interfaces/http/register-photos.ts apps/api/src/interfaces/http/error-handler.ts apps/api/src/app.ts apps/api/src/index.ts apps/api/test/pipeline-worker.test.ts apps/api/test/search-http.test.ts
git commit -m "feat: 注册 POST /photos/search 并装配嵌入网关"
```

---

### Task 7: 关键词集成

**Files:**
- Create: `apps/api/test/search-fixtures.ts`
- Create: `apps/api/test/search.test.ts`
- Test: `apps/api/test/search.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `buildApp`。`formatVectorLiteral(values, 1536)`、`deterministicEmbedding(text, 1536)` 只给夹具插入向量，本任务的 HTTP 断言不调用语义模式
- Produces: `apps/api/test/search-fixtures.ts` 导出
  - `bearer(token: string): { authorization: string }`
  - `registerUser(app: Awaited<ReturnType<typeof buildApp>>, email: string): Promise<{ accessToken: string; userId: string }>`
  - `createApiKey(app: Awaited<ReturnType<typeof buildApp>>, accessToken: string): Promise<string>`
  - `insertSearchPhoto(pool: pg.Pool, input: SearchPhotoInsert): Promise<void>`
  - `SearchPhotoInsert = { id: string; ownerId: string; description: string | null; tags?: string[]; status?: "processing" | "ready" | "failed"; takenAt?: Date | null; locationText?: string | null; createdAt: Date; thumbKey?: string | null; embedding?: number[] | null; model?: string }`

- [ ] **Step 1: 写夹具和会失败的关键词集成测试**

创建 `apps/api/test/search-fixtures.ts`：

```typescript
import assert from "node:assert/strict";
import pg from "pg";
import type { buildApp } from "../src/app.js";
import { formatVectorLiteral } from "../src/dao/vector-literal.js";

type App = Awaited<ReturnType<typeof buildApp>>;

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export async function registerUser(app: App, email: string): Promise<{ accessToken: string; userId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "correct-horse" },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  return { accessToken: String(body.accessToken), userId: String(body.user.id) };
}

export async function createApiKey(app: App, accessToken: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api-keys",
    headers: bearer(accessToken),
    payload: { name: "agent" },
  });
  assert.equal(response.statusCode, 201);
  return String(response.json().secret);
}

export async function insertSearchPhoto(
  pool: pg.Pool,
  input: {
    id: string;
    ownerId: string;
    description: string | null;
    tags?: string[];
    status?: "processing" | "ready" | "failed";
    takenAt?: Date | null;
    locationText?: string | null;
    createdAt: Date;
    thumbKey?: string | null;
    embedding?: number[] | null;
    model?: string;
  },
): Promise<void> {
  const thumbKey = input.thumbKey === undefined ? `owners/${input.ownerId}/photos/${input.id}/thumb` : input.thumbKey;
  await pool.query(
    `INSERT INTO photos (
       id, owner_id, object_key, thumb_key, content_type, byte_size,
       taken_at, location_text, description, tags, status, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'image/jpeg', 12345,
       $5, $6, $7, $8, $9, $10, $10
     )`,
    [
      input.id,
      input.ownerId,
      `owners/${input.ownerId}/photos/${input.id}/original`,
      thumbKey,
      input.takenAt === undefined ? input.createdAt : input.takenAt,
      input.locationText ?? null,
      input.description,
      input.tags ?? [],
      input.status ?? "ready",
      input.createdAt,
    ],
  );
  if (input.embedding) {
    await pool.query(`INSERT INTO photo_embeddings (photo_id, embedding, model) VALUES ($1, $2::vector, $3)`, [
      input.id,
      formatVectorLiteral(input.embedding, 1536),
      input.model ?? "test-model",
    ]);
  }
}
```

创建 `apps/api/test/search.test.ts`。文件后半的语义用例由 Task 8 追加，本任务只写关键词：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { encodeKeywordCursor } from "../src/domain/search/index.js";
import { createFakeEmbedGateway } from "../src/gateways/embed/fake-embed.js";
import { createFakeObjectStorage } from "../src/gateways/storage/fake-object-storage.js";
import { applySchema, requireDatabaseUrl } from "./apply-schema.js";
import { ManualClock } from "./manual-clock.js";
import { bearer, createApiKey, insertSearchPhoto, registerUser } from "./search-fixtures.js";

const databaseUrl = requireDatabaseUrl();
const START = new Date("2030-03-01T00:00:00.000Z");
const clock = new ManualClock(START);
const pool = new pg.Pool({ connectionString: databaseUrl });
const storage = createFakeObjectStorage();
const embed = createFakeEmbedGateway({ dimensions: 1536 });
let app: Awaited<ReturnType<typeof buildApp>>;

const appConfig = {
  jwtSecret: "test-jwt-secret-at-least-32-bytes",
  pepper: "test-pepper-at-least-32-bytes-ok",
  accessTtlSeconds: 120,
  refreshTtlSeconds: 30 * 24 * 60 * 60,
  databaseUrl,
};

let tail: Promise<unknown> = Promise.resolve();
function serial(name: string, fn: () => Promise<void>): void {
  test(name, () => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  });
}

test.before(async () => {
  await applySchema(pool);
  app = await buildApp({
    logger: false,
    config: appConfig,
    clock,
    pool,
    storage,
    signedUrlTtlSeconds: 900,
    embed,
    embedModel: "fake",
  });
});

test.after(async () => {
  await app.close();
  await pool.end();
});

async function reset(): Promise<void> {
  clock.set(START);
  await pool.query("TRUNCATE TABLE users CASCADE");
}

serial("关键词命中描述或标签，不命中只有地点文本的照片", async () => {
  await reset();
  const owner = await registerUser(app, "keyword-a@example.com");
  const boat = "77777777-7777-4777-8777-777777777771";
  const tagOnly = "77777777-7777-4777-8777-777777777772";
  const place = "77777777-7777-4777-8777-777777777773";
  await insertSearchPhoto(pool, {
    id: boat,
    ownerId: owner.userId,
    description: "Red Boat",
    tags: ["Seaside"],
    createdAt: new Date("2030-03-03T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: tagOnly,
    ownerId: owner.userId,
    description: null,
    tags: ["Seaside"],
    createdAt: new Date("2030-03-02T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: place,
    ownerId: owner.userId,
    description: "湖",
    tags: [],
    locationText: "red harbor",
    createdAt: new Date("2030-03-01T00:00:00.000Z"),
  });
  const red = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "red" },
  });
  assert.equal(red.statusCode, 200);
  assert.deepEqual(red.json().photos.map((photo: { id: string }) => photo.id), [boat]);
  assert.equal(red.json().photos[0].score, null);
  assert.equal(red.json().photos[0].status, "ready");
  const folded = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "Red" },
  });
  assert.deepEqual(folded.json().photos.map((photo: { id: string }) => photo.id), [boat]);
  const side = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "side" },
  });
  assert.deepEqual(side.json().photos.map((photo: { id: string }) => photo.id), [boat, tagOnly]);
});

serial("字面量通配符与不分词", async () => {
  await reset();
  const owner = await registerUser(app, "literal@example.com");
  const literal = "88888888-8888-4888-8888-888888888881";
  const other = "88888888-8888-4888-8888-888888888882";
  const phrase = "88888888-8888-4888-8888-888888888883";
  const split = "88888888-8888-4888-8888-888888888884";
  await insertSearchPhoto(pool, { id: literal, ownerId: owner.userId, description: "100%_ok", createdAt: START });
  await insertSearchPhoto(pool, { id: other, ownerId: owner.userId, description: "plain", createdAt: START });
  await insertSearchPhoto(pool, { id: phrase, ownerId: owner.userId, description: "红 船", createdAt: START });
  await insertSearchPhoto(pool, { id: split, ownerId: owner.userId, description: "红", tags: ["船"], createdAt: START });
  const exact = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "100%_ok" },
  });
  assert.deepEqual(exact.json().photos.map((photo: { id: string }) => photo.id), [literal]);
  const percent = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "%" },
  });
  assert.deepEqual(percent.json().photos.map((photo: { id: string }) => photo.id), [literal]);
  const spaced = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "红 船" },
  });
  assert.deepEqual(spaced.json().photos.map((photo: { id: string }) => photo.id), [phrase]);
});

serial("标签与时间过滤，非 ready 不返回", async () => {
  await reset();
  const owner = await registerUser(app, "filter@example.com");
  const both = "99999999-9999-4999-8999-999999999991";
  const lower = "99999999-9999-4999-8999-999999999992";
  const outside = "99999999-9999-4999-8999-999999999993";
  const undated = "99999999-9999-4999-8999-999999999994";
  const processing = "99999999-9999-4999-8999-999999999995";
  const failed = "99999999-9999-4999-8999-999999999996";
  await insertSearchPhoto(pool, {
    id: both,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside", "Trip"],
    takenAt: new Date("2026-06-01T00:00:00.000Z"),
    createdAt: new Date("2030-03-04T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: lower,
    ownerId: owner.userId,
    description: "boat",
    tags: ["seaside"],
    takenAt: new Date("2026-06-01T00:00:00.000Z"),
    createdAt: new Date("2030-03-03T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: outside,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside"],
    takenAt: new Date("2025-01-01T00:00:00.000Z"),
    createdAt: new Date("2030-03-02T00:00:00.000Z"),
  });
  await insertSearchPhoto(pool, {
    id: undated,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside"],
    takenAt: null,
    createdAt: new Date("2030-03-01T00:00:00.000Z"),
  });
  const leftover = Array.from({ length: 1536 }, () => 0.1);
  await insertSearchPhoto(pool, {
    id: processing,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside"],
    status: "processing",
    createdAt: START,
    embedding: leftover,
  });
  await insertSearchPhoto(pool, {
    id: failed,
    ownerId: owner.userId,
    description: "boat",
    tags: ["Seaside"],
    status: "failed",
    createdAt: START,
    embedding: leftover,
  });
  const filtered = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: {
      mode: "keyword",
      q: "boat",
      tags: ["Seaside"],
      takenFrom: "2026-01-01T00:00:00.000Z",
      takenTo: "2026-12-31T23:59:59.999Z",
      status: "ready",
    },
  });
  assert.deepEqual(filtered.json().photos.map((photo: { id: string }) => photo.id), [both]);
  const openEnded = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "boat", tags: ["Seaside"] },
  });
  const openIds = openEnded.json().photos.map((photo: { id: string }) => photo.id);
  assert.equal(openIds.includes(undated), true);
  assert.equal(openIds.includes(processing), false);
  assert.equal(openIds.includes(failed), false);
  assert.equal(openIds.includes(outside), true);
  const explicitReady = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "boat", tags: ["Seaside"], status: "ready" },
  });
  assert.deepEqual(explicitReady.json().photos.map((photo: { id: string }) => photo.id), openIds);
  const badStatus = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "boat", status: "failed" },
  });
  assert.equal(badStatus.statusCode, 400);
  assert.deepEqual(badStatus.json(), { error: { code: "validation_error", message: "请求不合法" } });
  const inverted = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: {
      mode: "keyword",
      q: "boat",
      takenFrom: "2026-12-31T00:00:00.000Z",
      takenTo: "2026-01-01T00:00:00.000Z",
    },
  });
  assert.equal(inverted.statusCode, 400);
  assert.deepEqual(inverted.json(), { error: { code: "validation_error", message: "时间范围不合法" } });
});

serial("JWT 与 API Key 顺序一致，游标不会读出别人的照片", async () => {
  await reset();
  const owner = await registerUser(app, "owner-a@example.com");
  const other = await registerUser(app, "owner-b@example.com");
  const key = await createApiKey(app, owner.accessToken);
  const otherKey = await createApiKey(app, other.accessToken);
  const ownId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const otherId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const ownCreated = new Date("2030-03-02T00:00:00.000Z");
  const otherCreated = new Date("2030-03-03T00:00:00.000Z");
  await insertSearchPhoto(pool, { id: ownId, ownerId: owner.userId, description: "Red Boat", createdAt: ownCreated });
  await insertSearchPhoto(pool, { id: otherId, ownerId: other.userId, description: "Red Boat", createdAt: otherCreated });
  const byJwt = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "red" },
  });
  const byKey = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(key),
    payload: { mode: "keyword", q: "red" },
  });
  assert.deepEqual(
    byJwt.json().photos.map((photo: { id: string; score: null }) => [photo.id, photo.score]),
    byKey.json().photos.map((photo: { id: string; score: null }) => [photo.id, photo.score]),
  );
  assert.deepEqual(byJwt.json().photos.map((photo: { id: string }) => photo.id), [ownId]);
  const otherView = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(other.accessToken),
    payload: { mode: "keyword", q: "red" },
  });
  const otherByKey = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(otherKey),
    payload: { mode: "keyword", q: "red" },
  });
  assert.deepEqual(otherView.json().photos.map((photo: { id: string }) => photo.id), [otherId]);
  assert.deepEqual(otherByKey.json().photos.map((photo: { id: string }) => photo.id), [otherId]);
  const stolen = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "red", cursor: encodeKeywordCursor(otherCreated, otherId) },
  });
  assert.equal(stolen.statusCode, 200);
  assert.equal(
    stolen.json().photos.some((photo: { id: string }) => photo.id === otherId),
    false,
  );
});

serial("关键词结果带签名 URL，列表元素没有 score", async () => {
  await reset();
  const owner = await registerUser(app, "signed@example.com");
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  await insertSearchPhoto(pool, {
    id,
    ownerId: owner.userId,
    description: "海边",
    createdAt: START,
  });
  const found = await app.inject({
    method: "POST",
    url: "/photos/search",
    headers: bearer(owner.accessToken),
    payload: { mode: "keyword", q: "海边" },
  });
  const photo = found.json().photos[0];
  assert.equal(photo.status, "ready");
  assert.equal(typeof photo.originalUrl, "string");
  assert.equal(typeof photo.thumbUrl, "string");
  assert.equal(photo.originalUrlExpiresAt, new Date(START.getTime() + 900 * 1000).toISOString());
  assert.equal(photo.thumbUrlExpiresAt, new Date(START.getTime() + 900 * 1000).toISOString());
  assert.equal(Object.hasOwn(photo, "objectKey"), false);
  assert.equal(Object.hasOwn(photo, "thumbKey"), false);
  const listed = await app.inject({ method: "GET", url: "/photos", headers: bearer(owner.accessToken) });
  assert.equal(listed.statusCode, 200);
  assert.equal(Object.hasOwn(listed.json().photos[0], "score"), false);
});
```

- [ ] **Step 2: 运行测试，确认当前失败原因已经消失**

本任务的路由和 SQL 已在前面的任务实现。这一步仍先运行。若夹具或断言写错，失败信息会指出具体行，修正测试或接线，不要放宽「不返回别人的照片」和「score 为 null」。

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
node --import tsx --test --test-concurrency=1 apps/api/test/search.test.ts
```

Expected: 五个测试通过，`# fail 0`，退出码 0。若失败，先核对插入的 `owner_id` 是否就是 `registerUser` 返回的 `userId`，以及 `ILIKE` 的转义是否仍是一个反斜杠。

- [ ] **Step 3: 不在本任务追加语义用例**

语义排序、分页、502 与 503 留在 Task 8。本任务不要改 `searchPhotos` 去调用 `embeddingInput`。

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/search-fixtures.ts apps/api/test/search.test.ts
git commit -m "test: 覆盖关键词检索的过滤、隔离与签名"
```

---

### Task 8: 语义集成

**Files:**
- Modify: `apps/api/test/search.test.ts`（只在文件末尾追加测试，不改 Task 7 已有用例的断言）
- Test: `apps/api/test/search.test.ts`

**Interfaces:**
- Consumes: Task 7 导出的 `bearer`、`registerUser`、`insertSearchPhoto`，以及该文件里已有的 `app`、`pool`、`clock`、`START`、`reset`、`serial`、`embed`。`embed` 是 `createFakeEmbedGateway({ dimensions: 1536 })`，但默认假嵌入没有「记录 text」的字段。本任务在语义用例内部另建一个记录文本的 `EmbedGateway`，用新的 `buildApp` 注入，不要改 Task 7 的 `app`
- Produces: 设计第 10 节第 6、8、9、10、11、12 条里尚未由 Task 7 覆盖的 HTTP 断言。语义查询文本就是 trim 后的 `q`

- [ ] **Step 1: 在 search.test.ts 末尾追加语义测试**

在文件末尾追加下面的测试。它们使用文件顶部已经导入的符号；若 `deterministicEmbedding` 与 `formatVectorLiteral` 尚未导入，补上这两行 import，不要改已有 import 的路径：

```typescript
import { formatVectorLiteral } from "../src/dao/vector-literal.js";
import type { EmbedGateway } from "../src/domain/library/ports.js";
import { deterministicEmbedding } from "../src/gateways/embed/deterministic.js";
```

`encodeKeywordCursor` 已由 Task 7 从 `../src/domain/search/index.js` 导入，不要再写一条同名导入。追加：

```typescript
serial("有向量的非 ready 照片不是语义命中，省略 status 与 ready 相同", async () => {
  await reset();
  const owner = await registerUser(app, "semantic-status@example.com");
  const readyId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
  const failedId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
  const vector = deterministicEmbedding("red", 1536);
  await insertSearchPhoto(pool, {
    id: readyId,
    ownerId: owner.userId,
    description: "red",
    createdAt: START,
    embedding: vector,
  });
  await insertSearchPhoto(pool, {
    id: failedId,
    ownerId: owner.userId,
    description: "red",
    status: "failed",
    createdAt: START,
    embedding: vector,
  });
  const texts: string[] = [];
  const recording: EmbedGateway = {
    async embed(input) {
      texts.push(input.text);
      return { ok: true, values: deterministicEmbedding(input.text, 1536) };
    },
  };
  const semanticApp = await buildApp({
    logger: false,
    config: appConfig,
    clock,
    pool,
    storage,
    signedUrlTtlSeconds: 900,
    embed: recording,
    embedModel: "fake",
  });
  try {
    const ready = await semanticApp.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "red", status: "ready" },
    });
    const omitted = await semanticApp.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "red" },
    });
    assert.deepEqual(ready.json().photos.map((photo: { id: string }) => photo.id), [readyId]);
    assert.deepEqual(omitted.json().photos.map((photo: { id: string }) => photo.id), [readyId]);
    assert.deepEqual(texts, ["red", "red"]);
  } finally {
    await semanticApp.close();
  }
});

serial("假嵌入按同一文本稳定排序并分页，关键词游标不能用于语义", async () => {
  await reset();
  const owner = await registerUser(app, "semantic-order@example.com");
  const redA = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
  const redB = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
  const blue = "dddddddd-dddd-4ddd-8ddd-ddddddddddd3";
  const redVector = deterministicEmbedding("red", 1536);
  const blueVector = deterministicEmbedding("blue", 1536);
  await insertSearchPhoto(pool, { id: redB, ownerId: owner.userId, description: "later", createdAt: START, embedding: redVector, model: "m1" });
  await insertSearchPhoto(pool, { id: redA, ownerId: owner.userId, description: "earlier", createdAt: START, embedding: redVector, model: "m2" });
  await insertSearchPhoto(pool, { id: blue, ownerId: owner.userId, description: "blue", createdAt: START, embedding: blueVector, model: "m1" });
  const texts: string[] = [];
  const recording: EmbedGateway = {
    async embed(input) {
      texts.push(input.text);
      return { ok: true, values: deterministicEmbedding(input.text, 1536) };
    },
  };
  const semanticApp = await buildApp({
    logger: false,
    config: appConfig,
    clock,
    pool,
    storage,
    signedUrlTtlSeconds: 900,
    embed: recording,
    embedModel: "fake",
  });
  try {
    const first = await semanticApp.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "red" },
    });
    const second = await semanticApp.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "red" },
    });
    assert.deepEqual(texts, ["red", "red"]);
    assert.equal(texts.some((text) => text.includes("\n")), false);
    const expected = await pool.query(
      `SELECT p.id::text AS id,
              round((1 - (e.embedding <=> $2::vector))::numeric, 6)::text AS score_text
       FROM photos p
       INNER JOIN photo_embeddings e ON e.photo_id = p.id
       WHERE p.owner_id = $1 AND p.status = 'ready'
       ORDER BY round((1 - (e.embedding <=> $2::vector))::numeric, 6) DESC, p.id ASC`,
      [owner.userId, formatVectorLiteral(redVector, 1536)],
    );
    const body = first.json();
    assert.deepEqual(
      body.photos.map((photo: { id: string }) => photo.id),
      expected.rows.map((row) => String(row.id)),
    );
    assert.deepEqual(
      second.json().photos.map((photo: { id: string; score: number }) => [photo.id, photo.score]),
      body.photos.map((photo: { id: string; score: number }) => [photo.id, photo.score]),
    );
    assert.equal(body.photos[0].score, 1);
    assert.equal(body.photos[1].score, 1);
    assert.equal(body.photos[0].id < body.photos[1].id, true);
    assert.equal(body.photos[2].id, blue);
    assert.equal(body.photos[2].score < 1, true);
    const page = await semanticApp.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "red", limit: 1 },
    });
    assert.equal(page.json().photos.length, 1);
    assert.equal(page.json().photos[0].id, body.photos[0].id);
    const next = await semanticApp.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "red", limit: 1, cursor: page.json().nextCursor },
    });
    assert.equal(next.json().photos[0].id, body.photos[1].id);
    assert.notEqual(next.json().photos[0].id, body.photos[0].id);
    const keywordCursor = encodeKeywordCursor(START, redA);
    const rejected = await semanticApp.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "red", cursor: keywordCursor },
    });
    assert.equal(rejected.statusCode, 400);
    assert.deepEqual(rejected.json(), { error: { code: "validation_error", message: "请求不合法" } });
  } finally {
    await semanticApp.close();
  }
});

serial("嵌入失败不查询，空查询与超长查询在调用前拒绝", async () => {
  await reset();
  const owner = await registerUser(app, "semantic-error@example.com");
  let sql = 0;
  const original = pool.query.bind(pool);
  pool.query = (async (...args: Parameters<typeof original>) => {
    const text = String(args[0]);
    if (text.includes("<=>")) sql += 1;
    return original(...args);
  }) as typeof pool.query;
  try {
    const unavailable = await buildApp({
      logger: false,
      config: appConfig,
      clock,
      pool,
      storage,
      signedUrlTtlSeconds: 900,
      embed: { async embed() { return { ok: false, kind: "embed_unavailable" }; } },
      embedModel: "fake",
    });
    const down = await unavailable.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "red" },
    });
    assert.equal(down.statusCode, 503);
    assert.deepEqual(down.json(), { error: { code: "embed_unavailable", message: "嵌入暂不可用" } });
    await unavailable.close();
    const rejectedApp = await buildApp({
      logger: false,
      config: appConfig,
      clock,
      pool,
      storage,
      signedUrlTtlSeconds: 900,
      embed: { async embed() { return { ok: true, values: [1, 2, 3] }; } },
      embedModel: "fake",
    });
    const rejected = await rejectedApp.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "red" },
    });
    assert.equal(rejected.statusCode, 502);
    assert.deepEqual(rejected.json(), { error: { code: "embed_rejected", message: "嵌入被拒绝" } });
    assert.equal(JSON.stringify(rejected.json()).includes("1536"), false);
    await rejectedApp.close();
    assert.equal(sql, 0);
    const empty = await app.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "   " },
    });
    assert.deepEqual(empty.json(), { error: { code: "empty_query", message: "查询为空" } });
    const missing = await app.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic" },
    });
    assert.equal(missing.statusCode, 400);
    assert.deepEqual(missing.json(), { error: { code: "validation_error", message: "请求不合法" } });
    const tooLong = await app.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "keyword", q: "a".repeat(501) },
    });
    assert.deepEqual(tooLong.json(), { error: { code: "query_too_long", message: "查询过长" } });
    const anonymous = await app.inject({
      method: "POST",
      url: "/photos/search",
      payload: { mode: "semantic", q: "" },
    });
    assert.equal(anonymous.statusCode, 401);
    assert.deepEqual(anonymous.json(), { error: { code: "unauthorized", message: "未授权" } });
  } finally {
    pool.query = original;
  }
});

serial("同一个未注入嵌入的应用里关键词可用、语义不可用", async () => {
  await reset();
  const plain = await buildApp({
    logger: false,
    config: appConfig,
    clock,
    pool,
    storage,
    signedUrlTtlSeconds: 900,
  });
  try {
    const owner = await registerUser(plain, "no-embed@example.com");
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
    await insertSearchPhoto(pool, { id, ownerId: owner.userId, description: "海边", createdAt: START });
    const keyword = await plain.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "keyword", q: "海边" },
    });
    assert.equal(keyword.statusCode, 200);
    assert.equal(keyword.json().photos[0].id, id);
    assert.equal(keyword.json().photos[0].score, null);
    const semantic = await plain.inject({
      method: "POST",
      url: "/photos/search",
      headers: bearer(owner.accessToken),
      payload: { mode: "semantic", q: "海边" },
    });
    assert.equal(semantic.statusCode, 503);
    assert.deepEqual(semantic.json(), { error: { code: "embed_unavailable", message: "嵌入暂不可用" } });
  } finally {
    await plain.close();
  }
});
```

包装 `pool.query` 的用例必须在 `finally` 里恢复原来的 `query`，否则后续测试会叠多层包装。

- [ ] **Step 2: 运行集成测试**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
node --import tsx --test --test-concurrency=1 apps/api/test/search.test.ts
```

Expected: Task 7 的五个测试加上本任务的四个测试都通过，`# fail 0`，退出码 0。两张 `red` 的 `score` 都是 JSON 数字 `1`，`blue` 的 `score` 小于 1。网关收到的文本是 `red`，不是带换行的嵌入输入。

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/search.test.ts
git commit -m "test: 覆盖语义排序、分页与嵌入失败"
```

---

### Task 9: 边界检查与阶段完成

**Files:**
- Modify: `apps/api/test/library-boundaries.test.ts`
- Modify: `specs/phases/04-search.md`
- Modify: `specs/SPEC.md`

**Interfaces:**
- Consumes: Task 8 的集成测试已经通过。`scripts/check-layer-boundaries.mjs` 保持现状
- Produces: 阶段规格状态 `done`，五条验收框勾上。`specs/SPEC.md` 阶段 4 为 `done`。设计文件状态行仍是 `已定稿（待实现）`

这个任务只有在下面的命令都成功之后才能改阶段状态。测试失败时不要把状态改成 `done`。

- [ ] **Step 1: 扩展源码边界断言**

不要修改 `scripts/check-layer-boundaries.mjs`。在 `apps/api/test/library-boundaries.test.ts` 末尾追加一个测试，保留文件里已有的个人库测试：

```typescript
test("检索领域不引用照片库，适配层不跨到 DAO 或网关", async () => {
  const searchDomain = await readAllTypeScriptSources(path.join(apiRoot, "src/domain/search"));
  const searchAdapters = await readAllTypeScriptSources(path.join(apiRoot, "src/adapters/search"));
  const libraryAdapters = await readAllTypeScriptSources(path.join(apiRoot, "src/adapters/library"));
  for (const marker of ["domain/library", "domain/identity", "domain/album", "/dao", "/gateways", "fastify", "undici"]) {
    assert.equal(searchDomain.includes(marker), false, marker);
  }
  assert.equal(searchDomain.includes("from \"pg\""), false);
  assert.equal(searchDomain.includes("node:http"), false);
  assert.equal(searchDomain.includes("node:https"), false);
  assert.equal(/\/dao/.test(searchAdapters), false);
  assert.equal(/\/gateways/.test(searchAdapters), false);
  assert.equal(searchAdapters.includes("embeddingInput"), false);
  assert.equal(libraryAdapters.includes("adapters/search"), false);
  const logger = await readFile(path.join(apiRoot, "src/interfaces/http/auth-logger.ts"), "utf8");
  for (const path of ["req.body", "embedding", "originalUrl", "thumbUrl"]) {
    assert.equal(logger.includes(`"${path}"`), true, path);
  }
  assert.equal(logger.includes("photos[*].score"), false);
});
```

`readFile` 若尚未从 `node:fs/promises` 导入，把它加进该文件已有的 import。不要在 `domain/search` 或 `adapters/search` 的注释里写下 `domain/library` 这个路径字符串，否则上面的源码扫描会失败。需要说明依赖方向时写「照片库领域」。

- [ ] **Step 2: 跑验收命令**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npm test
npx tsc -p apps/api/tsconfig.json --noEmit
npm run build -w apps/api
```

Expected: `npm test` 先打印 `分层边界检查通过`，然后 API 测试 `# fail 0`，退出码 0。`tsc` 与 `build` 退出码 0。身份测试、`GET /health` 和个人库测试在 `buildApp` 不接收 `embed` 时仍然通过。

- [ ] **Step 3: 勾上阶段验收**

`specs/phases/04-search.md` 的状态行改为：

```markdown
**状态：** done
```

验收列表改为：

```markdown
- [x] 关键词能命中描述或标签中的词，且不返回别人的照片
- [x] 自然语言查询能召回语义相近、状态允许展示的照片（测试可使用假嵌入，保证排序稳定）
- [x] 尚未 `ready` 且没有嵌入的照片不会被当成语义命中
- [x] 检索接口在 JWT 与 API Key 下行为一致
- [x] 领域层边界检查仍然通过
```

不要修改设计文件开头的「状态：已定稿（待实现）」。

`specs/SPEC.md` 阶段 4 那一行改为：

```markdown
| 4 | [phases/04-search.md](phases/04-search.md) | done | 关键词与向量检索 |
```

不要勾选「任何阶段的完成定义」那一组模板复选框。

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/library-boundaries.test.ts specs/phases/04-search.md specs/SPEC.md
git commit -m "docs: 将 Phase 4 状态标记为 done"
```

---

## 自检（计划作者已完成，实现时不要重做这一节）

实现代理跳过本节。下列是写计划时对照设计合同的覆盖记录。

| 设计 | 落点 | 结论 |
|------|------|------|
| §2 `POST /photos/search`，必填 `mode` 与 `q` | Global Constraints；Task 2 `parseSearchBody`；Task 6 路由 | 已覆盖 |
| §2 / §4.2 关键词字面 `ILIKE`，先转义 `\` | Task 2 `keywordPattern`；Task 3 `ESCAPE '\'` | 已覆盖 |
| §2 / §4.1 标签、时间、`status`、`limit`、未知键 | Task 2；Task 7 HTTP | 已覆盖 |
| §4.3 只返回本人 `ready`；语义还要嵌入行；`failed` 上的向量不算 | Task 3 SQL；Task 7 隔离；Task 8 非 ready | 已覆盖 |
| §4.4 查询原样嵌入，余弦 `<=>`，6 位 `score_text`，不按 `model` 过滤 | Task 3 `SCORE_EXPR`；Task 4 `text: query.q`；Task 8 记录 `red` | 已覆盖 |
| §4.5 两种键集游标，列表游标与跨模式游标拒绝 | Task 2；Task 7 别人的游标；Task 8 `limit: 1` | 已覆盖 |
| §5 SQL 谓词 | Task 3 的 `KEYWORD_SQL` 与 `SEMANTIC_SQL` | 已覆盖 |
| §6 JWT 与 API Key 一致，照片 JSON 复用 `toPhotoResponse` 并始终带 `score` | Task 4；Task 6；Task 7 | 已覆盖 |
| §6 `GET /photos` 不加 `score` | Task 7 列表断言。没有修改列表实现的任务 | 已覆盖 |
| §7 不建 HNSW / IVFFlat，注释写切换条件 | Task 1。没有 `CREATE INDEX ... USING hnsw` 的任务 | 已覆盖 |
| §8 错误码，502 不泄露向量与维度 | Task 4 日志与响应断言；Task 6 401 先于正文；Task 8 | 已覆盖 |
| §9 生产占位 503 且 API 不退出；worker 仍退出；假嵌入只在非 production | Task 5 `loadApiEmbedConfig` 与 `loadPipelineConfig`；Task 6 `index.ts` | 已覆盖 |
| §9 日志不记录 `q`，redact 保留 `embedding` / URL | Task 4；Task 9 读 `auth-logger.ts` | 已覆盖 |
| §3 / §10 第 13 条 领域不引用照片库，不改分层脚本 | Task 9 源码断言。`check-layer-boundaries.mjs` 不在修改列表里 | 已覆盖 |
| §10 第 1–12 条 | Task 7 关键词；Task 8 语义与错误 | 已覆盖 |
| §11 五条阶段验收 | Task 9 才勾选 | 已覆盖 |
| §12 不做共享册、跨用户、以图搜图、网页、人脸、`pg_trgm`、限流 | Global Constraints，无对应实现任务 | 已覆盖 |
| 子代理使用 Composer 2.5，不用 fast | Global Constraints 与执行交接 | 已覆盖 |
| `app.ts` 不出现 `EMBED_`，现有个人库测试仍能构造应用 | Task 6；Task 8 的未注入用例 | 已覆盖 |

占位符扫描：计划正文的实现步骤都已展开成可照抄的代码。`parseSearchBody`、`keywordPattern`、`SearchPort`、`createSearchRepository`、`searchPhotos`、`SearchDeps`、`loadApiEmbedConfig`、`API_EMBED_DISABLED_MESSAGE`、`encodeKeywordCursor`、`encodeSemanticCursor`、`isScoreText` 在前后任务里的名字一致。

查询文本进入 `embed({ model, text: query.q })`。没有任何任务把 `q` 交给 `embeddingInput`。语义 SQL 不包含 `e.model`。`schema.sql` 的改动只在 Task 1 的注释。

## 执行交接

计划保存在 `docs/superpowers/plans/2026-11-06-openalbum-phase4-search.md`。实现时二选一：

1. **Subagent-Driven（推荐）**：每个任务一个新的子代理，任务之间做审查。子代理使用 Composer 2.5，不用 fast 模式。所需技能是 `superpowers:subagent-driven-development`。
2. **Inline Execution**：在同一会话里按 `superpowers:executing-plans` 批量执行，并在检查点停下来审查。

写这份计划的提交不实现检索代码。
