# OpenAlbum Phase 1 — 身份与鉴权设计

日期：2026-11-03  
状态：已定稿（待实现）  
对应规格：[`specs/phases/01-identity-auth.md`](../../../specs/phases/01-identity-auth.md)

本文件是 Phase 1 的实现合同。权威索引仍是 [`specs/SPEC.md`](../../../specs/SPEC.md)。未写进本文的行为，实现时不得自行补充。

## 1. 目标与交付面

Phase 1 只回答「请求是谁」。相册、照片和共享册的资源 ACL 留到后续阶段，在已解析的主体上叠加。

交付面：

- 人类凭证：邮箱 + 密码注册与登录。成功后签发 **Access JWT** 与 **Refresh Token**。客户端把 Access JWT 放在 `Authorization: Bearer` 里调用受保护接口。
- Agent 凭证：**API Key**，同样放在 `Authorization: Bearer`。Key 所属 `userId` 与该用户密码会话的 `userId` 相同。
- 多端：网页、手机、以及将来的小程序共用这一套 Bearer 模型。本阶段不发 Cookie，不绑定某一种客户端存储。
- 交付物只有 **HTTP API** 与 **自动化测试**。网页和小程序 UI 属于 Phase 6。Phase 1 不改 `apps/web`。

实现完成后，`specs/phases/01-identity-auth.md` 的验收项应能逐条勾上。本阶段不把该文件的状态改成 `done`；状态仍由实现提交按 `specs/SPEC.md` 的流程更新。

## 2. 主体与凭证

### 2.1 Principal

适配层把已通过校验的凭证解析成主体，再交给后续用例。Phase 1 的主体没有角色、没有相册权限。

| 字段 | 含义 |
|------|------|
| `userId` | `users.id`，UUID |
| `credentialKind` | `password_session` 或 `api_key` |
| `credentialId` | 密码会话时为签发该 Access JWT 的 Refresh Token 行 id；API Key 时为 `api_keys.id`。本阶段两种成功凭证都必须带上它 |

两种 `credentialKind` 访问「是谁」时等价：`GET /me` 都返回同一个 `userId`。管理 API Key 的路由只接受 `password_session`（见第 3 节）。

### 2.2 Access JWT

- 签名算法只允许 **HS256**。`alg=none` 以及其他算法一律拒绝。
- 签名密钥来自环境变量 `JWT_SECRET`。有效期来自 `JWT_TTL`。
- **不入库**。服务端不保存 Access JWT，也无法按条吊销。登出只吊销 Refresh Token；已经发出的 Access JWT 在剩余 TTL 内仍然有效。因此 `JWT_TTL` 必须短。
- 实现时把 `deploy/env.example` 里的 `JWT_TTL` 从现有的 `7d` 改为 `15m`。`7d` 是单令牌时期的值，不再表示会话总长度。生产默认也是 `15m`。
- 校验允许 **5 秒**时钟偏差。
- Claims（全部必填）：

| Claim | 值 |
|-------|----|
| `iss` | `openalbum` |
| `aud` | `openalbum-api` |
| `sub` | `userId` |
| `kind` | `password_session` |
| `cid` | 对应 Refresh Token 的 `id` |
| `iat` / `exp` | 秒级时间戳，`exp - iat` 等于 `JWT_TTL` |

JWT 里不放邮箱、密码或 Key。`kind` 不是 `password_session` 的令牌，按未授权处理。

### 2.3 Refresh Token

- 不透明串，不是 JWT。明文形态：`oalr_` 加 32 字节密码学随机数的 base64url（无填充）。
- 有效期来自 `REFRESH_TTL`。实现时在 `deploy/env.example` 新增 `REFRESH_TTL=30d`。生产默认 `30d`。
- 库内只存 **HMAC-SHA256** 摘要，键为 `API_KEY_PEPPER`，消息为完整明文，输出小写 hex。不存明文。
- 可吊销。刷新时轮换：旧行标记撤销并指向新行，新行继承同一个 `family_id`，同时签发新的 Access JWT。
- 每次注册或登录新建一个 `family_id`（新的 UUID）。同一用户多端登录是多个 family，互不影响。
- 轮换必须在一个数据库事务里对当前行 `SELECT … FOR UPDATE`。并发的第二次刷新视为重放：吊销该 `family_id` 下尚未撤销的全部行，返回 401。客户端必须串行刷新。

