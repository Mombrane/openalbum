# OpenAlbum Phase 4 — 检索设计

日期：2026-11-06  
状态：已定稿（待实现）  
依赖：Phase 3 为 `done`  
对应规格：[`specs/phases/04-search.md`](../../../specs/phases/04-search.md)

本文件是 Phase 4 的实现合同。权威索引仍是 [`specs/SPEC.md`](../../../specs/SPEC.md)。产品背景见 [`2026-11-03-ai-native-photo-album-design.md`](2026-11-03-ai-native-photo-album-design.md)。个人库的权限、列表、详情与签名 URL 见 [`2026-11-04-openalbum-phase2-personal-library-design.md`](2026-11-04-openalbum-phase2-personal-library-design.md)。处理流水线、嵌入文本、假嵌入、`photo_embeddings` 与 `ready` 不变量见 [`2026-11-06-openalbum-phase3-processing-pipeline-design.md`](2026-11-06-openalbum-phase3-processing-pipeline-design.md)。领域划分见 [`specs/domain/overview.md`](../../../specs/domain/overview.md)。未写进本文的行为，实现时不得自行补充。

本设计提交只改文档。不改 `apps/**`，不改 `deploy/db/schema.sql`，不改 `deploy/env.example`，不改 `deploy/systemd/`，不改测试与依赖，也不改 `specs/SPEC.md` 的阶段状态。`specs/phases/04-search.md` 只增加设计链接，状态保持 `planned`。实现提交按第 7 节替换 `schema.sql` 里的那一行索引注释，并给已有 `EMBED_*` 补上 API 也读取它们的注释。本阶段不创建 HNSW / IVFFlat。阶段状态按 `specs/SPEC.md`：开工的实现提交可以改为 `in_progress`，验收满足后再改为 `done`。本设计提交两处都不改。

阶段规格里的「切换条件」由本文第 7 节承担。`04-search.md` 通过顶部链接引用该节，规格正文不另写一套数字。

## 1. 背景与目标

Phase 3 把一张照片做到 `ready`：缩略图键已写入，且 `photo_embeddings` 有一行 1536 维向量。向量来自文本嵌入。嵌入文本由照片库的 `embeddingInput` 拼出：描述非空则作为第一行，标签非空则用 `", "` 接成一行，两行都没有时用小写字面量 `photo`，有内容时用一个 `\n` 连接。查询文本不走这套拼法。

Phase 4 让主人在自己的个人库里找这些照片。关键词匹配描述与标签。自然语言把查询文本交给 Phase 3 的同一个嵌入网关，再在 `photo_embeddings` 上按余弦距离召回。两条路都只返回调用者有权看到的、状态为 `ready` 的照片，并带上与列表相同的缩略图访问信息。

交付物是 `POST /photos/search`、检索用例、检索 DAO，以及自动化测试。不改 `apps/web`。不改 `GET /photos` 的过滤、排序和响应字段。

实现完成并满足验收时，勾上 `specs/phases/04-search.md` 的验收项，并把该文件与 `specs/SPEC.md` 的状态改为 `done`。本设计提交不勾选，也不改状态。

## 2. 已定决策一览