`POST /auth/refresh` 的判定：

| 呈现的 Refresh Token | 行为 |
|----------------------|------|
| 找不到摘要 | 401，不写库 |
| 未撤销但 `expires_at <= now` | 401，不连坐 family |
| 已撤销（轮换过或登出过） | 将该 family 中仍有效的行全部标上 `revoked_at`，返回 401 |
| 未撤销且未过期 | 插入新行，旧行写入 `revoked_at` 与 `replaced_by`，返回新的 Access JWT 与新 Refresh Token |

`POST /auth/logout` 只撤销提交的那一行。未知、过期或已经撤销都返回 204，不连坐 family。登出可以重试。

### 2.4 API Key

- 明文形态：`oalb_` + 8 位前缀 + `_` + 32 字节 base64url 秘密（无填充）。前缀字符集为 `[A-Za-z0-9]`。
- `key_prefix` 存 `oalb_` 加这 8 位，供查找。`key_hash` 存与 Refresh Token 相同的 HMAC-SHA256（键 `API_KEY_PEPPER`，消息为**完整明文**）。按 `key_prefix` 取出未吊销行后逐条做恒定时间比较，命中即通过；一条都未命中则 401。
- 明文只在 `POST /api-keys` 的响应里出现一次。列表、日志、错误体都不返回明文或摘要。
- 字段沿用现有 `api_keys`：`name`、`revoked_at`、`last_used_at`。吊销是软删除，把 `revoked_at` 设为当前时间，不物理删除。
- 名称：trim 之后按 JavaScript 字符串长度 1–64，拒绝含有控制字符的名称。
- Phase 1 不限制每用户 Key 的个数。
- 校验成功后更新 `last_used_at`。更新失败只记日志（`userId` 与 key id，不含明文）并继续放行，不把用户挡在 401 外面。

### 2.5 Bearer 解析顺序

受保护路由只接受 `Authorization: Bearer <credential>`。方案大小写不敏感，值两端空白去掉。缺少头、不是 Bearer、值为空，一律 401，错误码 `unauthorized`。

解析器按下面的顺序，命中即停止：

1. 凭证含有两处 `.`，按 Access JWT 校验（签名、`iss`、`aud`、`exp`、`kind`）。成功则 `credentialKind = password_session`，`credentialId = cid`。
2. 凭证以 `oalb_` 开头，按 API Key 查前缀并比对 HMAC。未撤销才通过。成功则 `credentialKind = api_key`，`credentialId = api_keys.id`。
3. 其余形态（包括 `oalr_` Refresh Token、损坏的 JWT、已吊销的 Key）一律 401，错误码 `unauthorized`，文案固定为「未授权」。不区分过期、签名错误、吊销或前缀不匹配。

Refresh Token 不作为 Bearer 访问凭证。把它放进 `Authorization` 会落到第 3 步并返回 401。

## 3. HTTP API

除 `GET /health` 外，本阶段新增下列路由。请求和响应体均为 JSON。入参用 Fastify JSON Schema 校验，不引入新的校验库。错误体统一为：

```json
{ "error": { "code": "unauthorized", "message": "未授权" } }
```

成功响应里不出现 `password_hash`、`key_hash`、`token_hash`。

| 状态 | `error.code` | 文案 | 何时 |
|------|----------------|------|------|
| 400 | `validation_error` | 见本节固定句 | 入参形状或口令/邮箱/名称不合法 |
| 401 | `invalid_credentials` | 邮箱或密码错误 | 登录失败 |
| 401 | `unauthorized` | 未授权 | Bearer、刷新失败 |
| 403 | `forbidden` | 当前凭证不能执行该操作 | 已认证，但 `credentialKind` 不允许 |
| 409 | `email_taken` | 该邮箱已注册 | 注册冲突 |
| 404 | `not_found` | 未找到 | 吊销的 Key 不属于当前用户 |

登录的 401 对「没有这个邮箱」和「密码错误」使用同一状态、同一 `code`、同一 `message`。注册冲突使用 409，因此会表明邮箱已被占用。这是本阶段的取舍：注册需要明确冲突，登录不提供枚举差异。

邮箱在校验前 trim 并转成小写。合法邮箱匹配 `^[^\s@]+@[^\s@]+\.[^\s@]+$`，长度 1–320。密码按 JavaScript 字符串长度 8–128，不要求字符类别。名称规则见 2.4。JSON 对象出现未定义字段、缺字段、类型不对，或 `refreshToken` 不是非空字符串时，返回 400，文案「请求不合法」。其余校验失败时 `message` 只报告第一个问题，且为下列固定句之一：「邮箱格式不正确」「密码长度须为 8 到 128」「名称不合法」「标识不合法」「请求不合法」。

### 3.1 `POST /auth/register`

无鉴权。

请求：`{ "email": string, "password": string }`

成功 **201**：

```json
{
  "tokenType": "Bearer",
  "accessToken": "<jwt>",
  "accessTokenExpiresIn": 900,
  "refreshToken": "oalr_...",
  "refreshTokenExpiresAt": "2026-12-03T07:50:00.000Z",
  "user": { "id": "<uuid>", "email": "user@example.com" }
}
```

`accessTokenExpiresIn` 是秒，等于解析后的 `JWT_TTL`。`refreshTokenExpiresAt` 是该 Refresh Token 的 `expires_at`（ISO 8601 UTC）。注册成功即建立会话，调用方不必再登录。邮箱已存在返回 409 `email_taken`。并发注册撞上唯一约束时同样返回 409 `email_taken`，而不是 500。

### 3.2 `POST /auth/login`

无鉴权。请求体与注册相同。

成功 **200**，响应体与注册成功相同，并且新建一个 `family_id`。失败 **401** `invalid_credentials`。用户不存在时，仍用启动时生成的固定 argon2id 哑哈希做一次校验，使响应时间不把「无此邮箱」和「密码错误」分开。哑哈希在进程启动时对随机口令做一次 argon2id 后缓存在内存，不写入数据库，也不对应任何账户。

### 3.3 `POST /auth/refresh`

无 Bearer。请求：`{ "refreshToken": string }`。

成功 **200**，响应体与登录相同（`user` 为该 token 的主人）。失败见 2.3，对外一律 401 `unauthorized`。过期 Access JWT 不影响本路由，本路由不读 `Authorization`。

### 3.4 `POST /auth/logout`

无 Bearer。请求：`{ "refreshToken": string }`。

成功 **204**，空正文。只撤销这一枚 Refresh Token。已撤销、过期、摘要不存在也返回 204。

### 3.5 `GET /me`

Bearer：Access JWT 或 API Key。

成功 **200**：

```json
{
  "user": { "id": "<uuid>", "email": "user@example.com" },
  "principal": {
    "userId": "<uuid>",
    "credentialKind": "password_session",
    "credentialId": "<uuid>"
  }
}
```

`credentialKind` 为实际凭证种类。用户行不存在（例如用户已被删除而 JWT 未过期）返回 401 `unauthorized`。

### 3.6 `POST /api-keys`

仅 `password_session`。`api_key` 返回 403 `forbidden`。

请求：`{ "name": string }`

成功 **201**：

```json
{
  "apiKey": {
    "id": "<uuid>",
    "name": "我的 Agent",
    "keyPrefix": "oalb_Ab12Cd34",
    "createdAt": "2026-11-03T07:50:00.000Z",
    "lastUsedAt": null,
    "revokedAt": null
  },
  "secret": "oalb_Ab12Cd34_<base64url>"
}
```