| 议题 | 决定 |
|------|------|
| 路径 | `POST /photos/search`。不注册 `GET /photos/search`，不接受查询字符串 |
| 模式 | 正文必填 `mode`：`keyword` 或 `semantic`。没有默认值，也不用布尔字段切换 |
| 查询 | 必填字符串 `q`。`String.prototype.trim` 之后长度为 0 则 400 `empty_query`。长度按 UTF-16 码元，上限 500。过滤器不能代替 `q` |
| 关键词 | 整段 `q` 是一个字面子串，不分词，不按空白拆开。描述 `ILIKE` 或任一标签 `ILIKE`，二者 OR。`%`、`_`、`\` 按字面匹配。ASCII 大小写不敏感 |
| 标签过滤 | 可选 `tags`。省略或 `[]` 表示不按标签过滤。非空时大小写敏感，照片的 `tags` 必须包含每一个请求标签（AND） |
| 时间 | 可选 `takenFrom`、`takenTo`，闭区间，作用在 `taken_at`。任一端出现时，`taken_at` 为空的行排除。`takenFrom > takenTo` 为 400 |
| 状态 | 可选 `status`。省略或 `"ready"` 都只检索 `ready`。`processing` 与 `failed` 不是合法取值，请求 400，结果里也不会出现 |
| 语义 | `q` 原样交给 Phase 3 的 `EmbedGateway.embed`。不套 `embeddingInput`，不把空查询改写成 `photo`。度量是余弦距离 `<=>`，越小越近。对外 `score` 是余弦相似度 `1 - 距离`，四舍五入到 6 位小数，越大越靠前 |
| topK 与阈值 | 没有独立 `topK`，也没有相似度阈值。`limit` 是本页条数。距离再远也保留，只要通过所有权和 `ready` 等过滤 |
| 分页 | `limit` 省略为 50，闭区间 1 到 100。键集游标，多取一行判断 `nextCursor`。关键词按 `created_at DESC, id DESC`。语义按四舍五入后的 `score DESC, id ASC`。不用 offset |
| 权限 | 每条 SQL 都带 `owner_id = 当前用户`。JWT 与 API Key 等价。不因为 `credentialKind` 返回 403。不读共享册表 |
| 可见性 | 关键词与语义都只返回 `ready`。语义再 INNER JOIN `photo_embeddings`。尚未 `ready` 的行，即使 Phase 3 已经写入向量，也不是语义命中。`GET /photos` 仍返回三种状态 |
| 结果 | 元素是 Phase 3 的照片对象再加始终出现的 `score`。关键词的 `score` 为 `null`。语义的 `score` 为 JSON 数字。签名 URL 复用 `toPhotoResponse` |
| 索引 | 本阶段顺序扫描，精确排序，不建 IVFFlat / HNSW。全表嵌入行数 ≥ 100000，或语义检索的数据库侧 p95 > 200ms 且该用户 `ready` 照片 ≥ 10000 时，后续提交才加第 7 节的 HNSW。不用 IVFFlat |
| 分层 | 规则在 `domain/search`。该目录不 import `domain/library`。适配层编排嵌入网关、检索端口和签名。DAO 写 SQL。不新建视觉网关 |
| 嵌入失败 | 请求路径只调用一次嵌入，不沿用 worker 的退避。`embed_unavailable` 为 503。`embed_rejected`、维度不符、非有限数为 502 `embed_rejected`。生产占位符不构造假网关，语义请求 503，进程不退出 |
| 限流 | 本阶段不限流，本路由不返回 429。上游嵌入的 429 由现有网关收成 `embed_unavailable`，对外仍是 503 |
| 明确不做 | 共享册内搜索、跨用户公开搜、以图搜图、网页、人脸、查询语法、`pg_trgm`、按 `model` 过滤向量、改列表接口 |

## 3. 架构与分层

依赖方向与 `scripts/check-layer-boundaries.mjs` 一致：接口层不引用 DAO / 网关；适配层不引用接口层、DAO、网关包；领域层不引用其余四层，也不 import `fastify`、`pg`、`undici`，以及 `node:http` / `node:https`。组合根 `apps/api/src/app.ts` 与 `apps/api/src/index.ts` 负责装配。

`domain/library` 继续不 import `domain/search`。`domain/search` 也不 import `domain/library`、`domain/identity`、`domain/album`。检索是读模型，不写入照片，不调用嵌入端口。嵌入端口仍是 Phase 3 定义在 `domain/library` 的 `EmbedGateway`。`adapters/search` 在用例里调用它，并调用已有的 `checkEmbedding` 与 `toPhotoResponse`。两个领域之间没有 import。允许的依赖是适配层同时使用两边的领域类型。

`adapters/library` 不得 import `adapters/search`。`adapters/search` 通过 import `adapters/library/photo-response.js` 调用 `toPhotoResponse`，除此之外不依赖照片库适配层。

实现提交不修改 `scripts/check-layer-boundaries.mjs`。该脚本不检查同一层里两个限界上下文的互相引用，所以第 10 节用源码断言补上 `domain/search` 不引用 `domain/library`。

不引入新的 npm 依赖。向量参数沿用 `apps/api/src/dao/vector-literal.ts` 的 `formatVectorLiteral`。

### 3.1 领域 `apps/api/src/domain/search`

纯规则与端口。现有 `SEARCH_CONTEXT` 导出保持不变。本阶段新增：

- 解析检索正文，得到查询值对象或一个稳定的失败原因。领域函数不返回 HTTP 状态码。
- 关键词的 `ILIKE` 字面量转义。
- 两种模式的游标编码与解码。
- 检索端口。参数和返回值只有普通数据，没有 `pg` 类型，没有网关响应。

失败原因只有这些字符串：`invalid_body`、`empty_query`、`query_too_long`、`invalid_tags`、`invalid_time`、`invalid_range`。适配层按第 8 节映射文案。

端口：

```text
searchKeyword(input: {
  ownerId: string;
  pattern: string;
  takenFrom: Date | null;
  takenTo: Date | null;
  tags: string[] | null;
  cursor: { createdAt: Date; id: string } | null;
  limit: number;
}): Promise<SearchHit[]>

searchSemantic(input: {
  ownerId: string;
  values: number[];
  dimensions: 1536;
  takenFrom: Date | null;
  takenTo: Date | null;
  tags: string[] | null;
  cursor: { scoreText: string; id: string } | null;
  limit: number;
}): Promise<SearchHit[]>
```

`tags === null` 表示不加标签条件。不使用空数组表示「不筛选」，避免 PostgreSQL 里「任何数组都包含空数组」。`pattern` 已含两端 `%` 和转义，DAO 不再转义。`limit` 由适配层传成页面大小加 1。`values` 是嵌入网关返回的普通数组。DAO 调用 `formatVectorLiteral(values, dimensions)` 生成 SQL 参数，不把数组拼进 SQL 文本。适配层不 import DAO，因此不自己调用 `formatVectorLiteral`。

`SearchHit`：

```text
{
  photo: Photo 的同构普通对象（字段与 photos 行一致，status 固定为 "ready"）;
  scoreText: string | null;
}
```

关键词命中的 `scoreText` 为 `null`。语义命中的 `scoreText` 是第 4.4 节的十进制文本。领域端口的实现类型写在 `domain/search`，字面上不引用 `domain/library` 的 `Photo`。适配层再把 `photo` 收成照片库的 `Photo` 交给 `toPhotoResponse`。

### 3.2 适配层

目录固定为 `apps/api/src/adapters/search`。用例按这个顺序做：

1. 调用领域解析正文。失败则按第 8 节返回，不访问数据库，也不调用嵌入。
2. `mode = keyword` 时不调用嵌入网关。用领域函数得到 `pattern`，调用 `searchKeyword`。
3. `mode = semantic` 时先看有没有注入的嵌入网关和非空 `embedModel`。缺网关：503。有网关但模型缺失或空白：502，且不调用网关。否则调用一次 `embed({ model, text })`，`text` 是 trim 之后的 `q`。
4. 网关返回 `embed_unavailable` 或 `embed_rejected`：按第 8 节返回，不查询向量。
5. 网关返回 `values` 后调用 `checkEmbedding(values, 1536)`。失败则 502，不调用检索端口。
6. 调用 `searchSemantic`，传入 `values` 与 `dimensions: 1536`。DAO 内 `formatVectorLiteral` 若因长度或非有限数失败，错误 `name` 为 `DimensionMismatch` 或 `InvalidEmbedding`。绝对值大于等于 1e21 时同样是 `InvalidEmbedding`。适配层把这两个 `name` 收成 502，不发送含向量的 SQL，也不把异常 `message` 写进响应。
7. 检索 SQL 成功后，对每一条调用 `toPhotoResponse`。任一条签名失败：整次请求 500 `storage_error`，不返回缺 URL 的半截列表。
8. 用多取的那一行决定 `nextCursor`。游标用本页最后一条，不用多取的那一条。

持有数据库连接期间不做嵌入 HTTP，也不做签名。嵌入在 SQL 之前。签名在 SQL 之后。检索用例不写 `photos`、`photo_embeddings`、`jobs`。

API Key 的 `last_used_at` 仍由现有身份解析更新。检索用例不额外写身份表。

### 3.3 DAO

`apps/api/src/dao` 新增检索读取的 SQL 实现。只使用参数化查询。照片列与 `photo-repository` 的 `PHOTO_COLUMNS` 相同。语义查询再选出第 4.4 节的 `score_text`。

DAO 在调用 `formatVectorLiteral` 失败时抛出的错误 `name` 仍是 `DimensionMismatch` 或 `InvalidEmbedding`。适配层把这两种收成 502，不把异常 `message` 写进响应。正常路径下适配层已经用 `checkEmbedding` 挡过，DAO 的检查是第二道。

### 3.4 网关

不新增目录。语义检索复用 `gateways/embed` 的 HTTP 实现与 `createFakeEmbedGateway`。假嵌入对同一文本、同一维度返回同一向量，维度为 1536。

不调用 `gateways/vision`。检索请求不读取原图字节。

### 3.5 接口层

`POST /photos/search` 写在 `interfaces/http/register-photos.ts` 的 `registerPhotoRoutes` 里，沿用该函数已有的主体解析。路径字面量就是 `/photos/search`。先鉴权，再解析正文。未授权时不返回正文校验错误。

路由做的事只有：取出 Bearer、调用现有主体解析、把 JSON 对象交给用例、按用例结果写响应。正文不是 JSON 对象时，路由返回 400，不落到现有错误处理里的 500「服务器错误」。

### 3.6 组合根

- `buildApp` 增加可选的 `embed`、`embedModel`。不读 `EMBED_*`，不读 `NODE_ENV`，不读 `VISION_*`，不读 `PIPELINE_*`。未传入 `embed` 时语义检索走 503，关键词检索仍可用。现有身份测试、健康检查和个人库测试不注入嵌入，必须仍能构造应用。
- `src/index.ts` 在对象存储配置通过之后读取嵌入配置。非法配置按第 9 节 `console.error` 后 `exit 1`，不 `listen`。生产占位符不退出：不构造假网关，`buildApp` 不接收 `embed`，并 `console.error` 第 9 节的那句固定文案。非生产的假网关或 HTTP 网关构造完成后再 `listen`。
- worker 的 `loadPipelineConfig` 行为不变：生产环境嵌入占位符仍然让 worker `exit 1`，文案仍然是 `嵌入配置仍是占位符`。占位字符串的判断放在 `gateways/embed` 的同一函数里，worker 与 API 都调用它。不得把 worker 改成「占位也继续跑」。
- 测试不走 `src/index.ts` 的网络监听。HTTP 测试通过 `buildApp` 注入假嵌入。配置解析测试直接调用加载函数。

## 4. 查询、匹配与排序

### 4.1 正文

成功解析后的值对象：

| 字段 | 规则 |
|------|------|
| `mode` | 必填。只接受字符串 `keyword` 或 `semantic` |
| `q` | 必填字符串。先 `trim`。trim 后长度 0 为 `empty_query`。长度大于 500 为 `query_too_long`。等于 500 合法。中间空白保留。不因为控制字符拒绝 |
| `takenFrom` / `takenTo` | 可省略。出现时必须是字符串，匹配下方的时刻正则，并且 `new Date` 不是 Invalid Date。省略的一端是 `null`。键存在而值为 `null`、数字或其他类型：`invalid_time`。两个时刻都有且 `takenFrom > takenTo`：`invalid_range`。相等合法，表示该时刻 |
| `tags` | 可省略。`[]` 与省略都变成 `tags: null`。非空时与 Phase 2 PATCH 的标签规则相同：必须是数组，长度不超过 32；每一项是字符串；拒绝 U+0000–U+001F 与 U+007F；`String.prototype.trim` 后长度 1–64；去重并保留第一次出现的顺序。不合法为 `invalid_tags`。`null` 不是合法值 |
| `status` | 可省略。省略与字符串 `ready` 等价。其他任何值，包括 `processing`、`failed`、`null`、数组：`invalid_body` |
| `limit` | 可省略，省略为 50。必须是 JSON 整数且 `Number.isInteger` 为真，闭区间 1 到 100。字符串、小数、`null` 为 `invalid_body` |
| `cursor` | 可省略。省略表示第一页。`null` 或非字符串为 `invalid_body`。字符串按第 4.5 节解码，模式必须与 `mode` 一致，否则 `invalid_body` |

时刻正则与 Phase 2 的 `takenAt` 相同：

```text
^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$
```

未知键一律 `invalid_body`。这包括 `semantic`、`topK`、`offset`、`image`、`albumId`、`ownerId`、`sort`、`threshold`。正文是数组、`null`、字符串或数字：由路由映射为 `invalid_body`，不必进入领域函数。

`q` 缺失或类型不是字符串：`invalid_body`，文案是「请求不合法」，不是「查询为空」。只有字符串 trim 之后为空才用 `empty_query`。

时间比较使用解析后的时刻。`takenFrom` 等于 `takenTo` 时保留 `taken_at` 等于该时刻的行。

### 4.2 关键词

领域函数 `keywordPattern(q)` 的 `q` 已 trim，且非空：

1. 把 `\` 换成 `\\`。
2. 再把 `%` 换成 `\%`。
3. 再把 `_` 换成 `\_`。
4. 两端加上 `%`。

反斜杠必须最先替换。DAO 使用 `ILIKE $pattern ESCAPE '\'`。在 PostgreSQL 默认的 `standard_conforming_strings = on` 下，SQL 字面量 `'\'` 的内容是一个反斜杠。实现不得写成内容为两个反斜杠的 `'\\'`。用户输入里的 `%` 与 `_` 是字面字符，不是通配符。