`secret` 只出现在这次响应。

### 3.7 `GET /api-keys`

仅 `password_session`。`api_key` 返回 403。

成功 **200**：`{ "apiKeys": [ /* 与创建响应里的 apiKey 相同的对象，无 secret */ ] }`。包含已吊销的 Key，用 `revokedAt` 区分。按 `createdAt` 升序。

### 3.8 `DELETE /api-keys/:id`

仅 `password_session`。`api_key` 返回 403。

`:id` 必须是 UUID，否则 400 `validation_error`，文案「标识不合法」。

该 id 属于当前用户且尚未吊销：写入 `revoked_at`，**204**。已经吊销：再次删除仍 **204**。不属于当前用户，或 id 不存在：**404** `not_found`。不物理删除行。

## 4. DDD 分层落点

依赖方向与 `scripts/check-layer-boundaries.mjs` 一致：接口层不引用 DAO / 网关；适配层不引用接口层、DAO、网关包；领域层不引用其余四层，也不 import `fastify`、`pg`、`argon2`、`jose`。组合根 `apps/api/src/app.ts` 负责装配。

### 4.1 领域 `apps/api/src/domain/identity`

实体与值对象：`User`、`ApiKey`、`RefreshToken`、`Principal`、`CredentialKind`。

`Principal.credentialId` 在本阶段必填，与 §2.1 一致，不是可选字段。密码会话时它是签发该 Access JWT 的 Refresh Token 行 id；API Key 时它是 `api_keys.id`。两种成功凭证都必须带上它。

端口（只有类型与调用约定，没有基础设施实现）：

- `UserRepository`、`ApiKeyRepository`、`RefreshTokenRepository`
- `PasswordHasher`：`hash(plain)` 与 `verify(plain, encoded)`
- `TokenHasher`：`hash(raw)`，供 API Key 与 Refresh Token 共用
- `Clock`：`now()`
- `IdGenerator`：UUID
- `AccessTokenIssuer`：`sign(principalClaims)` 与 `verify(jwt)`

领域服务负责：邮箱规范化、口令是否匹配、Refresh Token 轮换与重放连坐、API Key 是否可用、吊销是否允许。领域服务通过端口调用哈希与时钟，不决定 HTTP 状态码。

### 4.2 适配层 `apps/api/src/adapters`

用例：`registerUser`、`loginUser`、`refreshSession`、`logoutSession`、`getMe`、`createApiKey`、`listApiKeys`、`revokeApiKey`、`resolvePrincipal`。

`resolvePrincipal` 实现第 2.5 节的顺序，只依赖 `AccessTokenIssuer`、`ApiKeyRepository`、`TokenHasher`、`Clock`。用例把领域结果映射成第 3 节的 DTO 与错误码。适配层源码不得出现 `from ".../dao"` 或 `from ".../gateways"`。

### 4.3 DAO `apps/api/src/dao`

实现三个仓储，表为 `users`、`api_keys`、`refresh_tokens`。刷新轮换使用单事务与 `FOR UPDATE`。应用生成 UUID 并写入主键；DDL 里的 `gen_random_uuid()` 只作兜底。

### 4.4 网关 `apps/api/src/gateways`

| 端口 | 实现 |
|------|------|
| `Clock` | 系统时钟 |
| `IdGenerator` | `crypto.randomUUID()` |
| `AccessTokenIssuer` | `jose`，HS256，读 `JWT_SECRET` 与 `JWT_TTL`。签发与过期判断都走 `Clock`，不读 `Date.now()`，测试替换时钟即可让 Access JWT 过期 |
| `PasswordHasher` | `argon2` 的 argon2id |
| `TokenHasher` | Node `crypto` HMAC-SHA256，键为 `API_KEY_PEPPER` |

随机明文（Refresh Token 与 API Key）也在网关生成，经端口交给适配层。适配层不直接调用 `jose`、`argon2` 或 `crypto`。

本阶段为 `apps/api` 增加依赖：`pg`、`argon2`、`jose`。不新增其他鉴权框架。