命中条件是下面二者之一：

- `description ILIKE pattern`
- `tags` 里存在一项 `ILIKE pattern`

`description` 为 NULL 时，描述这一侧不命中。标签数组为空时，标签这一侧不命中。两侧都不中则该行不是关键词命中。

不匹配 `location_text`、`content_type`、`error_message`、对象键或用户 id。

不分词。`红 船` 只匹配含有这四个字符（中间是空格）的描述或标签，不表示「同时含有红和船」。不实现 AND/OR/引号语法。

ASCII 大小写由 `ILIKE` 折叠：`Red` 命中描述或标签中的 `red`。非 ASCII 的大小写折叠依数据库默认排序规则，验收不断言非 ASCII 折叠。

关键词与过滤器的组合是 AND：所有权、`status = 'ready'`、时间、标签包含、关键词命中，全部满足才返回。过滤器之间没有 OR。

### 4.3 谁可以被检索

两条模式的行集合都先满足：

- `photos.owner_id` 等于当前主体的 `userId`
- `photos.status = 'ready'`

语义模式还要 `INNER JOIN photo_embeddings ON photo_embeddings.photo_id = photos.id`。没有嵌入行的 `ready` 照片可以出现在关键词结果里，不会出现在语义结果里。Phase 3 的不变量是 `ready` 同时具备缩略图和嵌入；INNER JOIN 是语义路径的合同，用来挡住缺向量的行。

`processing` 与 `failed` 不返回。Phase 3 允许没有缩略图的 `reembed` 在状态仍为 `failed` 时写入向量。这种行有嵌入，也不是语义命中。

不读取 `albums`、`album_members`、`album_photos`。共享册成员身份不扩大也不缩小这个集合。

时间条件：

- `takenFrom` 非空：`taken_at >= takenFrom`。`taken_at` 为 NULL 的行不满足。
- `takenTo` 非空：`taken_at <= takenTo`。NULL 同样不满足。
- 两端都空：不看 `taken_at`。

标签条件在 `tags` 非 null 时是 `photos.tags @> $tags::text[]`，大小写敏感，顺序无关。照片可以还有额外标签。请求标签缺一不可。标签过滤不看描述。

### 4.4 语义召回与 score

查询向量只来自这一次 `embed` 调用。照片侧向量是 Phase 3 已经写入的列，检索时不重新计算 `embeddingInput`，不调用视觉，不更新 `photo_embeddings`。

距离运算符固定为 pgvector 的余弦距离 `<=>`。它与「写入时没有另选 L2」一致：Phase 3 只存储向量，比较方式由本阶段定为余弦。不用 `<->`，不用 `<#>`。

相似度的 SQL 表达式固定为：

```sql
round((1 - (photo_embeddings.embedding <=> $vector::vector))::numeric, 6)
```

`round` 对 numeric 使用四舍五入、0.5 远离 0。同一条表达式同时用于排序、键集比较和对外分数。

`score_text` 是该表达式的 `::text`。scale 为 6 的 numeric 转成文本后，小数部分恰好 6 位，例如 `1.000000`、`0.100000`、`-0.250000`。0 是 `0.000000`，不带负号。DAO 把这一列按文本读取，不得先收成 JavaScript number 再 `toFixed`。文本必须匹配 `^-?(?:0|[1-9]\d*)\.\d{6}$`。对不上时这次请求 500 `internal_error`，文案「服务器错误」，不返回这一页。

JSON 里的 `score` 是 `Number(score_text)`。`1.000000` 在 JSON 里是 `1`。游标继续使用 `score_text`，禁止用 JSON 数字再 `toFixed` 生成游标。

不设阈值。`score` 可以为负。本页之后的更低分靠游标继续取，不在服务端丢掉。

不按 `photo_embeddings.model` 过滤。换嵌入模型之后，旧向量会和新向量排在同一次结果里。本阶段不因此重嵌全库。实现不得自行加上 `model = EMBED_MODEL`。

同一向量的余弦距离是 0，对应 `score_text` 为 `1.000000`，JSON 数字为 `1`。查询文本等于某张照片当初写入的嵌入文本时，假嵌入保证这两边向量相同，因此该照片的分数为 1。查询文本不等于 `embeddingInput` 的结果时，不要求分数为 1。例如描述 `海边`、标签 `黄昏` 的嵌入文本是 `海边\n黄昏`；查询 `海边` 是另一段文本。

### 4.5 排序与游标

关键词排序：`created_at DESC, id DESC`。键集是 `(created_at, id)` 严格小于游标中的一对。与 `GET /photos` 的次序相同，游标字节不相同。

语义排序：第 4.4 节的 round 表达式 `DESC`，然后 `id ASC`。键集是：分数严格小于游标分数，或分数相等且 `id` 大于游标 id。`id` 用 `uuid` 比较。

两种游标都是无填充的 base64url（不含 `=`）。解码用 UTF-8。

| 模式 | 明文 |
|------|------|
| 关键词 | `k\n<createdAt ISO>\n<uuid>` |
| 语义 | `s\n<score_text>\n<uuid>` |

`createdAt ISO` 是该行 `createdAt.toISOString()`，并且必须匹配 `domain/library/cursor.ts` 已有的时刻正则。uuid 匹配该文件已有的 UUID 正则，解码后转成小写。这两条正则在 `domain/search` 各写一份，语义与列表游标相同。`domain/search` 不 import 列表游标模块。

`score_text` 必须匹配第 4.4 节的正则。`-0.000000` 非法。`00.100000` 非法。

游标里的模式字母必须等于本次 `mode`：关键词游标用于语义请求，或列表接口的游标用于本接口，都是 `invalid_body`。游标不编码过滤器。同一游标配上另一组过滤条件时，表示「在新条件下从该键之后继续」，不因此 400，也不因此 404。别人的照片 id 拼出来的游标仍然加上 `owner_id`，不会读出别人的行。

`limit` 加 1 去查询。返回前 `limit` 条。没有第 `limit + 1` 条时 `nextCursor` 为 `null`。有则用第 `limit` 条编码。空结果是 `"photos": []` 与 `"nextCursor": null`，HTTP 200。

关键词的下一页游标使用该行的 `createdAt` 与 `id`。语义的下一页游标使用该行的 `score_text` 与 `id`。

## 5. SQL 合同

下面的 SQL 是谓词合同。实现可以换行或调整参数序号，谓词、连接、排序和 `ESCAPE` 不得换一种意思。所有用户文本和向量都是参数。

关键词：

```sql
SELECT <PHOTO_COLUMNS>
FROM photos p
WHERE p.owner_id = $owner
  AND p.status = 'ready'
  AND ($takenFrom::timestamptz IS NULL OR p.taken_at >= $takenFrom)
  AND ($takenTo::timestamptz IS NULL OR p.taken_at <= $takenTo)
  AND ($tags::text[] IS NULL OR p.tags @> $tags::text[])
  AND (
    p.description ILIKE $pattern ESCAPE '\'
    OR EXISTS (
      SELECT 1 FROM unnest(p.tags) AS tag
      WHERE tag ILIKE $pattern ESCAPE '\'
    )
  )
  AND (
    $cursorAt::timestamptz IS NULL
    OR (p.created_at, p.id) < ($cursorAt::timestamptz, $cursorId::uuid)
  )
ORDER BY p.created_at DESC, p.id DESC
LIMIT $limit
```

语义：

```sql
SELECT <PHOTO_COLUMNS>,
       round((1 - (e.embedding <=> $vector::vector))::numeric, 6)::text AS score_text
FROM photos p
INNER JOIN photo_embeddings e ON e.photo_id = p.id
WHERE p.owner_id = $owner
  AND p.status = 'ready'
  AND ($takenFrom::timestamptz IS NULL OR p.taken_at >= $takenFrom)
  AND ($takenTo::timestamptz IS NULL OR p.taken_at <= $takenTo)
  AND ($tags::text[] IS NULL OR p.tags @> $tags::text[])
  AND (
    $cursorScore::numeric IS NULL
    OR round((1 - (e.embedding <=> $vector::vector))::numeric, 6) < $cursorScore
    OR (
      round((1 - (e.embedding <=> $vector::vector))::numeric, 6) = $cursorScore
      AND p.id > $cursorId::uuid
    )
  )
ORDER BY round((1 - (e.embedding <=> $vector::vector))::numeric, 6) DESC, p.id ASC
LIMIT $limit
```

`$vector::vector` 的文本来自 `formatVectorLiteral(values, 1536)`。不把 `q` 拼进这条 SQL。

隔离级别使用连接默认的已提交读。一次检索一条查询语句。重嵌入尚未提交时，语义结果看到旧向量。不在检索里锁照片行，不等待 worker。

## 6. HTTP 与 DTO

鉴权与 Phase 2 相同：`Authorization: Bearer`，先 Access JWT，再 API Key。缺少头、不是 Bearer、凭证无效：401 `unauthorized`，文案「未授权」。两种凭证的成功结果相同。不因为 `credentialKind` 返回 403。

成功 **200**：

```json
{
  "photos": [
    {
      "id": "<uuid>",
      "contentType": "image/jpeg",
      "byteSize": 12345,
      "takenAt": "2026-11-06T02:31:00.000Z",
      "locationText": null,
      "latitude": null,
      "longitude": null,
      "description": "海边",
      "tags": ["黄昏"],
      "status": "ready",
      "errorCode": null,
      "originalUrl": "http://storage.invalid/get?key=owners%2F...%2Foriginal&exp=1762220000",
      "originalUrlExpiresAt": "2026-11-06T02:46:00.000Z",
      "thumbUrl": "http://storage.invalid/get?key=owners%2F...%2Fthumb&exp=1762220000",
      "thumbUrlExpiresAt": "2026-11-06T02:46:00.000Z",
      "createdAt": "2026-11-06T02:31:00.000Z",
      "updatedAt": "2026-11-06T02:31:00.000Z",
      "score": 1
    }
  ],
  "nextCursor": null
}
```

除 `score` 以外的字段、空值表现和签名规则与 Phase 3 照片对象一致，并且必须通过现有的 `toPhotoResponse` 生成。`originalUrl` 每次现签。`thumb_key` 非空时用同一个 `presignGet` 和同一个 `S3_SIGNED_URL_TTL` 签发 `thumbUrl`。`ready` 照片的 `thumb_key` 按 Phase 3 非空；若行为空，`thumbUrl` 与 `thumbUrlExpiresAt` 为 `null`，与列表一致，不因此把该行从关键词结果去掉。语义结果仍要求有嵌入行。

`score` 这个键始终出现。关键词为 `null`。语义为数字。响应不包含 `objectKey`、`thumbKey`、`sourceUserId`、`sourceKeyId`、`errorMessage`、嵌入向量、`model`、距离原始值。

`GET /photos` 的元素不增加 `score`。

请求示例：

```json
{
  "mode": "keyword",
  "q": "海边",
  "takenFrom": "2026-01-01T00:00:00.000Z",
  "takenTo": "2026-12-31T23:59:59.999Z",
  "tags": ["旅行"],
  "status": "ready",
  "limit": 20
}
```