### 4.5 接口层 `apps/api/src/interfaces/http`

路由文件承载第 3 节的路径、JSON Schema 与状态码，调用适配层用例。不写轮换规则，不访问 SQL。`GET /health` 保持现状。

`buildApp` 增加依赖注入入口。默认路径连接 `DATABASE_URL` 并构造真实网关。测试可以替换 `Clock`，以便断言 Access JWT 过期，而不把 `JWT_TTL` 真的等到 15 分钟。

### 4.6 环境变量

| 变量 | Phase 1 含义 |
|------|----------------|
| `JWT_SECRET` | Access JWT 的 HS256 密钥。缺失或短于 32 字节则进程拒绝启动 |
| `JWT_TTL` | Access JWT 有效期。默认 `15m`。接受以 `s`、`m`、`d` 结尾的正整数，例如 `15m`、`2s` |
| `REFRESH_TTL` | Refresh Token 有效期。默认 `30d`。语法同 `JWT_TTL` |
| `API_KEY_PEPPER` | HMAC 键。缺失或短于 32 字节则进程拒绝启动 |
| `DATABASE_URL` | Postgres 连接串 |

轮换 `API_KEY_PEPPER` 会使已发出的 API Key 与 Refresh Token 全部无法再通过校验。轮换 `JWT_SECRET` 会使已发出的 Access JWT 全部失效。Phase 1 不做双密钥平滑轮换。

`deploy/env.example` 的修改属于实现提交：把 `JWT_TTL` 改为 `15m`，加入 `REFRESH_TTL=30d`，并把 `API_KEY_PEPPER` 的占位符加长到至少 32 字节（仍然只是占位符）。本设计提交不改该文件。

## 5. DDL

实现时把下面的表追加到 `deploy/db/schema.sql` 的身份段（`api_keys` 索引之后、个人库之前）。`users` 与 `api_keys` 的列保持现状。邮箱唯一约束仍是 `TEXT UNIQUE`；因为写入前已经转成小写，约束作用在规范化邮箱上，不把列改成 `citext`。

```sql
-- Refresh Token。只存 HMAC 摘要。family_id 把一次登录之后的轮换串成一族。
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  family_id    UUID NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  replaced_by  UUID REFERENCES refresh_tokens(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);
```

不新增「会话表」或「Access Token 表」。

## 6. 安全

- 口令使用 **argon2id**，参数固定为 memoryCost `19456`（19 MiB）、timeCost `2`、parallelism `1`。`password_hash` 保存库输出的 PHC 字符串（自带盐和参数）。不用 bcrypt，也不要把明文、盐单独再存一列。
- API Key 与 Refresh Token 是高熵随机串，用 HMAC-SHA256，不用 argon2。比较摘要时使用恒定时间比较。
- 数据库只保存口令的 PHC 字符串，以及 API Key、Refresh Token 的 HMAC。不保存这三类秘密的明文。日志和错误响应既不出现明文，也不出现摘要。成功响应只按第 3 节返回一次性明文（Access JWT、Refresh Token、新建 API Key 的 `secret`）。日志可以有 `userId`、key id、refresh token id、`key_prefix`。
- 登录对未知邮箱执行哑哈希校验（见 3.2）。
- Principal 只标识凭证种类，不包含相册、照片或成员角色。Phase 1 的路由不得根据「将来的册主」做放行。
- 传输层 TLS 由现有 Nginx 草图承担。应用本身不设置 Cookie，因此本阶段没有 Cookie 会话的 CSRF 面。
- 不实现限流。口令长度上限 128，避免超长输入把 argon2 拖成拒绝服务。

## 7. 验收测试清单

测试放在 `apps/api/test/identity-auth.test.ts`，使用现有的 `node:test` 与 `buildApp().inject`。仓储走真实 PostgreSQL（`DATABASE_URL`，本地 `docker compose up -d` 后应用含 `refresh_tokens` 的 `deploy/db/schema.sql`）。哈希与 JWT 使用真实网关。时钟由测试注入。缺少 `DATABASE_URL` 时测试失败，而不是跳过。跑 `npm test` 时，原有的分层边界检查必须仍然通过。