```json
{ "mode": "semantic", "q": "去年在海边看日落" }
```

查询字符串有任何一个参数：400 `validation_error`，文案「请求不合法」。本接口不读取 `limit` 或 `cursor` 的查询参数。

错误外壳与现有接口相同：`{ "error": { "code", "message" } }`。

## 7. 数据与索引

本阶段不改 `photos` 与 `photo_embeddings` 的列，不创建新索引。`photo_embeddings.embedding` 仍是 `vector(1536)`。现有 `idx_photos_owner_created` 与 `idx_photos_status` 保持原样。关键词的前导通配 `ILIKE` 用不到 B-tree 来加速子串，实现不添加 `pg_trgm`，也不写 index hint。顺序扫描加上 `owner_id` 条件就是本阶段的计划。

排序在索引缺席时是精确的：语义结果就是该用户 `ready` 照片里，按第 4.4 节表达式算出的顺序，而不是全局近似近邻再过滤。

实现提交对 `deploy/db/schema.sql` 的唯一允许改动，是替换 `photo_embeddings` 表定义下方「数据量上来之后再加 IVFFlat / HNSW」那一行注释，改成指向本文的切换条件，并写明本阶段不建 ANN 索引。不得在该提交执行 `CREATE INDEX ... USING hnsw` 或 `ivfflat`。

后续提交在下面任一条件成立时才加入 HNSW：

1. `SELECT count(*) FROM photo_embeddings` ≥ 100000。
2. 语义检索在数据库内的耗时 p95 > 200 毫秒，且发出该查询的用户拥有的 `ready` 照片 ≥ 10000。耗时不含嵌入 HTTP，不含签名 URL。

两个数都是全表或单用户的实测门槛，不是本阶段要在线判断的配置项。应用代码不读取行数来切换计划，不设对应环境变量。

届时使用 HNSW，不使用 IVFFlat。IVFFlat 需要先有样本才能选择 `lists`，召回还依赖 `probes`，本仓库没有训练作业。HNSW 与现有运算符一致。草案固定为：

```sql
CREATE INDEX IF NOT EXISTS idx_photo_embeddings_hnsw
  ON photo_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

那次提交不能只加上索引就继续沿用本文件的精确排序合同。全局 HNSW 若在 `owner_id` 过滤之前只取全局近邻，会漏掉「对这个用户其实更近」的照片。那次提交必须改成在过滤条件下仍然成立的近邻检索，写明 `hnsw.ef_search`，并更新测试。在那之前禁止创建该索引。

`deploy/env.example` 不增加变量。实现提交只给已有的 `EMBED_*` 补注释：API 进程也读取这些变量；`EMBED_DIMENSIONS` 不是 1536 时 API 退出；生产占位符不让 API 退出，语义检索返回 503。worker 的退出行为按 Phase 3 保留。

## 8. 错误码

| 状态 | `error.code` | 文案 | 何时 |
|------|----------------|------|------|
| 401 | `unauthorized` | 未授权 | Bearer 缺失或无效。先于正文校验 |
| 400 | `validation_error` | 请求不合法 | 非对象正文、未知键、`mode` / `limit` / `cursor` / `status` 不合法、带查询字符串、`q` 缺失或不是字符串 |
| 400 | `empty_query` | 查询为空 | `q` 是字符串，trim 后长度为 0 |
| 400 | `query_too_long` | 查询过长 | trim 后 UTF-16 码元大于 500 |
| 400 | `validation_error` | 标签不合法 | `tags` 违反第 4.1 节 |
| 400 | `validation_error` | 拍摄时间不合法 | `takenFrom` 或 `takenTo` 违反第 4.1 节 |
| 400 | `validation_error` | 时间范围不合法 | `takenFrom > takenTo` |
| 502 | `embed_rejected` | 嵌入被拒绝 | 网关 `embed_rejected`；`checkEmbedding` 或 DAO 得到 `dimension_mismatch` / `invalid_embedding`；注入了网关但 `embedModel` 空白。不查询向量 |
| 503 | `embed_unavailable` | 嵌入暂不可用 | 网关 `embed_unavailable`；未注入网关；生产占位符因此没有网关 |
| 500 | `storage_error` | 对象存储不可用 | 签名失败 |
| 500 | `internal_error` | 服务器错误 | 未预期的数据库错误，或 `score_text` 不是合同格式 |

502 与 503 的响应正文不包含上游正文、向量、维度数字或查询文本。日志里的 `errorCode` 使用更细的原因：`embed_unavailable`、`embed_rejected`、`dimension_mismatch`、`invalid_embedding`。HTTP 的 `error.code` 仍按上表，不把 `dimension_mismatch` 直接暴露给客户端。

本路由不返回 429。不实现应用层限流。嵌入上游的 HTTP 429 已经由 Phase 3 网关收成 `embed_unavailable`。

检索对嵌入只调用一次。失败立即返回，不睡眠，不套用 worker 的 5 次退避。

## 9. 配置、假实现与日志

API 进程新增读取的变量只有 Phase 3 已有的 `EMBED_PROVIDER`、`EMBED_API_BASE_URL`、`EMBED_API_KEY`、`EMBED_MODEL`、`EMBED_TIMEOUT_MS`、`EMBED_DIMENSIONS`，以及已经存在的 `NODE_ENV`。不读取 `VISION_*` 与 `PIPELINE_*`。解析规则与 `gateways/embed/config.ts` 里嵌入侧相同：空白超时为 30000，维度必须是 1536，占位字符串仍是 `https://YOUR_EMBED_API_BASE`、`YOUR_EMBED_API_KEY`、`YOUR_EMBED_MODEL`，比较前只 trim。

| 情况 | API 进程 |
|------|----------|
| 维度、超时、provider、基址语法不合法 | `console.error` 对应的 Phase 3 文案，`exit 1`，不监听 |
| `NODE_ENV` trim 后等于 `production`，且嵌入侧命中占位 | `console.error("嵌入配置仍是占位符，语义检索不可用")`。不构造假网关，继续启动。语义请求 503。关键词可用 |
| 非 production 且命中占位 | 构造 `createFakeEmbedGateway({ dimensions: 1536 })`。模型名与 worker 相同：空白时用 `fake`，否则用 trim 后的模型字符串。启动后打 INFO，文案 `嵌入网关使用假实现` |
| 非占位的合法 HTTP 配置 | 构造现有 HTTP 嵌入网关。INFO 文案 `嵌入网关使用 HTTP` |

INFO 走应用日志。两条文案与 worker 相同，且不出现密钥、完整基址和模型字符串。生产占位的 `console.error` 只有上面那一句固定中文。

`buildApp` 在测试里注入的假网关不看 `NODE_ENV`。漏注入则语义 503，不得偷偷改成假网关。假网关被注入时必须同时注入非空 `embedModel`，否则语义 502 且调用次数为 0。

非 production 的占位假网关允许语义检索成功，向量由 `deterministicEmbedding` 决定。production 的占位不得走这条路径，也不得把语义请求当成 200。

日志沿用 Phase 3 的 redact。`req.body` 已经整段打码，因此 `q` 不会出现在请求日志里。检索失败日志只许带 `userId`、`mode`、`errorCode`，外加一条静态中文：「嵌入调用失败」或「嵌入结果无效」。不记录 `q`、向量、`score_text`、签名 URL、`Authorization`、API Key。对象存储失败沿用照片库已有的 `storage_error` 日志字段，不新增会带出 URL 的字段。

不必把 `photos[*].score` 加入 redact。不得把 redact 名单里已有的 `embedding`、`originalUrl`、`thumbUrl` 删掉。

## 10. 测试与验收