与第 3 节对应的断言：

1. 注册新邮箱返回 201，正文含 `accessToken`、`refreshToken`、`tokenType = Bearer`，以及规范化后的邮箱。`users.password_hash` 不是明文，并且是 argon2id PHC 字符串。
2. 同一邮箱再次注册返回 409 `email_taken`。大小写不同、前后空白不同的同一邮箱也冲突。
3. 正确口令登录返回 200，并带一对新 token。响应体不含 `family_id`；测试从 `refresh_tokens` 读出该次登录的 `family_id`，并确认它与注册时那一行不同。
4. 错误口令与未知邮箱都返回 401，`error.code` 与 `error.message` 完全相同，正文不含 `password_hash` 或邮箱是否存在的其他字段。
5. `GET /me` 携带注册得到的 Access JWT 时返回 200，`principal.credentialKind` 为 `password_session`，`userId` 等于用户 id。
6. 注入时钟前进 `JWT_TTL` 再加 5 秒偏差之后，同一 Access JWT 访问 `GET /me` 返回 401 `unauthorized`。篡改签名同样返回 401，且 `code` 与过期时相同。
7. `POST /auth/refresh` 返回新的 Access JWT 与新的 Refresh Token。旧 Refresh Token 再刷新返回 401，并且该 family 下没有仍未撤销的行。
8. 登录两次得到两个 family。登出其中一个 Refresh Token（204）后，该 token 再刷新返回 401；另一个 family 的 Refresh Token 仍可刷新。
9. `password_session` 可以创建 API Key（201）。响应中的 `secret` 以 `oalb_` 开头。随后 `GET /api-keys` 的正文不包含该 `secret`，也不包含 `key_hash`。
10. 数据库 `api_keys` 中不存在第 9 步的明文；`key_prefix` 与明文的前缀一致，`key_hash` 等于约定的 HMAC。
11. 用该 `secret` 作为 Bearer 调用 `GET /me` 返回同一 `userId`，`credentialKind` 为 `api_key`。`last_used_at` 被写入。
12. `DELETE /api-keys/:id` 返回 204。同一 secret 再调用 `GET /me` 返回 401。再次 DELETE 仍为 204。
13. 用 API Key 调用 `POST /api-keys`、`GET /api-keys`、`DELETE /api-keys/:id` 均返回 403 `forbidden`。
14. 缺少 `Authorization`、方案不是 Bearer、Bearer 值为空、Bearer 为 Refresh Token，访问 `GET /me` 都返回 401 `unauthorized`。
15. `npm test` 中的分层边界检查通过：`domain/identity` 不 import `fastify`、`pg`、`argon2`、`jose`。
16. 非法邮箱、短于 8 位的密码、空的 API Key 名称分别返回 400 `validation_error`，且 `message` 为第 3 节规定的固定句。

## 8. 明确不做

- 网页、小程序、管理后台，以及任何 `apps/web` 的改动（Phase 6）
- Cookie 会话、CSRF 令牌
- OAuth、第三方登录、多因素认证
- 邮箱验证、找回密码、修改密码
- 相册、照片、共享册的 ACL 与角色判断
- 限流、锁定账户、验证码，以及任何具体的阈值
- OpenAPI 文件、双密钥轮换、Refresh Token 复用时的邮件通知
- 物理删除用户或 API Key

## 9. 已确认决策

- 交付面只有 HTTP API 与自动化测试，不做网页。
- 人类会话是短时 Access JWT 加可轮换、可吊销的 Refresh Token，多端统一走 Bearer。
- Agent 使用独立的 API Key，和密码会话共享 `userId`，不共享 Refresh Token。
- 注册冲突 409；登录失败统一 401；其余鉴权失败统一 401 `unauthorized`。
- API Key 的创建、列表、吊销只允许 `password_session`。