纯规则放在 `apps/api/test/search-rules.test.ts`，不连接数据库。覆盖：trim 与 500 码元上限、空查询与缺失 `q` 的原因不同、未知键、`status` 只接受 `ready`、时间区间、标签去重与非法标签、`keywordPattern` 对 `\`、`%`、`_` 的替换顺序、游标往返、关键词游标不能当语义游标解、`-0.000000` 拒绝。

配置放在 `apps/api/test/search-config.test.ts`，不连接数据库。覆盖：`EMBED_DIMENSIONS` 不是 1536 时 API 加载函数失败；非 production 占位得到假网关且不读取密钥去发请求；`NODE_ENV=production` 加 `YOUR_EMBED_API_KEY` 得到「不退出进程的禁用语义」，文案是 `嵌入配置仍是占位符，语义检索不可用`，且结果里没有假网关。同一占位符在 worker 的现有配置测试里仍然是退出，文案仍然是 `嵌入配置仍是占位符`。本阶段不得改掉那条 worker 断言。

HTTP 集成放在 `apps/api/test/search.test.ts`，使用现有的 `node:test` 与 `buildApp().inject`。仓储走真实 PostgreSQL。缺少 `DATABASE_URL` 时失败，不跳过。对象存储与嵌入使用注入的假实现。时钟可替换。直接插入的照片行满足 `photos` 的非空约束，`owner_id` 属于对应用户；语义用例的 `status` 为 `ready`，`photo_embeddings.model` 为任意非空字符串。假存储的 `presignGet` 不要求对象已经存在。语义排序的期望用「同一文本距离为 0」以及数据库中的同一条 round 表达式核对，不把某一对英文单词的偶然远近写死在生产代码里。

断言至少覆盖：

1. 用户 A 有一张 `ready` 照片，描述含 `Red Boat`，标签含 `Seaside`。关键词 `q` 为 `red` 能命中。`q` 为 `side` 能通过标签子串命中。`q` 为 `Red` 同样命中。`location_text` 含有关键词而描述和标签都不含时不命中。
2. 描述为 `100%_ok` 的照片能被 `q` 为 `100%_ok` 命中。`q` 为 `%` 不因此命中全部照片，只命中含有百分号的描述或标签。
3. `q` 为 `红 船` 不命中仅分别含有 `红` 与 `船` 的照片。描述正好为 `红 船` 时命中。
4. 标签过滤 `["Seaside"]` 命中该项完全相等的照片，不命中标签 `seaside` 或 `Side`。过滤 `["Seaside", "Trip"]` 要求两项都在。关键词 `boat` 加上标签过滤 `["Seaside"]` 时，只有两侧都满足的照片返回。
5. `takenFrom` 与 `takenTo` 是闭区间。区间外不返回。`taken_at` 为 NULL 的 `ready` 照片在任一端出现时不返回，两端都省略时可以返回。`takenFrom > takenTo` 为 400，文案「时间范围不合法」。
6. `processing` 与 `failed` 的照片即使描述含关键词、即使 `photo_embeddings` 有行，关键词和语义都不返回。`status: "failed"` 为 400「请求不合法」。省略 `status` 与 `"ready"` 的命中集合相同。
7. 用户 B 有描述含同一关键词的 `ready` 照片。A 的 JWT 与 A 的 API Key 看到的 id 顺序和 `score` 相同。B 的 JWT 与 B 的 API Key 看不到 A 的 id。用 B 的照片 id 制作的游标不会让 A 读到 B 的行。
8. 语义：三张 A 的 `ready` 照片。两张的向量等于 `deterministicEmbedding("red", 1536)`，第三张等于 `deterministicEmbedding("blue", 1536)`。注入的假嵌入在 `text === "red"` 时返回前一个向量，并记录调用文本。请求 `q` 为 `red` 时，网关收到的 `text` 就是 `red`，不是 `embeddingInput` 拼出来的多行文本。两张 `red` 的 `score` 为 `1`，按 id 升序排在前面，`blue` 在后且 `score` 小于 1。再请求一次，顺序相同。
9. 用第 4.4 节的 SQL 表达式在测试里算出这三张的期望顺序，接口顺序与之一致。分页 `limit: 1` 时第一页的 `nextCursor` 能取到第二张，且不重复第一张。把关键词游标交给语义请求得到 400。
10. 假嵌入返回 `embed_unavailable` 时 503 `embed_unavailable`，文案「嵌入暂不可用」，检索 SQL 不被调用。返回 `embed_rejected` 或长度为 3 的向量时 502 `embed_rejected`，文案「嵌入被拒绝」，不查询向量。`q` 为 `"   "` 时 400 `empty_query`。缺少 `q` 时 400，文案「请求不合法」。501 个码元为 `query_too_long`。没有 Bearer 时 401，文案「未授权」。
11. 未注入嵌入网关时，关键词在照片 `ready` 且描述命中时仍 200；同一应用的语义请求 503。`buildApp` 不设置 `EMBED_*` 时，现有健康检查与个人库测试仍能构造应用。
12. 检索成功响应里的 `thumbUrl` 在 `thumb_key` 非空时存在，`originalUrl` 存在，`status` 为 `ready`。签名使用注入时钟，过期时刻等于 `now + TTL`。列表接口的照片对象没有 `score` 键。
13. `npm test` 的分层边界检查通过。`domain/search` 的源码不 import `domain/library`、`domain/identity`、`domain/album`、DAO、网关、`pg`、`fastify`、`undici`。`adapters/library` 的源码不 import `adapters/search`。适配层源码不出现 `/dao` 与 `/gateways`。

第 8 条用直接写入的向量与注入的假嵌入把排序钉死。实现可以用流水线把照片做成 `ready`，但写入向量必须等于上面的确定函数，查询文本必须原样进入网关。不得为了让自然语言例句排到第一而在领域里把 `q` 改写成 `embeddingInput`。

## 11. 验收对照

与 `specs/phases/04-search.md` 的验收项对应关系如下。实现提交才能勾选。

| 阶段验收 | 本文何处 |
|----------|----------|
| 关键词能命中描述或标签中的词，且不返回别人的照片 | 第 4.2、4.3、6 节；第 10 节第 1、2、7 条 |
| 自然语言查询能召回语义相近、状态允许展示的照片；测试可用假嵌入保证排序稳定 | 第 4.4、4.5、9 节；第 10 节第 8、9 条 |
| 尚未 `ready` 且没有嵌入的照片不会被当成语义命中 | 第 4.3 节；第 10 节第 6 条。有嵌入但不是 `ready` 的行同样排除 |
| 检索接口在 JWT 与 API Key 下行为一致 | 第 6 节；第 10 节第 7 条 |
| 领域层边界检查仍然通过 | 第 3、10 节第 13 条 |

切换条件写在第 7 节，供 `04-search.md` 顶部的设计链接引用。

## 12. 范围外

本阶段不做：

- 共享册内搜索，以及任何对 `albums`、`album_members`、`album_photos` 的读取
- 未登录搜索、跨用户搜索、公开照片搜索
- 以图搜图，以及为检索新增视觉网关或图像嵌入
- `apps/web` 以及任何页面
- 人脸、自动事件、地理附近搜索
- 查询语言：分词、AND/OR/引号、按空白拆词
- 独立 `topK`、相似度阈值、调用方指定的排序字段、offset
- 按 `photo_embeddings.model` 过滤，以及检索时顺带重嵌入
- `pg_trgm`、IVFFlat、HNSW。HNSW 只在第 7 节的门槛达到之后由另一次提交加入
- 应用层限流、本路由的 429、新的限流环境变量
- 改 `GET /photos` 的可见状态、分页或 JSON 字段
- 在检索请求里套用 worker 的嵌入重试
- 在 CVM 上加载嵌入模型

实现时禁止：

- 在 `domain/search` import 照片库、身份或共享册，以免和「照片库不引用检索」形成循环
- 在领域层发 HTTP、写 SQL 或调用 `fetch`
- 让 production 的嵌入占位符走假网关并返回 200
- 把 `processing` 或 `failed` 放进结果，即使用户没有传 `status`
- 修改 `deploy/db/schema.sql` 的表和索引。实现提交只替换第 7 节允许的那一行注释
- 修改 `scripts/check-layer-boundaries.mjs`
- 新增环境变量

## 13. 已确认决策

- 路径是 `POST /photos/search`。`mode` 只有 `keyword` 与 `semantic`，必填。`q` 必填。空查询与超长查询是两种 400。
- 只检索当前用户的 `ready` 照片。JWT 与 API Key 相同。语义还要有嵌入行。`failed` 上残留的向量不算命中。
- 关键词是描述与标签上的字面 `ILIKE` 子串，两侧 OR，再与时间、标签包含 AND。不分词。
- 语义查询原样嵌入，余弦距离 `<=>`，`score` 为保留 6 位小数的相似度。无阈值。`limit` 同时是页大小，默认 50，最大 100。
- 游标是键集。关键词沿用列表的时间次序，语义按分数然后 id。列表游标不能拿来检索。
- 照片 JSON 复用 Phase 3，并始终带 `score`。
- 本阶段精确顺序扫描。嵌入行数达到 100000，或数据库侧 p95 超过 200 毫秒且该用户 `ready` 照片达到 10000，才允许后续提交创建 `m = 16`、`ef_construction = 64` 的 HNSW。不建 IVFFlat。
- 检索领域不引用照片库领域。适配层复用嵌入端口和 `toPhotoResponse`。
- 生产嵌入占位符让语义检索 503，API 继续服务关键词和照片库。假嵌入只给测试注入和非 production 占位。worker 的生产占位退出不变。
- 不做共享册搜索、跨用户搜索、以图搜图、网页、人脸和限流。
