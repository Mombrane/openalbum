# OpenAlbum Phase 1 — 身份与鉴权 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付邮箱注册、登录、短时 Access JWT、可轮换 Refresh Token 与 API Key 的 HTTP API，并把 Bearer 解析成带必填 `credentialId` 的主体。

**Architecture:** 领域层只放模型、端口和纯规则；DAO 用 `pg` 实现仓储，刷新轮换放在单事务 `SELECT … FOR UPDATE` 里；网关实现 argon2id、HMAC-SHA256 与 jose HS256；适配层编排用例和 `resolvePrincipal`；Fastify 只做 JSON Schema、状态码和日志脱敏。组合根是 `apps/api/src/app.ts` 与 `apps/api/src/wire-identity.ts`。校验 Access JWT 时禁止查询 `refresh_tokens`。

**Tech Stack:** Node/TS, Fastify, pg, argon2, jose, docker postgres, node:test

## Global Constraints

下列约束每个任务都要遵守。数值来自 [`docs/superpowers/specs/2026-11-03-openalbum-phase1-identity-auth-design.md`](../specs/2026-11-03-openalbum-phase1-identity-auth-design.md) 与 [`specs/phases/01-identity-auth.md`](../../../specs/phases/01-identity-auth.md)。

- Node.js `>=20`。新运行时依赖只有 `pg`、`argon2`、`jose`。不引入 Passport、新的校验库或别的鉴权框架。
- Access JWT 只用 HS256。`iss` 为 `openalbum`，`aud` 为 `openalbum-api`，`kind` 必须是 `password_session`，`cid` 必填。`alg=none` 以及其他算法一律拒绝。
- `JWT_TTL` 默认 `15m`。`exp - iat` 等于解析后的 `JWT_TTL`。校验允许 5 秒时钟偏差。签发和过期判断都走注入的 `Clock`，不读 `Date.now()`。
- `REFRESH_TTL` 默认 `30d`。时长语法只接受正整数加 `s`、`m` 或 `d`，例如 `15m`、`2s`、`30d`。
- `JWT_SECRET` 与 `API_KEY_PEPPER` 缺失或 UTF-8 短于 32 字节时，进程拒绝启动。
- 环境变量名保持 `API_KEY_PEPPER`。它同时是 API Key 和 Refresh Token 的 HMAC 键。本阶段不改名为 `TOKEN_PEPPER`，也不做双密钥平滑轮换。
- argon2id 参数固定为 memoryCost `19456`、timeCost `2`、parallelism `1`。库内只存 PHC 字符串。
- Refresh Token 明文：`oalr_` 加 32 字节密码学随机数的 base64url，无填充。API Key 明文：`oalb_` 加 8 位 `[A-Za-z0-9]` 加 `_` 加 32 字节 base64url，无填充。`key_prefix` 存 `oalb_` 加这 8 位。
- HMAC-SHA256 的消息是完整明文，输出小写 hex。比较摘要用恒定时间比较。
- 邮箱在校验前 trim 并转成小写，匹配 `^[^\s@]+@[^\s@]+\.[^\s@]+$`，长度 1–320。密码按 JavaScript 字符串长度 8–128，不 trim，不要求字符类别。名称 trim 后长度 1–64，拒绝控制字符（U+0000–U+001F 与 U+007F）。
- 错误体只有 `{ "error": { "code", "message" } }`。固定文案只有：「请求不合法」「邮箱格式不正确」「密码长度须为 8 到 128」「名称不合法」「标识不合法」「邮箱或密码错误」「未授权」「当前凭证不能执行该操作」「该邮箱已注册」「未找到」。
- `Principal.credentialId` 必填。密码会话时它是签发该 Access JWT 的 Refresh Token 行 id；API Key 时它是 `api_keys.id`。
- **硬规则：** Phase 1 校验 Access JWT 禁止查询 `refresh_tokens`，禁止按 `cid` 查库。`cid` 保留在令牌里，注释写明「预埋、本阶段禁止查库」。登出或轮换只撤销 Refresh Token；未过期的 Access JWT 在剩余 TTL 内仍然有效。
- 鉴权路由不得把原始请求体写入日志。日志可以有 `userId`、key id、refresh token id、`key_prefix`，不能有口令、Refresh Token 明文、API Key 明文、`password_hash`、`key_hash`、`token_hash`。
- 不实现限流器，也不写限流阈值。计划与 `deploy/` 文档必须写明：没有反向代理或网关限流之前，不要把 `POST /auth/register` 和 `POST /auth/login` 暴露到公网。
- 不改 `apps/web`。不发 Cookie。不做 OAuth、邮箱验证、找回密码、修改密码、OpenAPI、物理删除用户或 API Key、每用户 Key 数量上限、相册 ACL。
- 领域层不 import `fastify`、`pg`、`argon2`、`jose`。适配层不 import `dao`、`gateways`、`interfaces`，也不直接调用 `jose`、`argon2` 或 `node:crypto`。接口层不 import `dao`、`gateways`。
- 身份测试连接真实 PostgreSQL。缺少 `DATABASE_URL` 时失败，不跳过。`GET /health` 保持不访问数据库。
- 按任务编号顺序执行。后一个任务假设前一个任务已经提交。不要提前实现后续任务的路由。
- 实现本计划时，子代理使用 Composer 2.5，不使用 fast 模式。

**开工前阅读：**

- `docs/superpowers/specs/2026-11-03-openalbum-phase1-identity-auth-design.md`
- `specs/phases/01-identity-auth.md`
- `apps/api/src/app.ts`
- `apps/api/test/health.test.ts`
- `scripts/check-layer-boundaries.mjs`
- `deploy/db/schema.sql`
- `deploy/env.example`

**开工前命令：** 下文所有命令都在仓库根目录执行。

```bash
npm install
```

---

## File Structure

| 路径 | 职责 |
|------|------|
| `docs/superpowers/specs/2026-11-03-openalbum-phase1-identity-auth-design.md` | 在 §4.1 写明 `credentialId` 必填。不改「状态：已定稿」行 |
| `specs/phases/01-identity-auth.md` | 领域触点改为必填 `credentialId`。只有最后一个任务才把状态改成 `done` |
| `specs/SPEC.md` | 只有最后一个任务才把阶段 1 的索引行改成 `done` |
| `deploy/env.example` | `JWT_TTL=15m`，新增 `REFRESH_TTL=30d`。`JWT_SECRET` 与 `API_KEY_PEPPER` 的占位符都至少 32 字节。注释 pepper 双重用途与公网警告 |
| `deploy/db/schema.sql` | 在身份段追加 `refresh_tokens` |
| `deploy/README.md` | 写明没有限流不要公开注册和登录 |
| `deploy/nginx.example.conf` | 同样的警告注释，不配置 `limit_req` |
| `apps/api/src/domain/identity/model.ts` | `User`、`ApiKeyRecord`、`RefreshTokenRecord`、`Principal` |
| `apps/api/src/domain/identity/ports.ts` | 仓储、哈希、时钟、ID、JWT、随机明文端口 |
| `apps/api/src/domain/identity/email.ts` | 邮箱规范化 |
| `apps/api/src/domain/identity/password.ts` | 口令长度 |
| `apps/api/src/domain/identity/api-key-name.ts` | 名称规则 |
| `apps/api/src/domain/identity/refresh-policy.ts` | 刷新四态判定，不含 SQL |
| `apps/api/src/domain/identity/index.ts` | 领域桶导出 |
| `apps/api/src/gateways/auth/config.ts` | 解析环境变量 |
| `apps/api/src/gateways/auth/system-clock.ts` | 系统时钟 |
| `apps/api/src/gateways/auth/id-generator.ts` | `crypto.randomUUID()` |
| `apps/api/src/gateways/auth/password-hasher.ts` | argon2id 与启动时哑哈希 |
| `apps/api/src/gateways/auth/token-hasher.ts` | HMAC-SHA256，注释 pepper 的双重用途 |
| `apps/api/src/gateways/auth/access-token-issuer.ts` | jose HS256。`cid` 预埋、本阶段禁止查库 |
| `apps/api/src/gateways/auth/secret-generator.ts` | Refresh Token 与 API Key 明文 |
| `apps/api/src/dao/user-repository.ts` | `users` |
| `apps/api/src/dao/api-key-repository.ts` | `api_keys` |
| `apps/api/src/dao/refresh-token-repository.ts` | `refresh_tokens`，含 `FOR UPDATE` |
| `apps/api/src/adapters/identity/messages.ts` | 固定错误文案 |
| `apps/api/src/adapters/identity/deps.ts` | `IdentityDeps` 与更窄的 `ResolvePrincipalDeps` |
| `apps/api/src/adapters/identity/session.ts` | 签发一对 token。`cid` 写入 JWT，不查库 |
| `apps/api/src/adapters/identity/register-user.ts` | 注册 |
| `apps/api/src/adapters/identity/login-user.ts` | 登录，未知邮箱走哑哈希 |
| `apps/api/src/adapters/identity/refresh-session.ts` | 轮换与连坐 |
| `apps/api/src/adapters/identity/logout-session.ts` | 只撤销提交的那一行 |
| `apps/api/src/adapters/identity/get-me.ts` | 当前用户 |
| `apps/api/src/adapters/identity/api-keys.ts` | 创建、列表、吊销 |
| `apps/api/src/adapters/identity/resolve-principal.ts` | Bearer 顺序。JWT 分支不接收刷新仓储 |
| `apps/api/src/adapters/identity/require-principal.ts` | 把解析失败映射成 401 |
| `apps/api/src/interfaces/http/validation.ts` | 语义校验与固定句 |
| `apps/api/src/interfaces/http/error-handler.ts` | Schema 失败统一成「请求不合法」，日志不带请求体 |
| `apps/api/src/interfaces/http/auth-logger.ts` | 日志脱敏 |
| `apps/api/src/interfaces/http/send-auth-error.ts` | 错误体 |
| `apps/api/src/interfaces/http/register-auth.ts` | `/auth/register`、`/auth/login`、`/auth/refresh`、`/auth/logout` |
| `apps/api/src/interfaces/http/register-me.ts` | `GET /me` |
| `apps/api/src/interfaces/http/register-api-keys.ts` | API Key 三路由 |
| `apps/api/src/wire-identity.ts` | 组合根装配。禁止移入五层目录 |
| `apps/api/src/app.ts` | `buildApp` 注入时钟、连接池和配置 |
| `apps/api/src/index.ts` | 启动前调用 `loadAuthConfig` |
| `apps/api/test/manual-clock.ts` | 测试时钟 |
| `apps/api/test/apply-schema.ts` | 执行 `schema.sql`，缺少 `DATABASE_URL` 就抛错 |
| `apps/api/test/auth-config.test.ts` | 时长与密钥长度 |
| `apps/api/test/identity-domain.test.ts` | 纯规则 |
| `apps/api/test/auth-gateways.test.ts` | 哈希、JWT 时钟与 `alg=none` |
| `apps/api/test/identity-dao.test.ts` | 仓储与事务 |
| `apps/api/test/resolve-principal.test.ts` | Bearer 顺序，以及 JWT 分支不碰 Key 仓储 |
| `apps/api/test/identity-auth.test.ts` | 设计 §7 加上审查追加的并发刷新、过期不连坐、登出后 Access JWT 仍有效、日志脱敏 |
| `scripts/check-layer-boundaries.mjs` | 领域禁令补上 `argon2` 与 `jose` |
| `apps/api/test/health.test.ts` | 改为注入配置，仍然不访问数据库 |

不创建 `apps/web` 下的文件，不新增 Cookie 中间件，不新增限流模块。

---

### Task 1: 把 credentialId 对齐成必填

**Files:**
- Modify: `specs/phases/01-identity-auth.md`
- Modify: `docs/superpowers/specs/2026-11-03-openalbum-phase1-identity-auth-design.md`

**Interfaces:**
- Consumes: 设计 §2.1 已规定两种成功凭证都必须带 `credentialId`
- Produces: 阶段规格与设计 §4.1 使用同一句「必填」，后续任务的 `Principal.credentialId: string` 以此为准

- [ ] **Step 1: 改阶段规格的领域触点**

把 `specs/phases/01-identity-auth.md` 里「可选 `credentialId`」那一句整句替换为：

```markdown
`domain/identity`：用户、口令凭证、Refresh Token、API Key 实体或值对象；校验、轮换与吊销规则；用户、Refresh Token 与 Key 的仓储端口。主体是 `userId` + `credentialKind`（`password_session` | `api_key`）+ 必填 `credentialId`（密码会话为签发该 Access JWT 的 Refresh Token 行 id，API Key 为 `api_keys.id`；两种成功凭证都必须带上它），不含相册权限。
```

状态行保持 `planned`。不要勾验收框。

- [ ] **Step 2: 在设计 §4.1 补上同一约束**

在 `docs/superpowers/specs/2026-11-03-openalbum-phase1-identity-auth-design.md` 的「实体与值对象」段落后插入：

```markdown
`Principal.credentialId` 在本阶段必填，与 §2.1 一致，不是可选字段。密码会话时它是签发该 Access JWT 的 Refresh Token 行 id；API Key 时它是 `api_keys.id`。两种成功凭证都必须带上它。
```

不要修改该文件开头的「状态：已定稿（待实现）」。

- [ ] **Step 3: 确认两处都不再把 credentialId 写成可选**

Run（仓库根目录）:

```bash
rg -n -F '可选 `credentialId`' specs/phases/01-identity-auth.md docs/superpowers/specs/2026-11-03-openalbum-phase1-identity-auth-design.md
```

Expected: 无输出，退出码 1。`-F` 按字面量匹配，反引号不用再转义。

```bash
rg -n -F '必填 `credentialId`' specs/phases/01-identity-auth.md
rg -n -F '`Principal.credentialId` 在本阶段必填' docs/superpowers/specs/2026-11-03-openalbum-phase1-identity-auth-design.md
```

Expected: 两条命令都有命中，退出码 0。

- [ ] **Step 4: Commit**

```bash
git add specs/phases/01-identity-auth.md docs/superpowers/specs/2026-11-03-openalbum-phase1-identity-auth-design.md
git commit -m "docs: 写明 Phase 1 主体的 credentialId 必填"
```

---

### Task 2: 环境变量、refresh_tokens 与公网警告

**Files:**
- Create: `apps/api/src/gateways/auth/config.ts`
- Create: `apps/api/test/auth-config.test.ts`
- Modify: `apps/api/src/gateways/index.ts`
- Modify: `deploy/env.example`
- Modify: `deploy/db/schema.sql`
- Modify: `deploy/README.md`
- Modify: `deploy/nginx.example.conf`

**Interfaces:**
- Consumes: 无
- Produces:
  - `parseDurationSeconds(value: string): number`
  - `loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig`
  - `AuthConfig = { jwtSecret: string; pepper: string; accessTtlSeconds: number; refreshTtlSeconds: number; databaseUrl: string }`

- [ ] **Step 1: 写会失败的配置测试**

创建 `apps/api/test/auth-config.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { loadAuthConfig, parseDurationSeconds } from "../src/gateways/auth/config.js";

const secret = "j".repeat(32);
const pepper = "p".repeat(32);
const databaseUrl = "postgres://photo:secret@127.0.0.1:5432/photo_album";

test("parseDurationSeconds 解析 s/m/d", () => {
  assert.equal(parseDurationSeconds("15m"), 900);
  assert.equal(parseDurationSeconds("2s"), 2);
  assert.equal(parseDurationSeconds("30d"), 2_592_000);
});

test("parseDurationSeconds 拒绝没有单位或不是正整数的值", () => {
  for (const value of ["15", "0s", "01s", "-1s", "1h", "15M", "1.5m"]) {
    assert.throws(() => parseDurationSeconds(value), /时长无效/);
  }
});

test("loadAuthConfig 使用 15m 与 30d 作为默认值", () => {
  const config = loadAuthConfig({ JWT_SECRET: secret, API_KEY_PEPPER: pepper, DATABASE_URL: databaseUrl });
  assert.equal(config.accessTtlSeconds, 900);
  assert.equal(config.refreshTtlSeconds, 2_592_000);
  assert.equal(config.jwtSecret, secret);
  assert.equal(config.pepper, pepper);
  assert.equal(config.databaseUrl, databaseUrl);
});

test("loadAuthConfig 拒绝短密钥、短 pepper 和缺失的数据库 URL", () => {
  assert.throws(() => loadAuthConfig({ JWT_SECRET: "short", API_KEY_PEPPER: pepper, DATABASE_URL: databaseUrl }), /JWT_SECRET/);
  assert.throws(() => loadAuthConfig({ JWT_SECRET: secret, API_KEY_PEPPER: "short", DATABASE_URL: databaseUrl }), /API_KEY_PEPPER/);
  assert.throws(() => loadAuthConfig({ JWT_SECRET: secret, API_KEY_PEPPER: pepper }), /DATABASE_URL/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
npx tsx --test apps/api/test/auth-config.test.ts
```

Expected: 退出码非 0，输出包含 `Cannot find module` 与 `config.js`。

- [ ] **Step 3: 实现配置解析**

创建 `apps/api/src/gateways/auth/config.ts`：

```typescript
export type AuthConfig = {
  jwtSecret: string;
  pepper: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  databaseUrl: string;
};

const DURATION = /^([1-9][0-9]*)(s|m|d)$/;

export function parseDurationSeconds(value: string): number {
  const match = DURATION.exec(value);
  if (!match) {
    throw new Error(`时长无效：${value}`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "s") return amount;
  if (unit === "m") return amount * 60;
  return amount * 86_400;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  return {
    jwtSecret: requiredSecret(env.JWT_SECRET, "JWT_SECRET"),
    pepper: requiredSecret(env.API_KEY_PEPPER, "API_KEY_PEPPER"),
    accessTtlSeconds: parseDurationSeconds(env.JWT_TTL?.trim() || "15m"),
    refreshTtlSeconds: parseDurationSeconds(env.REFRESH_TTL?.trim() || "30d"),
    databaseUrl: requiredDatabaseUrl(env.DATABASE_URL),
  };
}

function requiredSecret(value: string | undefined, name: string): string {
  if (value === undefined || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} 缺失或短于 32 字节`);
  }
  return value;
}

function requiredDatabaseUrl(value: string | undefined): string {
  const databaseUrl = value?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL 缺失");
  }
  return databaseUrl;
}
```

把 `apps/api/src/gateways/index.ts` 改成：

```typescript
/**
 * 网关层入口。
 *
 * 实现领域或应用定义的出站端口。不做业务判断，也不被接口层直接调用。
 */
export { STORAGE_GATEWAY } from "./storage/index.js";
export { VISION_GATEWAY } from "./vision/index.js";
export { EMBED_GATEWAY } from "./embed/index.js";
export { loadAuthConfig, parseDurationSeconds } from "./auth/config.js";
export type { AuthConfig } from "./auth/config.js";
```

- [ ] **Step 4: 更新 env、DDL 和部署警告**

把 `deploy/env.example` 的鉴权段替换为：

```bash
# --- 鉴权 ---
# 占位符本身至少 32 字节。实际值短于 32 字节时进程拒绝启动。
JWT_SECRET=CHANGE_ME_LONG_RANDOM_AT_LEAST_32_BYTES
# Access JWT 有效期。生产默认 15m。只接受正整数加 s/m/d。
JWT_TTL=15m
# Refresh Token 有效期。生产默认 30d。语法同 JWT_TTL。
REFRESH_TTL=30d
# HMAC-SHA256 键。API Key 与 Refresh Token 共用这一把，不是只用于 API Key。
# 变量名保持 API_KEY_PEPPER，与 Phase 1 设计合同一致；本阶段不改名为 TOKEN_PEPPER。
# 实际值必须至少 32 字节。轮换会使已发出的 API Key 与 Refresh Token 全部失效。
# 在没有反向代理或网关限流之前，不要把 POST /auth/register 与 POST /auth/login 暴露到公网。
# 本阶段不实现限流器，也不规定阈值。
API_KEY_PEPPER=CHANGE_ME_PEPPER_AT_LEAST_32_BYTES
```

在 `deploy/db/schema.sql` 的 `idx_api_keys_prefix` 索引之后、`-- 个人库` 之前插入：

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

在 `deploy/README.md` 的「密钥清单」之前插入：

```markdown
## 注册与登录不要裸露到公网

`POST /auth/register` 与 `POST /auth/login` 在 Phase 1 没有限流。在反向代理或网关加上限流之前，不要把这两个路径公开到互联网。本仓库不实现限流器，也不规定阈值。口令长度上限 128 只是为了避免超长 argon2 输入，不是限流。

Phase 1 的 `schema.sql` 在身份段增加 `refresh_tokens`。本地仍然用 `docker compose up -d` 后执行该文件。
```

在密钥清单里追加一条，不要删原有条目：

```markdown
- [ ] `API_KEY_PEPPER`（API Key 与 Refresh Token 共用的 HMAC 键）
```

在 `deploy/nginx.example.conf` 的 `location /api/` 之前插入注释，不要添加 `limit_req` 或限流数值：

```nginx
    # 警告：在没有限流之前，不要把 POST /auth/register 与 POST /auth/login 暴露到公网。
    # Phase 1 不实现限流器，也不在这里配置 limit_req 阈值。
```

- [ ] **Step 5: 运行测试，确认通过**

Run:

```bash
npx tsx --test apps/api/test/auth-config.test.ts
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const text = readFileSync('deploy/env.example', 'utf8');
for (const name of ['JWT_SECRET', 'API_KEY_PEPPER']) {
  const line = text.split('\n').find((item) => item.startsWith(name + '='));
  if (!line) {
    console.error('缺少 ' + name);
    process.exit(1);
  }
  const bytes = Buffer.byteLength(line.slice(name.length + 1).trim());
  if (bytes < 32) {
    console.error(name + ' 只有 ' + bytes + ' 字节');
    process.exit(1);
  }
}
"
rg -n "limit_req" deploy/nginx.example.conf
```

Expected: 测试退出码 0，输出含 `# fail 0`。`node` 命令退出码 0，表示 `deploy/env.example` 里的 `JWT_SECRET` 与 `API_KEY_PEPPER` 都至少 32 字节。`rg limit_req` 无输出且退出码 1。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/gateways/auth/config.ts apps/api/src/gateways/index.ts apps/api/test/auth-config.test.ts deploy/env.example deploy/db/schema.sql deploy/README.md deploy/nginx.example.conf
git commit -m "feat: 补齐 Phase 1 鉴权环境变量与 refresh_tokens 表"
```

---

### Task 3: 领域模型与纯规则

**Files:**
- Create: `apps/api/src/domain/identity/model.ts`
- Create: `apps/api/src/domain/identity/ports.ts`
- Create: `apps/api/src/domain/identity/email.ts`
- Create: `apps/api/src/domain/identity/password.ts`
- Create: `apps/api/src/domain/identity/api-key-name.ts`
- Create: `apps/api/src/domain/identity/refresh-policy.ts`
- Modify: `apps/api/src/domain/identity/index.ts`
- Test: `apps/api/test/identity-domain.test.ts`

**Interfaces:**
- Consumes: Task 1 的必填 `credentialId`
- Produces:
  - `Principal = { userId: string; credentialKind: "password_session" | "api_key"; credentialId: string }`
  - `normalizeEmail(raw: string): string | null`
  - `validatePassword(password: string): boolean`
  - `normalizeApiKeyName(raw: string): string | null`
  - `decideRefresh(row: { revokedAt: Date | null; expiresAt: Date } | null, now: Date): { kind: "missing" | "expired" | "replay" | "rotate" }`
  - 端口类型见 Step 3，后续网关、DAO、适配层按这些名字实现

- [ ] **Step 1: 写会失败的领域测试**

创建 `apps/api/test/identity-domain.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApiKeyName } from "../src/domain/identity/api-key-name.js";
import { normalizeEmail } from "../src/domain/identity/email.js";
import { validatePassword } from "../src/domain/identity/password.js";
import { decideRefresh } from "../src/domain/identity/refresh-policy.js";

const now = new Date("2030-01-01T00:00:00.000Z");

test("normalizeEmail 去掉空白并转成小写", () => {
  assert.equal(normalizeEmail("  User@Example.COM "), "user@example.com");
  assert.equal(normalizeEmail("a@b.c"), "a@b.c");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail("a@b"), null);
  assert.equal(normalizeEmail("a b@c.d"), null);
  assert.equal(normalizeEmail(`${"a".repeat(320)}@b.c`), null);
});

test("validatePassword 只看 JavaScript 长度并且不 trim", () => {
  assert.equal(validatePassword("1234567"), false);
  assert.equal(validatePassword("12345678"), true);
  assert.equal(validatePassword("a".repeat(128)), true);
  assert.equal(validatePassword("a".repeat(129)), false);
  assert.equal(validatePassword(" 1234567"), true);
});

test("normalizeApiKeyName 拒绝空名、超长名和控制字符", () => {
  assert.equal(normalizeApiKeyName("  我的 Agent  "), "我的 Agent");
  assert.equal(normalizeApiKeyName("a".repeat(64)), "a".repeat(64));
  assert.equal(normalizeApiKeyName("   "), null);
  assert.equal(normalizeApiKeyName("a".repeat(65)), null);
  assert.equal(normalizeApiKeyName("a\nb"), null);
  assert.equal(normalizeApiKeyName("a\u007Fb"), null);
});

test("decideRefresh 覆盖四态，已撤销优先于过期", () => {
  assert.deepEqual(decideRefresh(null, now), { kind: "missing" });
  assert.deepEqual(
    decideRefresh({ revokedAt: null, expiresAt: new Date("2029-01-01T00:00:00.000Z") }, now),
    { kind: "expired" },
  );
  assert.deepEqual(
    decideRefresh({ revokedAt: null, expiresAt: now }, now),
    { kind: "expired" },
  );
  assert.deepEqual(
    decideRefresh({ revokedAt: now, expiresAt: new Date("2031-01-01T00:00:00.000Z") }, now),
    { kind: "replay" },
  );
  assert.deepEqual(
    decideRefresh({ revokedAt: now, expiresAt: new Date("2029-01-01T00:00:00.000Z") }, now),
    { kind: "replay" },
  );
  assert.deepEqual(
    decideRefresh({ revokedAt: null, expiresAt: new Date("2031-01-01T00:00:00.000Z") }, now),
    { kind: "rotate" },
  );
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
npx tsx --test apps/api/test/identity-domain.test.ts
```

Expected: 退出码非 0，`Cannot find module` 指向 `refresh-policy.js` 或同目录其他新文件。

- [ ] **Step 3: 写模型、端口和纯函数**

创建 `apps/api/src/domain/identity/model.ts`：

```typescript
export const CREDENTIAL_KINDS = ["password_session", "api_key"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** 两种成功凭证的 credentialId 都必填。 */
export type Principal = {
  userId: string;
  credentialKind: CredentialKind;
  credentialId: string;
};

export type User = {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
};

export type ApiKeyRecord = {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

export type RefreshTokenRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
  createdAt: Date;
};

export type LockedRefreshToken = {
  id: string;
  userId: string;
  userEmail: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
};
```

创建 `apps/api/src/domain/identity/ports.ts`：

```typescript
import type { ApiKeyRecord, LockedRefreshToken, RefreshTokenRecord, User } from "./model.js";

export type Clock = { now(): Date };
export type IdGenerator = { nextId(): string };

export type PasswordHasher = {
  hash(plain: string): Promise<string>;
  verify(plain: string, encoded: string): Promise<boolean>;
  /** 启动时生成的固定 argon2id 哑哈希，不对应任何账户。 */
  dummyHash(): string;
};

export type TokenHasher = {
  hash(raw: string): string;
  equal(leftHex: string, rightHex: string): boolean;
};

export type AccessTokenClaims = { userId: string; credentialId: string };
export type VerifiedAccessToken = {
  userId: string;
  credentialId: string;
  kind: "password_session";
};

export type AccessTokenIssuer = {
  sign(claims: AccessTokenClaims): Promise<string>;
  /**
   * 只校验令牌本身。cid 预埋、本阶段禁止查库。
   * 任何失败都返回 null，不抛错。
   */
  verify(jwt: string): Promise<VerifiedAccessToken | null>;
};

export type GeneratedApiKey = { prefix: string; secret: string };
export type SecretGenerator = {
  refreshToken(): string;
  apiKey(): GeneratedApiKey;
};

export type AuthLog = {
  warn(event: string, fields: { userId?: string; keyId?: string; keyPrefix?: string }): void;
};

export type UserRepository = {
  insert(user: User): Promise<"ok" | "email_taken">;
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
};

export type ApiKeyRepository = {
  insert(record: ApiKeyRecord): Promise<void>;
  listByUser(userId: string): Promise<ApiKeyRecord[]>;
  findActiveByPrefix(prefix: string): Promise<ApiKeyRecord[]>;
  revoke(id: string, userId: string, revokedAt: Date): Promise<"revoked" | "already" | "missing">;
  touchLastUsed(id: string, usedAt: Date): Promise<void>;
};

export type RefreshTokenTx = {
  insert(record: RefreshTokenRecord): Promise<void>;
  revokeFamily(familyId: string, revokedAt: Date): Promise<void>;
  markReplaced(id: string, replacedBy: string, revokedAt: Date): Promise<void>;
};

export type RefreshTokenRepository = {
  insert(record: RefreshTokenRecord): Promise<void>;
  /**
   * 在一个事务里按 token_hash 执行 SELECT … FOR UPDATE。
   * 找不到行时 row 为 null，mutate 若不再写库则整个事务不改数据。
   * mutate 抛错则回滚。
   */
  transactByHash(
    tokenHash: string,
    mutate: (row: LockedRefreshToken | null, tx: RefreshTokenTx) => Promise<void>,
  ): Promise<void>;
  /** 只撤销匹配的那一行。不存在或已经撤销时不报错，不连坐 family。 */
  revokeByHash(tokenHash: string, revokedAt: Date): Promise<void>;
};
```

创建 `apps/api/src/domain/identity/email.ts`：

```typescript
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 1 || email.length > 320) return null;
  if (!EMAIL.test(email)) return null;
  return email;
}
```

创建 `apps/api/src/domain/identity/password.ts`：

```typescript
export function validatePassword(password: string): boolean {
  return password.length >= 8 && password.length <= 128;
}
```

创建 `apps/api/src/domain/identity/api-key-name.ts`：

```typescript
const CONTROL = /[\u0000-\u001F\u007F]/;

export function normalizeApiKeyName(raw: string): string | null {
  const name = raw.trim();
  if (name.length < 1 || name.length > 64) return null;
  if (CONTROL.test(name)) return null;
  return name;
}
```

创建 `apps/api/src/domain/identity/refresh-policy.ts`：

```typescript
export type RefreshSnapshot = {
  revokedAt: Date | null;
  expiresAt: Date;
};

export type RefreshDecision = { kind: "missing" | "expired" | "replay" | "rotate" };

export function decideRefresh(row: RefreshSnapshot | null, now: Date): RefreshDecision {
  if (row === null) return { kind: "missing" };
  if (row.revokedAt !== null) return { kind: "replay" };
  if (row.expiresAt.getTime() <= now.getTime()) return { kind: "expired" };
  return { kind: "rotate" };
}
```

把 `apps/api/src/domain/identity/index.ts` 替换为：

```typescript
/** 身份上下文：用户、口令会话、Refresh Token、API Key。 */
export const IDENTITY_CONTEXT = "identity" as const;

export { normalizeApiKeyName } from "./api-key-name.js";
export { normalizeEmail } from "./email.js";
export {
  CREDENTIAL_KINDS,
  type ApiKeyRecord,
  type CredentialKind,
  type LockedRefreshToken,
  type Principal,
  type RefreshTokenRecord,
  type User,
} from "./model.js";
export { validatePassword } from "./password.js";
export type {
  AccessTokenClaims,
  AccessTokenIssuer,
  ApiKeyRepository,
  AuthLog,
  Clock,
  GeneratedApiKey,
  IdGenerator,
  PasswordHasher,
  RefreshTokenRepository,
  RefreshTokenTx,
  SecretGenerator,
  TokenHasher,
  UserRepository,
  VerifiedAccessToken,
} from "./ports.js";
export { decideRefresh, type RefreshDecision, type RefreshSnapshot } from "./refresh-policy.js";
```

这些文件不得出现 `fastify`、`pg`、`argon2`、`jose`、`node:crypto`。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
npx tsx --test apps/api/test/identity-domain.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 测试退出码 0。`tsc` 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/domain/identity apps/api/test/identity-domain.test.ts
git commit -m "feat: 添加身份领域模型与刷新判定"
```

---

### Task 4: 时钟、哈希、JWT 与随机明文网关

**Files:**
- Create: `apps/api/src/gateways/auth/system-clock.ts`
- Create: `apps/api/src/gateways/auth/id-generator.ts`
- Create: `apps/api/src/gateways/auth/password-hasher.ts`
- Create: `apps/api/src/gateways/auth/token-hasher.ts`
- Create: `apps/api/src/gateways/auth/access-token-issuer.ts`
- Create: `apps/api/src/gateways/auth/secret-generator.ts`
- Create: `apps/api/test/manual-clock.ts`
- Create: `apps/api/test/auth-gateways.test.ts`
- Modify: `apps/api/package.json`（只通过 `npm install` 改依赖）
- Modify: `apps/api/src/gateways/index.ts`

**Interfaces:**
- Consumes: `Clock`、`IdGenerator`、`PasswordHasher`、`TokenHasher`、`AccessTokenIssuer`、`SecretGenerator`
- Produces:
  - `createPasswordHasher(): Promise<PasswordHasher>`
  - `createTokenHasher(pepper: string): TokenHasher`
  - `createAccessTokenIssuer(input: { secret: string; ttlSeconds: number; clock: Clock }): AccessTokenIssuer`
  - `createSecretGenerator(): SecretGenerator`
  - `createIdGenerator(): IdGenerator`
  - `SystemClock`
  - `ManualClock`

- [ ] **Step 1: 写会失败的网关测试**

创建 `apps/api/test/manual-clock.ts`：

```typescript
import type { Clock } from "../src/domain/identity/ports.js";

export class ManualClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(next: Date): void {
    this.current = new Date(next.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
```

创建 `apps/api/test/auth-gateways.test.ts`：

```typescript
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { SignJWT, decodeJwt } from "jose";
import { createAccessTokenIssuer } from "../src/gateways/auth/access-token-issuer.js";
import { createPasswordHasher } from "../src/gateways/auth/password-hasher.js";
import { createSecretGenerator } from "../src/gateways/auth/secret-generator.js";
import { createTokenHasher } from "../src/gateways/auth/token-hasher.js";
import { ManualClock } from "./manual-clock.js";

const SECRET = "test-jwt-secret-at-least-32-bytes";
const PEPPER = "test-pepper-at-least-32-bytes-ok";
const START = new Date("2030-01-01T00:00:00.000Z");

test("argon2id 可校验，哑哈希不能通过任意口令", async () => {
  const hasher = await createPasswordHasher();
  const encoded = await hasher.hash("correct-horse");
  assert.equal(encoded.startsWith("$argon2id$"), true);
  assert.equal(encoded.includes("correct-horse"), false);
  assert.equal(await hasher.verify("correct-horse", encoded), true);
  assert.equal(await hasher.verify("wrong-password", encoded), false);
  assert.equal(await hasher.verify("wrong-password", hasher.dummyHash()), false);
  assert.equal(hasher.dummyHash().startsWith("$argon2id$"), true);
});

test("TokenHasher 用 API_KEY_PEPPER 做 HMAC，并恒定时间比较", () => {
  const hasher = createTokenHasher(PEPPER);
  const expected = createHmac("sha256", PEPPER).update("oalr_abc").digest("hex");
  assert.equal(hasher.hash("oalr_abc"), expected);
  assert.equal(hasher.equal(expected, expected), true);
  assert.equal(hasher.equal(expected, hasher.hash("oalr_other")), false);
  assert.equal(hasher.equal("aa", expected), false);
});

test("随机明文符合前缀、长度和无填充", () => {
  const secrets = createSecretGenerator();
  const refresh = secrets.refreshToken();
  assert.match(refresh, /^oalr_[A-Za-z0-9_-]{43}$/);
  assert.equal(refresh.includes("="), false);
  const apiKey = secrets.apiKey();
  assert.match(apiKey.prefix, /^oalb_[A-Za-z0-9]{8}$/);
  assert.equal(apiKey.secret.startsWith(`${apiKey.prefix}_`), true);
  assert.match(apiKey.secret, /^oalb_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
});

test("Access JWT 走注入时钟，cid 只存在令牌里", async () => {
  const clock = new ManualClock(START);
  const issuer = createAccessTokenIssuer({ secret: SECRET, ttlSeconds: 120, clock });
  const token = await issuer.sign({ userId: "user-1", credentialId: "refresh-1" });
  const verified = await issuer.verify(token);
  assert.deepEqual(verified, { userId: "user-1", credentialId: "refresh-1", kind: "password_session" });
  const decoded = decodeJwt(token);
  assert.equal(decoded.iss, "openalbum");
  assert.equal(decoded.aud, "openalbum-api");

  clock.advance(124_000);
  assert.deepEqual(await issuer.verify(token), verified);

  clock.advance(1_000);
  assert.equal(await issuer.verify(token), null);

  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  clock.set(START);
  assert.equal(await issuer.verify(tampered), null);
});

test("kind、iss、aud 不对或 alg=none 时拒绝", async () => {
  const clock = new ManualClock(START);
  const issuer = createAccessTokenIssuer({ secret: SECRET, ttlSeconds: 120, clock });
  const issuedAt = Math.floor(START.getTime() / 1000);
  async function signed(overrides: { iss?: string; aud?: string; kind?: string }) {
    return new SignJWT({ kind: overrides.kind ?? "password_session", cid: "cid-1" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(overrides.iss ?? "openalbum")
      .setAudience(overrides.aud ?? "openalbum-api")
      .setSubject("user-1")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 120)
      .sign(new TextEncoder().encode(SECRET));
  }
  assert.equal(await issuer.verify(await signed({ kind: "api_key" })), null);
  assert.equal(await issuer.verify(await signed({ iss: "other" })), null);
  assert.equal(await issuer.verify(await signed({ aud: "other" })), null);

  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "openalbum",
      aud: "openalbum-api",
      sub: "user-1",
      kind: "password_session",
      cid: "cid-1",
      iat: issuedAt,
      exp: issuedAt + 120,
    }),
  ).toString("base64url");
  assert.equal(await issuer.verify(`${header}.${payload}.`), null);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
npx tsx --test apps/api/test/auth-gateways.test.ts
```

Expected: 退出码非 0。测试文件顶部就 import 了 `jose` 和尚未创建的网关文件，输出会包含 `Cannot find package 'jose'` 或 `Cannot find module` 指向 `access-token-issuer.js`。

- [ ] **Step 3: 安装依赖并实现网关**

Run（仓库根目录）:

```bash
npm install pg argon2 jose -w apps/api
npm install -D @types/pg -w apps/api
```

`pg` 若自带类型且 `@types/pg` 与之冲突，删掉 `@types/pg` 后以 `npx tsc -p apps/api/tsconfig.json --noEmit` 能通过为准。不要再加别的包。

创建 `apps/api/src/gateways/auth/system-clock.ts`：

```typescript
import type { Clock } from "../../domain/identity/ports.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
```

创建 `apps/api/src/gateways/auth/id-generator.ts`：

```typescript
import { randomUUID } from "node:crypto";
import type { IdGenerator } from "../../domain/identity/ports.js";

export function createIdGenerator(): IdGenerator {
  return { nextId: () => randomUUID() };
}
```

创建 `apps/api/src/gateways/auth/password-hasher.ts`：

```typescript
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { PasswordHasher } from "../../domain/identity/ports.js";

const options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function createPasswordHasher(): Promise<PasswordHasher> {
  const dummy = await argon2.hash(randomBytes(32).toString("base64url"), options);
  return {
    dummyHash: () => dummy,
    hash(plain: string) {
      return argon2.hash(plain, options);
    },
    async verify(plain: string, encoded: string) {
      try {
        return await argon2.verify(encoded, plain);
      } catch {
        return false;
      }
    },
  };
}
```

创建 `apps/api/src/gateways/auth/token-hasher.ts`：

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";
import type { TokenHasher } from "../../domain/identity/ports.js";

/**
 * pepper 来自环境变量 API_KEY_PEPPER。
 * API Key 与 Refresh Token 共用这一把 HMAC 键。本阶段不引入 TOKEN_PEPPER。
 */
export function createTokenHasher(pepper: string): TokenHasher {
  return {
    hash(raw: string) {
      return createHmac("sha256", pepper).update(raw, "utf8").digest("hex");
    },
    equal(leftHex: string, rightHex: string) {
      const left = Buffer.from(leftHex, "hex");
      const right = Buffer.from(rightHex, "hex");
      if (left.length === 0 || left.length !== right.length) return false;
      return timingSafeEqual(left, right);
    },
  };
}
```

创建 `apps/api/src/gateways/auth/access-token-issuer.ts`：

```typescript
import { SignJWT, jwtVerify } from "jose";
import type { AccessTokenIssuer, Clock } from "../../domain/identity/ports.js";

const ISSUER = "openalbum";
const AUDIENCE = "openalbum-api";

export function createAccessTokenIssuer(input: {
  secret: string;
  ttlSeconds: number;
  clock: Clock;
}): AccessTokenIssuer {
  const key = new TextEncoder().encode(input.secret);
  return {
    async sign(claims) {
      // cid 预埋、本阶段禁止查库。不得用 credentialId 查询 refresh token 表。
      const issuedAt = Math.floor(input.clock.now().getTime() / 1000);
      return new SignJWT({ kind: "password_session", cid: claims.credentialId })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(claims.userId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + input.ttlSeconds)
        .sign(key);
    },
    async verify(jwt) {
      // cid 预埋、本阶段禁止查库。这里只读令牌，不访问数据库。
      try {
        const { payload, protectedHeader } = await jwtVerify(jwt, key, {
          algorithms: ["HS256"],
          issuer: ISSUER,
          audience: AUDIENCE,
          clockTolerance: 5,
          currentDate: input.clock.now(),
        });
        if (protectedHeader.alg !== "HS256") return null;
        if (payload.kind !== "password_session") return null;
        if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
        if (typeof payload.cid !== "string" || payload.cid.length === 0) return null;
        return { userId: payload.sub, credentialId: payload.cid, kind: "password_session" };
      } catch {
        return null;
      }
    },
  };
}
```

创建 `apps/api/src/gateways/auth/secret-generator.ts`：

```typescript
import { randomBytes } from "node:crypto";
import type { SecretGenerator } from "../../domain/identity/ports.js";

const PREFIX_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function createSecretGenerator(): SecretGenerator {
  return {
    refreshToken() {
      return `oalr_${randomBytes(32).toString("base64url")}`;
    },
    apiKey() {
      const prefix = `oalb_${randomPrefixBody()}`;
      return { prefix, secret: `${prefix}_${randomBytes(32).toString("base64url")}` };
    },
  };
}

function randomPrefixBody(): string {
  let out = "";
  while (out.length < 8) {
    for (const byte of randomBytes(16)) {
      if (byte < 248) {
        out += PREFIX_ALPHABET[byte % 62];
        if (out.length === 8) return out;
      }
    }
  }
  return out;
}
```

在 `apps/api/src/gateways/index.ts` 末尾追加：

```typescript
export { createAccessTokenIssuer } from "./auth/access-token-issuer.js";
export { createIdGenerator } from "./auth/id-generator.js";
export { createPasswordHasher } from "./auth/password-hasher.js";
export { createSecretGenerator } from "./auth/secret-generator.js";
export { SystemClock } from "./auth/system-clock.js";
export { createTokenHasher } from "./auth/token-hasher.js";
```

`access-token-issuer.ts` 与 `token-hasher.ts` 的源码里不得出现字符串 `refresh_tokens`。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
npx tsx --test apps/api/test/auth-gateways.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 两者退出码都是 0。JWT 测试若在真实日期不是 2030 年时仍能在「前进 125 秒」后得到 `null`，说明校验用的是 `ManualClock` 而不是 `Date.now()`。

- [ ] **Step 5: Commit**

```bash
git add apps/api/package.json apps/api/package-lock.json package-lock.json apps/api/src/gateways apps/api/test/manual-clock.ts apps/api/test/auth-gateways.test.ts
git commit -m "feat: 实现口令、HMAC 与 Access JWT 网关"
```

若仓库只有根目录 lockfile，就添加实际被修改的那一个，不要新建空的 lockfile。

---

### Task 5: 身份仓储

**Files:**
- Create: `apps/api/src/dao/user-repository.ts`
- Create: `apps/api/src/dao/api-key-repository.ts`
- Create: `apps/api/src/dao/refresh-token-repository.ts`
- Create: `apps/api/test/apply-schema.ts`
- Create: `apps/api/test/identity-dao.test.ts`
- Modify: `apps/api/src/dao/index.ts`

**Interfaces:**
- Consumes: `UserRepository`、`ApiKeyRepository`、`RefreshTokenRepository`、`RefreshTokenTx`
- Produces:
  - `createUserRepository(pool: pg.Pool): UserRepository`
  - `createApiKeyRepository(pool: pg.Pool): ApiKeyRepository`
  - `createRefreshTokenRepository(pool: pg.Pool): RefreshTokenRepository`
  - `requireDatabaseUrl(): string`
  - `applySchema(pool: pg.Pool): Promise<void>`
  - `truncateIdentity(pool: pg.Pool): Promise<void>`

- [ ] **Step 1: 写会失败的仓储测试**

创建 `apps/api/test/apply-schema.ts`：

```typescript
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL 缺失：身份测试必须连接 PostgreSQL，禁止跳过");
  }
  return databaseUrl;
}

export async function applySchema(pool: pg.Pool): Promise<void> {
  const schemaPath = path.resolve(fileURLToPath(new URL("../../../deploy/db/schema.sql", import.meta.url)));
  const sql = await readFile(schemaPath, "utf8");
  await pool.query(sql);
}

export async function truncateIdentity(pool: pg.Pool): Promise<void> {
  await pool.query("TRUNCATE TABLE users CASCADE");
}
```

创建 `apps/api/test/identity-dao.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import type { RefreshTokenRecord, User } from "../src/domain/identity/model.js";
import { createApiKeyRepository } from "../src/dao/api-key-repository.js";
import { createRefreshTokenRepository } from "../src/dao/refresh-token-repository.js";
import { createUserRepository } from "../src/dao/user-repository.js";
import { applySchema, requireDatabaseUrl, truncateIdentity } from "./apply-schema.js";

const databaseUrl = requireDatabaseUrl();
const now = new Date("2030-01-01T00:00:00.000Z");

test("用户唯一约束、API Key 吊销与 Refresh Token 轮换事务", async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await applySchema(pool);
    await truncateIdentity(pool);
    const users = createUserRepository(pool);
    const apiKeys = createApiKeyRepository(pool);
    const refreshTokens = createRefreshTokenRepository(pool);
    const user: User = {
      id: "00000000-0000-4000-8000-000000000001",
      email: "user@example.com",
      passwordHash: "$argon2id$dummy",
      createdAt: now,
    };
    assert.equal(await users.insert(user), "ok");
    assert.equal(await users.insert({ ...user, id: "00000000-0000-4000-8000-000000000002" }), "email_taken");

    await apiKeys.insert({
      id: "00000000-0000-4000-8000-000000000011",
      userId: user.id,
      name: "agent",
      keyPrefix: "oalb_Ab12Cd34",
      keyHash: "ab".repeat(32),
      revokedAt: null,
      lastUsedAt: null,
      createdAt: now,
    });
    assert.equal((await apiKeys.findActiveByPrefix("oalb_Ab12Cd34")).length, 1);
    assert.equal(await apiKeys.revoke("00000000-0000-4000-8000-000000000011", user.id, now), "revoked");
    assert.equal(await apiKeys.revoke("00000000-0000-4000-8000-000000000011", user.id, now), "already");
    assert.equal(await apiKeys.revoke("00000000-0000-4000-8000-000000000099", user.id, now), "missing");
    assert.equal((await apiKeys.findActiveByPrefix("oalb_Ab12Cd34")).length, 0);

    const current: RefreshTokenRecord = {
      id: "00000000-0000-4000-8000-000000000021",
      userId: user.id,
      tokenHash: "11".repeat(32),
      familyId: "00000000-0000-4000-8000-000000000031",
      expiresAt: new Date("2030-02-01T00:00:00.000Z"),
      revokedAt: null,
      replacedBy: null,
      createdAt: now,
    };
    await refreshTokens.insert(current);
    const replacementId = "00000000-0000-4000-8000-000000000022";
    await refreshTokens.transactByHash(current.tokenHash, async (row, tx) => {
      assert.equal(row?.userEmail, "user@example.com");
      assert.equal(row?.revokedAt, null);
      await tx.insert({ ...current, id: replacementId, tokenHash: "22".repeat(32) });
      await tx.markReplaced(current.id, replacementId, now);
    });
    await refreshTokens.transactByHash(current.tokenHash, async (row, tx) => {
      assert.notEqual(row?.revokedAt, null);
      await tx.revokeFamily(current.familyId, now);
    });
    const left = await pool.query(
      "select count(*)::int as n from refresh_tokens where family_id = $1 and revoked_at is null",
      [current.familyId],
    );
    assert.equal(left.rows[0].n, 0);
  } finally {
    await pool.end();
  }
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
docker compose up -d --wait
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/identity-dao.test.ts
```

Expected: 退出码非 0。在导入阶段失败，输出包含 `Cannot find module` 与 `user-repository.js`。这一步还不会出现断言失败。

- [ ] **Step 3: 实现三个仓储**

创建 `apps/api/src/dao/user-repository.ts`：

```typescript
import pg from "pg";
import type { User } from "../domain/identity/model.js";
import type { UserRepository } from "../domain/identity/ports.js";

export function createUserRepository(pool: pg.Pool): UserRepository {
  return {
    async insert(user) {
      try {
        await pool.query(
          `INSERT INTO users (id, email, password_hash, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)`,
          [user.id, user.email, user.passwordHash, user.createdAt],
        );
        return "ok";
      } catch (error) {
        if (isUniqueViolation(error)) return "email_taken";
        throw error;
      }
    },
    async findByEmail(email) {
      const result = await pool.query(
        "SELECT id, email, password_hash, created_at FROM users WHERE email = $1",
        [email],
      );
      return mapUser(result.rows[0]);
    },
    async findById(id) {
      const result = await pool.query(
        "SELECT id, email, password_hash, created_at FROM users WHERE id = $1",
        [id],
      );
      return mapUser(result.rows[0]);
    },
  };
}

function mapUser(row: { id: string; email: string; password_hash: string; created_at: Date } | undefined): User | null {
  if (!row) return null;
  return { id: row.id, email: row.email, passwordHash: row.password_hash, createdAt: row.created_at };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
```

创建 `apps/api/src/dao/api-key-repository.ts`：

```typescript
import pg from "pg";
import type { ApiKeyRecord } from "../domain/identity/model.js";
import type { ApiKeyRepository } from "../domain/identity/ports.js";

type ApiKeyRow = {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
};

export function createApiKeyRepository(pool: pg.Pool): ApiKeyRepository {
  return {
    async insert(record) {
      await pool.query(
        `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, revoked_at, last_used_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [record.id, record.userId, record.name, record.keyPrefix, record.keyHash, record.revokedAt, record.lastUsedAt, record.createdAt],
      );
    },
    async listByUser(userId) {
      const result = await pool.query<ApiKeyRow>(
        `SELECT id, user_id, name, key_prefix, key_hash, revoked_at, last_used_at, created_at
         FROM api_keys WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
        [userId],
      );
      return result.rows.map(mapApiKey);
    },
    async findActiveByPrefix(prefix) {
      const result = await pool.query<ApiKeyRow>(
        `SELECT id, user_id, name, key_prefix, key_hash, revoked_at, last_used_at, created_at
         FROM api_keys WHERE key_prefix = $1 AND revoked_at IS NULL`,
        [prefix],
      );
      return result.rows.map(mapApiKey);
    },
    async revoke(id, userId, revokedAt) {
      const updated = await pool.query(
        `UPDATE api_keys SET revoked_at = $3
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [id, userId, revokedAt],
      );
      if ((updated.rowCount ?? 0) > 0) return "revoked";
      const existing = await pool.query("SELECT id FROM api_keys WHERE id = $1 AND user_id = $2", [id, userId]);
      return (existing.rowCount ?? 0) > 0 ? "already" : "missing";
    },
    async touchLastUsed(id, usedAt) {
      await pool.query("UPDATE api_keys SET last_used_at = $2 WHERE id = $1", [id, usedAt]);
    },
  };
}

function mapApiKey(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}
```

创建 `apps/api/src/dao/refresh-token-repository.ts`：

```typescript
import pg from "pg";
import type { LockedRefreshToken, RefreshTokenRecord } from "../domain/identity/model.js";
import type { RefreshTokenRepository, RefreshTokenTx } from "../domain/identity/ports.js";

const INSERT_SQL = `INSERT INTO refresh_tokens
  (id, user_id, token_hash, family_id, expires_at, revoked_at, replaced_by, created_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

export function createRefreshTokenRepository(pool: pg.Pool): RefreshTokenRepository {
  return {
    async insert(record) {
      await pool.query(INSERT_SQL, insertParams(record));
    },
    async transactByHash(tokenHash, mutate) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query(
          `SELECT rt.id, rt.user_id, u.email AS user_email, rt.family_id, rt.expires_at, rt.revoked_at
           FROM refresh_tokens rt
           JOIN users u ON u.id = rt.user_id
           WHERE rt.token_hash = $1
           FOR UPDATE OF rt`,
          [tokenHash],
        );
        const row = found.rows[0] ? mapLocked(found.rows[0]) : null;
        const tx: RefreshTokenTx = {
          async insert(record) {
            await client.query(INSERT_SQL, insertParams(record));
          },
          async revokeFamily(familyId, revokedAt) {
            await client.query(
              `UPDATE refresh_tokens SET revoked_at = $2
               WHERE family_id = $1 AND revoked_at IS NULL`,
              [familyId, revokedAt],
            );
          },
          async markReplaced(id, replacedBy, revokedAt) {
            await client.query(
              `UPDATE refresh_tokens SET revoked_at = $3, replaced_by = $2 WHERE id = $1`,
              [id, replacedBy, revokedAt],
            );
          },
        };
        await mutate(row, tx);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async revokeByHash(tokenHash, revokedAt) {
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = $2
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash, revokedAt],
      );
    },
  };
}

function insertParams(record: RefreshTokenRecord): unknown[] {
  return [
    record.id,
    record.userId,
    record.tokenHash,
    record.familyId,
    record.expiresAt,
    record.revokedAt,
    record.replacedBy,
    record.createdAt,
  ];
}

function mapLocked(row: {
  id: string;
  user_id: string;
  user_email: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}): LockedRefreshToken {
  return {
    id: row.id,
    userId: row.user_id,
    userEmail: row.user_email,
    familyId: row.family_id,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}
```

把 `apps/api/src/dao/index.ts` 改成：

```typescript
/**
 * DAO 层入口。
 *
 * 实现身份仓储。DDL 见 deploy/db/schema.sql。
 */
export const DAO_LAYER = "dao" as const;
export { createApiKeyRepository } from "./api-key-repository.js";
export { createRefreshTokenRepository } from "./refresh-token-repository.js";
export { createUserRepository } from "./user-repository.js";
```

DAO 可以 import `pg` 和领域类型，不能 import `fastify`、`argon2`、`jose` 或网关目录。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/identity-dao.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 两者退出码都是 0。若连接失败，先确认 `docker compose ps` 里 `db` 健康，不要把测试改成 skip。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/dao apps/api/test/apply-schema.ts apps/api/test/identity-dao.test.ts
git commit -m "feat: 实现用户、API Key 与 Refresh Token 仓储"
```

---

### Task 6: 用例与 resolvePrincipal

**Files:**
- Create: `apps/api/src/adapters/identity/messages.ts`
- Create: `apps/api/src/adapters/identity/deps.ts`
- Create: `apps/api/src/adapters/identity/session.ts`
- Create: `apps/api/src/adapters/identity/register-user.ts`
- Create: `apps/api/src/adapters/identity/login-user.ts`
- Create: `apps/api/src/adapters/identity/refresh-session.ts`
- Create: `apps/api/src/adapters/identity/logout-session.ts`
- Create: `apps/api/src/adapters/identity/get-me.ts`
- Create: `apps/api/src/adapters/identity/api-keys.ts`
- Create: `apps/api/src/adapters/identity/resolve-principal.ts`
- Create: `apps/api/src/adapters/identity/require-principal.ts`
- Modify: `apps/api/src/adapters/index.ts`
- Test: `apps/api/test/resolve-principal.test.ts`

**Interfaces:**
- Consumes: 领域端口、`decideRefresh`、`createTokenHasher`
- Produces:
  - `IdentityDeps`（含 `accessTtlSeconds`、`refreshTtlSeconds` 和全部端口，不含 `AuthConfig` 类型）
  - `ResolvePrincipalDeps`（只有 `accessTokens`、`apiKeys`、`tokenHasher`、`clock`、`log`）
  - `registerUser`、`loginUser`、`refreshSession`、`logoutSession`、`getMe`、`createApiKey`、`listApiKeys`、`revokeApiKey`
  - `resolvePrincipal(deps: ResolvePrincipalDeps, authorization: string | undefined): Promise<Principal | null>`
  - `requirePrincipal(deps: IdentityDeps, authorization: string | undefined): Promise<Principal | AuthError>`
  - `AuthResult<T> = { ok: true; status: 200 | 201 | 204; body: T } | AuthError`
  - `SessionBody` 与设计 §3.1 的 JSON 字段一致，时间为 ISO 字符串，`accessTokenExpiresIn` 为秒
  - `MESSAGES` 常量，文案与 Global Constraints 完全一致

- [ ] **Step 1: 写会失败的解析测试**

创建 `apps/api/test/resolve-principal.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import type { ApiKeyRecord } from "../src/domain/identity/model.js";
import type { ResolvePrincipalDeps } from "../src/adapters/identity/deps.js";
import { resolvePrincipal } from "../src/adapters/identity/resolve-principal.js";
import { createTokenHasher } from "../src/gateways/auth/token-hasher.js";
import { ManualClock } from "./manual-clock.js";

const PEPPER = "test-pepper-at-least-32-bytes-ok";
const clock = new ManualClock(new Date("2030-01-01T00:00:00.000Z"));
const hasher = createTokenHasher(PEPPER);

function deps(overrides: Partial<ResolvePrincipalDeps> = {}): ResolvePrincipalDeps {
  return {
    accessTokens: {
      async sign() {
        throw new Error("sign unused");
      },
      async verify() {
        return null;
      },
    },
    apiKeys: {
      async findActiveByPrefix() {
        return [];
      },
      async touchLastUsed() {
        throw new Error("touch unused");
      },
    },
    tokenHasher: hasher,
    clock,
    log: { warn() {} },
    ...overrides,
  };
}

test("两处点号的凭证只走 JWT，不查 Key", async () => {
  let lookups = 0;
  const principal = await resolvePrincipal(
    deps({
      accessTokens: {
        async sign() {
          throw new Error("sign unused");
        },
        async verify(jwt) {
          assert.equal(jwt, "aaa.bbb.ccc");
          return { userId: "user-1", credentialId: "cid-1", kind: "password_session" };
        },
      },
      apiKeys: {
        async findActiveByPrefix() {
          lookups += 1;
          throw new Error("JWT 分支禁止查库");
        },
        async touchLastUsed() {
          throw new Error("JWT 分支禁止写库");
        },
      },
    }),
    "Bearer aaa.bbb.ccc",
  );
  assert.equal(lookups, 0);
  assert.deepEqual(principal, {
    userId: "user-1",
    credentialKind: "password_session",
    credentialId: "cid-1",
  });
});

test("Refresh Token、空 Bearer 和错误方案都是未授权", async () => {
  const verify = async () => {
    throw new Error("oalr 不能当 Access JWT");
  };
  const local = deps({ accessTokens: { sign: async () => "unused", verify } });
  assert.equal(await resolvePrincipal(local, "Bearer oalr_abc"), null);
  assert.equal(await resolvePrincipal(local, "Bearer    "), null);
  assert.equal(await resolvePrincipal(local, undefined), null);
  assert.equal(await resolvePrincipal(local, "Basic abc"), null);
});

test("API Key 命中后更新 last_used_at，更新失败仍放行", async () => {
  const secret = "oalb_Ab12Cd34_abcdefghijABCDEFGHIJ0123456789abc";
  const record: ApiKeyRecord = {
    id: "key-1",
    userId: "user-1",
    name: "agent",
    keyPrefix: "oalb_Ab12Cd34",
    keyHash: hasher.hash(secret),
    revokedAt: null,
    lastUsedAt: null,
    createdAt: clock.now(),
  };
  let touched = 0;
  const principal = await resolvePrincipal(
    deps({
      apiKeys: {
        async findActiveByPrefix(prefix) {
          assert.equal(prefix, "oalb_Ab12Cd34");
          return [record];
        },
        async touchLastUsed(id) {
          touched += 1;
          assert.equal(id, "key-1");
        },
      },
    }),
    `bearer ${secret}`,
  );
  assert.equal(touched, 1);
  assert.equal(principal?.credentialKind, "api_key");
  assert.equal(principal?.credentialId, "key-1");

  let warned = false;
  const still = await resolvePrincipal(
    deps({
      apiKeys: {
        async findActiveByPrefix() {
          return [record];
        },
        async touchLastUsed() {
          throw new Error("db down");
        },
      },
      log: {
        warn(event, fields) {
          warned = true;
          assert.equal(event, "api_key_last_used_failed");
          assert.equal(fields.keyId, "key-1");
          assert.equal(fields.userId, "user-1");
          assert.equal("secret" in fields, false);
        },
      },
    }),
    `Bearer ${secret}`,
  );
  assert.equal(warned, true);
  assert.equal(still?.userId, "user-1");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
npx tsx --test apps/api/test/resolve-principal.test.ts
```

Expected: 退出码非 0，`Cannot find module` 指向 `resolve-principal.js` 或 `deps.js`。

- [ ] **Step 3: 实现适配层**

创建 `apps/api/src/adapters/identity/messages.ts`：

```typescript
export const MESSAGES = {
  invalidBody: "请求不合法",
  invalidEmail: "邮箱格式不正确",
  invalidPassword: "密码长度须为 8 到 128",
  invalidName: "名称不合法",
  invalidId: "标识不合法",
  invalidCredentials: "邮箱或密码错误",
  unauthorized: "未授权",
  forbidden: "当前凭证不能执行该操作",
  emailTaken: "该邮箱已注册",
  notFound: "未找到",
} as const;

export type AuthError = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409;
  code:
    | "validation_error"
    | "invalid_credentials"
    | "unauthorized"
    | "forbidden"
    | "email_taken"
    | "not_found";
  message: string;
};

export type AuthSuccess<T> = { ok: true; status: 200 | 201 | 204; body: T };
export type AuthResult<T> = AuthSuccess<T> | AuthError;

export function unauthorized(): AuthError {
  return { ok: false, status: 401, code: "unauthorized", message: MESSAGES.unauthorized };
}

export function forbidden(): AuthError {
  return { ok: false, status: 403, code: "forbidden", message: MESSAGES.forbidden };
}
```

创建 `apps/api/src/adapters/identity/deps.ts`：

```typescript
import type {
  AccessTokenIssuer,
  ApiKeyRepository,
  AuthLog,
  Clock,
  IdGenerator,
  PasswordHasher,
  RefreshTokenRepository,
  SecretGenerator,
  TokenHasher,
  UserRepository,
} from "../../domain/identity/ports.js";

export type IdentityDeps = {
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  clock: Clock;
  ids: IdGenerator;
  passwords: PasswordHasher;
  tokenHasher: TokenHasher;
  accessTokens: AccessTokenIssuer;
  secrets: SecretGenerator;
  users: UserRepository;
  apiKeys: ApiKeyRepository;
  refreshTokens: RefreshTokenRepository;
  log: AuthLog;
};

/** JWT 校验只拿这些端口。故意不包含 RefreshTokenRepository。 */
export type ResolvePrincipalDeps = {
  accessTokens: AccessTokenIssuer;
  apiKeys: Pick<ApiKeyRepository, "findActiveByPrefix" | "touchLastUsed">;
  tokenHasher: TokenHasher;
  clock: Clock;
  log: AuthLog;
};
```

创建 `apps/api/src/adapters/identity/session.ts`：

```typescript
import type { RefreshTokenRecord } from "../../domain/identity/model.js";
import type { IdentityDeps } from "./deps.js";

export type SessionBody = {
  tokenType: "Bearer";
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: { id: string; email: string };
};

export type IssuedRefresh = { record: RefreshTokenRecord; secret: string };

export function newRefreshRecord(deps: IdentityDeps, userId: string, familyId: string): IssuedRefresh {
  const createdAt = deps.clock.now();
  const secret = deps.secrets.refreshToken();
  return {
    secret,
    record: {
      id: deps.ids.nextId(),
      userId,
      tokenHash: deps.tokenHasher.hash(secret),
      familyId,
      expiresAt: new Date(createdAt.getTime() + deps.refreshTtlSeconds * 1000),
      revokedAt: null,
      replacedBy: null,
      createdAt,
    },
  };
}

export async function signSession(
  deps: IdentityDeps,
  user: { id: string; email: string },
  issued: IssuedRefresh,
): Promise<SessionBody> {
  // cid 预埋、本阶段禁止查库。credentialId 就是新 Refresh Token 行的 id。
  const accessToken = await deps.accessTokens.sign({
    userId: user.id,
    credentialId: issued.record.id,
  });
  return {
    tokenType: "Bearer",
    accessToken,
    accessTokenExpiresIn: deps.accessTtlSeconds,
    refreshToken: issued.secret,
    refreshTokenExpiresAt: issued.record.expiresAt.toISOString(),
    user: { id: user.id, email: user.email },
  };
}

export async function issueNewFamily(
  deps: IdentityDeps,
  user: { id: string; email: string },
): Promise<SessionBody> {
  const issued = newRefreshRecord(deps, user.id, deps.ids.nextId());
  await deps.refreshTokens.insert(issued.record);
  return signSession(deps, user, issued);
}
```

创建 `apps/api/src/adapters/identity/register-user.ts`：

```typescript
import type { IdentityDeps } from "./deps.js";
import { MESSAGES, type AuthResult } from "./messages.js";
import { issueNewFamily, type SessionBody } from "./session.js";

export async function registerUser(
  deps: IdentityDeps,
  input: { email: string; password: string },
): Promise<AuthResult<SessionBody>> {
  const createdAt = deps.clock.now();
  const passwordHash = await deps.passwords.hash(input.password);
  const user = { id: deps.ids.nextId(), email: input.email, passwordHash, createdAt };
  const inserted = await deps.users.insert(user);
  if (inserted === "email_taken") {
    return { ok: false, status: 409, code: "email_taken", message: MESSAGES.emailTaken };
  }
  return { ok: true, status: 201, body: await issueNewFamily(deps, { id: user.id, email: user.email }) };
}
```

创建 `apps/api/src/adapters/identity/login-user.ts`：

```typescript
import type { IdentityDeps } from "./deps.js";
import { MESSAGES, type AuthResult } from "./messages.js";
import { issueNewFamily, type SessionBody } from "./session.js";

export async function loginUser(
  deps: IdentityDeps,
  input: { email: string; password: string },
): Promise<AuthResult<SessionBody>> {
  const user = await deps.users.findByEmail(input.email);
  const encoded = user?.passwordHash ?? deps.passwords.dummyHash();
  const matches = await deps.passwords.verify(input.password, encoded);
  if (!user || !matches) {
    return { ok: false, status: 401, code: "invalid_credentials", message: MESSAGES.invalidCredentials };
  }
  return { ok: true, status: 200, body: await issueNewFamily(deps, { id: user.id, email: user.email }) };
}
```

创建 `apps/api/src/adapters/identity/refresh-session.ts`：

```typescript
import { decideRefresh } from "../../domain/identity/refresh-policy.js";
import type { IdentityDeps } from "./deps.js";
import { unauthorized, type AuthResult } from "./messages.js";
import { newRefreshRecord, signSession, type SessionBody } from "./session.js";

export async function refreshSession(deps: IdentityDeps, refreshToken: string): Promise<AuthResult<SessionBody>> {
  let result: AuthResult<SessionBody> = unauthorized();
  await deps.refreshTokens.transactByHash(deps.tokenHasher.hash(refreshToken), async (row, tx) => {
    const now = deps.clock.now();
    const decision = decideRefresh(row === null ? null : { revokedAt: row.revokedAt, expiresAt: row.expiresAt }, now);
    if (decision.kind === "missing" || decision.kind === "expired" || row === null) {
      result = unauthorized();
      return;
    }
    if (decision.kind === "replay") {
      await tx.revokeFamily(row.familyId, now);
      result = unauthorized();
      return;
    }
    const issued = newRefreshRecord(deps, row.userId, row.familyId);
    const body = await signSession(deps, { id: row.userId, email: row.userEmail }, issued);
    await tx.insert(issued.record);
    await tx.markReplaced(row.id, issued.record.id, now);
    result = { ok: true, status: 200, body };
  });
  return result;
}
```

创建 `apps/api/src/adapters/identity/logout-session.ts`：

```typescript
import type { IdentityDeps } from "./deps.js";

export async function logoutSession(deps: IdentityDeps, refreshToken: string): Promise<void> {
  await deps.refreshTokens.revokeByHash(deps.tokenHasher.hash(refreshToken), deps.clock.now());
}
```

创建 `apps/api/src/adapters/identity/get-me.ts`：

```typescript
import type { Principal } from "../../domain/identity/model.js";
import type { IdentityDeps } from "./deps.js";
import { unauthorized, type AuthResult } from "./messages.js";

export type MeBody = {
  user: { id: string; email: string };
  principal: Principal;
};

export async function getMe(deps: IdentityDeps, principal: Principal): Promise<AuthResult<MeBody>> {
  const user = await deps.users.findById(principal.userId);
  if (!user) return unauthorized();
  return {
    ok: true,
    status: 200,
    body: {
      user: { id: user.id, email: user.email },
      principal: {
        userId: principal.userId,
        credentialKind: principal.credentialKind,
        credentialId: principal.credentialId,
      },
    },
  };
}
```

创建 `apps/api/src/adapters/identity/api-keys.ts`：

```typescript
import type { ApiKeyRecord, Principal } from "../../domain/identity/model.js";
import type { IdentityDeps } from "./deps.js";
import { forbidden, MESSAGES, type AuthResult } from "./messages.js";

export type ApiKeyDto = {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export async function createApiKey(
  deps: IdentityDeps,
  principal: Principal,
  name: string,
): Promise<AuthResult<{ apiKey: ApiKeyDto; secret: string }>> {
  if (principal.credentialKind !== "password_session") return forbidden();
  const generated = deps.secrets.apiKey();
  const record: ApiKeyRecord = {
    id: deps.ids.nextId(),
    userId: principal.userId,
    name,
    keyPrefix: generated.prefix,
    keyHash: deps.tokenHasher.hash(generated.secret),
    revokedAt: null,
    lastUsedAt: null,
    createdAt: deps.clock.now(),
  };
  await deps.apiKeys.insert(record);
  return { ok: true, status: 201, body: { apiKey: toApiKeyDto(record), secret: generated.secret } };
}

export async function listApiKeys(
  deps: IdentityDeps,
  principal: Principal,
): Promise<AuthResult<{ apiKeys: ApiKeyDto[] }>> {
  if (principal.credentialKind !== "password_session") return forbidden();
  const records = await deps.apiKeys.listByUser(principal.userId);
  return { ok: true, status: 200, body: { apiKeys: records.map(toApiKeyDto) } };
}

export async function revokeApiKey(deps: IdentityDeps, principal: Principal, id: string): Promise<AuthResult<null>> {
  if (principal.credentialKind !== "password_session") return forbidden();
  const outcome = await deps.apiKeys.revoke(id, principal.userId, deps.clock.now());
  if (outcome === "missing") {
    return { ok: false, status: 404, code: "not_found", message: MESSAGES.notFound };
  }
  return { ok: true, status: 204, body: null };
}

function toApiKeyDto(record: ApiKeyRecord): ApiKeyDto {
  return {
    id: record.id,
    name: record.name,
    keyPrefix: record.keyPrefix,
    createdAt: record.createdAt.toISOString(),
    lastUsedAt: record.lastUsedAt ? record.lastUsedAt.toISOString() : null,
    revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
  };
}
```

创建 `apps/api/src/adapters/identity/resolve-principal.ts`：

```typescript
import type { Principal } from "../../domain/identity/model.js";
import type { ResolvePrincipalDeps } from "./deps.js";

const API_KEY = /^(oalb_[A-Za-z0-9]{8})_[A-Za-z0-9_-]+$/;

export async function resolvePrincipal(
  deps: ResolvePrincipalDeps,
  authorization: string | undefined,
): Promise<Principal | null> {
  const credential = parseBearer(authorization);
  if (credential === null) return null;
  if (credential.split(".").length - 1 === 2) {
    // cid 预埋、本阶段禁止查库。参数类型里没有刷新令牌仓储。
    const verified = await deps.accessTokens.verify(credential);
    if (!verified) return null;
    return {
      userId: verified.userId,
      credentialKind: "password_session",
      credentialId: verified.credentialId,
    };
  }
  if (credential.startsWith("oalb_")) {
    const matched = API_KEY.exec(credential);
    const prefix = matched?.[1];
    if (!prefix) return null;
    const presented = deps.tokenHasher.hash(credential);
    for (const row of await deps.apiKeys.findActiveByPrefix(prefix)) {
      if (!deps.tokenHasher.equal(presented, row.keyHash)) continue;
      try {
        await deps.apiKeys.touchLastUsed(row.id, deps.clock.now());
      } catch {
        deps.log.warn("api_key_last_used_failed", {
          userId: row.userId,
          keyId: row.id,
          keyPrefix: row.keyPrefix,
        });
      }
      return { userId: row.userId, credentialKind: "api_key", credentialId: row.id };
    }
    return null;
  }
  return null;
}

export function parseBearer(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const trimmed = authorization.trim();
  const separator = trimmed.indexOf(" ");
  if (separator <= 0) return null;
  if (trimmed.slice(0, separator).toLowerCase() !== "bearer") return null;
  const value = trimmed.slice(separator + 1).trim();
  return value.length === 0 ? null : value;
}
```

创建 `apps/api/src/adapters/identity/require-principal.ts`：

```typescript
import type { Principal } from "../../domain/identity/model.js";
import type { IdentityDeps } from "./deps.js";
import { unauthorized, type AuthError } from "./messages.js";
import { resolvePrincipal } from "./resolve-principal.js";

export async function requirePrincipal(
  deps: IdentityDeps,
  authorization: string | undefined,
): Promise<Principal | AuthError> {
  // 只传入校验需要的端口。cid 预埋、本阶段禁止查库。
  const principal = await resolvePrincipal(
    {
      accessTokens: deps.accessTokens,
      apiKeys: deps.apiKeys,
      tokenHasher: deps.tokenHasher,
      clock: deps.clock,
      log: deps.log,
    },
    authorization,
  );
  return principal ?? unauthorized();
}

export function isPrincipal(value: Principal | AuthError): value is Principal {
  return !("ok" in value);
}
```

把 `apps/api/src/adapters/index.ts` 改成：

```typescript
/**
 * 适配层入口。
 *
 * 编排身份用例。不直接写 SQL，也不调用 jose、argon2 或 node:crypto。
 */
export const ADAPTERS_LAYER = "adapters" as const;
export { createApiKey, listApiKeys, revokeApiKey } from "./identity/api-keys.js";
export type { ApiKeyDto } from "./identity/api-keys.js";
export type { IdentityDeps, ResolvePrincipalDeps } from "./identity/deps.js";
export { getMe } from "./identity/get-me.js";
export type { MeBody } from "./identity/get-me.js";
export { loginUser } from "./identity/login-user.js";
export { logoutSession } from "./identity/logout-session.js";
export { MESSAGES } from "./identity/messages.js";
export type { AuthError, AuthResult } from "./identity/messages.js";
export { registerUser } from "./identity/register-user.js";
export { isPrincipal, requirePrincipal } from "./identity/require-principal.js";
export { resolvePrincipal } from "./identity/resolve-principal.js";
export { refreshSession } from "./identity/refresh-session.js";
export type { SessionBody } from "./identity/session.js";
```

适配层源码不得出现 `from "../dao`、`from "../../dao`、`from "../gateways`、`from "../../gateways`、`from "jose"`、`from "argon2"`、`from "node:crypto"`。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
npx tsx --test apps/api/test/resolve-principal.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
node scripts/check-layer-boundaries.mjs
```

Expected: 三者退出码都是 0。边界脚本输出 `分层边界检查通过`。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/adapters apps/api/test/resolve-principal.test.ts
git commit -m "feat: 实现身份用例与 resolvePrincipal"
```

---

### Task 7: 注册、登录与日志脱敏

**Files:**
- Create: `apps/api/src/interfaces/http/validation.ts`
- Create: `apps/api/src/interfaces/http/error-handler.ts`
- Create: `apps/api/src/interfaces/http/auth-logger.ts`
- Create: `apps/api/src/interfaces/http/send-auth-error.ts`
- Create: `apps/api/src/interfaces/http/register-auth.ts`
- Create: `apps/api/src/wire-identity.ts`
- Modify: `apps/api/src/interfaces/index.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/test/health.test.ts`
- Test: `apps/api/test/identity-auth.test.ts`（本任务只放注册、登录、校验和日志用例）

**Interfaces:**
- Consumes: `registerUser`、`loginUser`、`loadAuthConfig`、`AuthConfig`、`createIdentityDeps` 将在本任务产生
- Produces:
  - `buildApp(options?: BuildAppOptions): Promise<FastifyInstance>`
  - `BuildAppOptions = { logger?: boolean | FastifyServerOptions["logger"]; config?: AuthConfig; clock?: Clock; pool?: pg.Pool }`
  - `createIdentityDeps(...)`
  - 传入 `pool` 时 `app.close()` 不调用 `pool.end()`
  - 测试文件里的 `serial`、`registerUserHttp`、`loginUserHttp`、`tokenHash`、`familyOf`、`START`、`PEPPER`、`testConfig`、`clock`、`pool`、`app`

- [ ] **Step 1: 写会失败的 HTTP 测试**

创建 `apps/api/test/identity-auth.test.ts`：

```typescript
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import test from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { applySchema, requireDatabaseUrl, truncateIdentity } from "./apply-schema.js";
import { ManualClock } from "./manual-clock.js";

const databaseUrl = requireDatabaseUrl();
const START = new Date("2030-01-01T00:00:00.000Z");
const PEPPER = "test-pepper-at-least-32-bytes-ok";
const JWT_SECRET = "test-jwt-secret-at-least-32-bytes";
const testConfig = {
  jwtSecret: JWT_SECRET,
  pepper: PEPPER,
  accessTtlSeconds: 120,
  refreshTtlSeconds: 30 * 24 * 60 * 60,
  databaseUrl,
};
const clock = new ManualClock(START);
const pool = new pg.Pool({ connectionString: databaseUrl });
let app: Awaited<ReturnType<typeof buildApp>>;

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

function tokenHash(raw: string): string {
  return createHmac("sha256", PEPPER).update(raw).digest("hex");
}

async function familyOf(refreshToken: string): Promise<string> {
  const result = await pool.query("select family_id from refresh_tokens where token_hash = $1", [tokenHash(refreshToken)]);
  assert.equal(result.rowCount, 1);
  return String(result.rows[0].family_id);
}

async function reset(): Promise<void> {
  clock.set(START);
  await truncateIdentity(pool);
}

function registerUserHttp(email: string, password: string) {
  return app.inject({ method: "POST", url: "/auth/register", payload: { email, password } });
}

function loginUserHttp(email: string, password: string) {
  return app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
}

test.before(async () => {
  await applySchema(pool);
  app = await buildApp({ logger: false, config: testConfig, clock, pool });
});

test.after(async () => {
  await app.close();
  await pool.end();
});

serial("注册返回 201，口令以 argon2id 保存，并发冲突是 409", async () => {
  await reset();
  const created = await registerUserHttp("  User@Example.COM ", "correct-horse");
  assert.equal(created.statusCode, 201);
  const body = created.json();
  assert.equal(body.tokenType, "Bearer");
  assert.equal(typeof body.accessToken, "string");
  assert.equal(body.accessTokenExpiresIn, 120);
  assert.match(body.refreshToken, /^oalr_/);
  assert.equal(body.user.email, "user@example.com");
  assert.equal(JSON.stringify(body).includes("password_hash"), false);
  const stored = await pool.query("select password_hash from users where email = $1", ["user@example.com"]);
  assert.equal(String(stored.rows[0].password_hash).startsWith("$argon2id$"), true);
  assert.equal(String(stored.rows[0].password_hash).includes("correct-horse"), false);
  const tokenRows = await pool.query("select * from refresh_tokens");
  assert.equal(JSON.stringify(tokenRows.rows).includes(String(body.refreshToken)), false);

  const again = await registerUserHttp("user@example.com", "correct-horse");
  assert.equal(again.statusCode, 409);
  assert.deepEqual(again.json(), { error: { code: "email_taken", message: "该邮箱已注册" } });
  const spaced = await registerUserHttp(" USER@example.com ", "another-password");
  assert.equal(spaced.statusCode, 409);

  const [left, right] = await Promise.all([
    registerUserHttp("race@example.com", "12345678"),
    registerUserHttp("race@example.com", "12345678"),
  ]);
  assert.deepEqual([left.statusCode, right.statusCode].sort((a, b) => a - b), [201, 409]);
  const conflict = left.statusCode === 409 ? left : right;
  assert.equal(conflict.json().error.code, "email_taken");
});

serial("登录成功新建 family，失败响应不区分未知邮箱", async () => {
  await reset();
  const registered = await registerUserHttp("user@example.com", "correct-horse");
  const logged = await loginUserHttp(" User@Example.com ", "correct-horse");
  assert.equal(logged.statusCode, 200);
  assert.equal(Object.hasOwn(logged.json(), "family_id"), false);
  assert.equal(logged.json().user.email, "user@example.com");
  assert.notEqual(await familyOf(registered.json().refreshToken), await familyOf(logged.json().refreshToken));

  const wrong = await loginUserHttp("user@example.com", "wrong-password-1");
  const missing = await loginUserHttp("missing@example.com", "wrong-password-1");
  assert.deepEqual(wrong.json(), missing.json());
  assert.deepEqual(wrong.json(), { error: { code: "invalid_credentials", message: "邮箱或密码错误" } });
  assert.equal(JSON.stringify(wrong.json()).includes("password_hash"), false);
});

serial("非法邮箱和短密码返回固定句，邮箱问题优先", async () => {
  await reset();
  const email = await registerUserHttp("not-an-email", "short");
  assert.deepEqual(email.json(), { error: { code: "validation_error", message: "邮箱格式不正确" } });
  assert.equal(email.statusCode, 400);
  const password = await registerUserHttp("ok@example.com", "1234567");
  assert.deepEqual(password.json(), { error: { code: "validation_error", message: "密码长度须为 8 到 128" } });
  const extra = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "ok@example.com", password: "12345678", extra: true },
  });
  assert.deepEqual(extra.json(), { error: { code: "validation_error", message: "请求不合法" } });
});

serial("默认日志路径不含注册、登录、登出的秘密", async () => {
  await reset();
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const local = await buildApp({ logger: { level: "info", stream }, config: testConfig, clock, pool });
  const password = "pw-SENTINEL-7c1e";
  const registered = await local.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "log@example.com", password },
  });
  assert.equal(registered.statusCode, 201);
  const refreshToken = String(registered.json().refreshToken);
  const accessToken = String(registered.json().accessToken);
  await local.inject({ method: "POST", url: "/auth/login", payload: { email: "log@example.com", password } });
  await local.inject({ method: "POST", url: "/auth/logout", payload: { refreshToken } });
  const logs = lines.join("\n");
  assert.equal(logs.includes(password), false);
  assert.equal(logs.includes(refreshToken), false);
  assert.equal(logs.includes(accessToken), false);
  const routeSource = await readFile(new URL("../src/interfaces/http/register-auth.ts", import.meta.url), "utf8");
  const errorSource = await readFile(new URL("../src/interfaces/http/error-handler.ts", import.meta.url), "utf8");
  const loggerSource = await readFile(new URL("../src/interfaces/http/auth-logger.ts", import.meta.url), "utf8");
  assert.equal(/\brequest\.log\s*[.(]/.test(routeSource), false);
  assert.equal(/\breply\.log\s*[.(]/.test(routeSource), false);
  assert.equal(errorSource.includes("request.body"), false);
  for (const path of ["req.body", "body", "req.headers.authorization", "password", "refreshToken", "secret", "accessToken"]) {
    assert.equal(loggerSource.includes(`"${path}"`), true, path);
  }
  await local.close();
});

serial("即使有人记录 body，redact 仍去掉明文", async () => {
  await reset();
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const local = await buildApp({ logger: { level: "info", stream }, config: testConfig, clock, pool });
  local.addHook("preHandler", async (request) => {
    request.log.info({ body: request.body }, "debug-body");
  });
  const password = "pw-SENTINEL-body-9aa1";
  const registered = await local.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "redact@example.com", password },
  });
  assert.equal(registered.statusCode, 201);
  const refreshToken = String(registered.json().refreshToken);
  await local.inject({ method: "POST", url: "/auth/logout", payload: { refreshToken } });
  const logs = lines.join("\n");
  assert.equal(logs.includes(password), false);
  assert.equal(logs.includes(refreshToken), false);
  assert.equal(logs.includes("[Redacted]"), true);
  await local.close();
});
```

本任务还没有 `/auth/logout`。两条日志用例都会打到登出，Step 3 必须把 logout 路由接上。刷新路由留到 Task 8，本任务不要实现 `POST /auth/refresh`。

日志契约：

- 「默认日志路径」不额外 `log.info({ body })`。它证明 register、login、logout 在 Fastify 自己的请求/响应日志里不出现哨兵口令、Refresh Token 和 Access JWT。这条是主断言，不能只靠下一条兜底用例。
- 路由处理函数禁止调用 `request.log` 或 `reply.log`，禁止把 `request.body` 交给 logger。错误处理器只记 URL，不记 `request.body`。
- `auth-logger.ts` 的 `req` 序列化只含 `method` 与去掉 query 的 `url`，不读 body 或 headers。`res` 只含 `statusCode`。无论调用方传入 `true` 还是 logger 选项对象，都必须盖上 `REDACT`，并覆盖 `req` / `res` 序列化，避免调用方的 serializer 把 body 加回来。
- 「即使有人记录 body」只锁 redact：有人主动记录 `{ body }` 时明文仍须变成 `[Redacted]`。它不能代替默认路径那条用例。

- [ ] **Step 2: 启动数据库并确认测试失败**

Run:

```bash
docker compose up -d --wait
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/identity-auth.test.ts
```

Expected: 退出码非 0。注册断言失败，实际状态码是 404。

- [ ] **Step 3: 实现组合根、校验、注册、登录、登出和日志脱敏**

创建 `apps/api/src/interfaces/http/validation.ts`：

```typescript
import { normalizeApiKeyName } from "../../domain/identity/api-key-name.js";
import { normalizeEmail } from "../../domain/identity/email.js";
import { validatePassword } from "../../domain/identity/password.js";
import { MESSAGES } from "../../adapters/identity/messages.js";

export function parseCredentials(body: { email: string; password: string }): { email: string; password: string } | { message: string } {
  const email = normalizeEmail(body.email);
  if (!email) return { message: MESSAGES.invalidEmail };
  if (!validatePassword(body.password)) return { message: MESSAGES.invalidPassword };
  return { email, password: body.password };
}

export function parseApiKeyName(raw: string): string | { message: string } {
  const name = normalizeApiKeyName(raw);
  return name ?? { message: MESSAGES.invalidName };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuid(raw: string): string | { message: string } {
  return UUID_RE.test(raw) ? raw : { message: MESSAGES.invalidId };
}
```

创建 `apps/api/src/interfaces/http/send-auth-error.ts`：

```typescript
import type { FastifyReply } from "fastify";
import type { AuthError } from "../../adapters/identity/messages.js";

export function sendAuthError(reply: FastifyReply, error: AuthError) {
  return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
}

export function sendInvalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: { code: "validation_error", message } });
}
```

创建 `apps/api/src/interfaces/http/auth-logger.ts`：

```typescript
import type { FastifyServerOptions } from "fastify";

const REDACT = {
  paths: ["req.body", "req.headers.authorization", "body", "password", "refreshToken", "secret", "accessToken"],
  censor: "[Redacted]",
};

export function authLoggerOptions(
  logger: boolean | FastifyServerOptions["logger"] | undefined,
): FastifyServerOptions["logger"] {
  if (logger === false) return false;
  const base = logger === true || logger === undefined ? {} : logger;
  return {
    ...base,
    redact: REDACT,
    serializers: {
      ...base.serializers,
      req(request: unknown) {
        const incoming = request as { method?: string; url?: string };
        return { method: incoming.method, url: incoming.url?.split("?")[0] };
      },
      res(reply: unknown) {
        const outgoing = reply as { statusCode?: number };
        return { statusCode: outgoing.statusCode };
      },
    },
  };
}
```

`authLoggerOptions` 必须保持这段实现的强度，不要改弱：调用方传入 logger 选项时仍然使用上面的 `REDACT`，并覆盖 `req` / `res`。`req` 不得输出 body 或 headers。`res` 不得输出响应体。`REDACT.paths` 至少包含 `req.body`、`req.headers.authorization`、`body`、`password`、`refreshToken`、`secret`、`accessToken`，`censor` 为 `[Redacted]`。

创建 `apps/api/src/interfaces/http/error-handler.ts`：

```typescript
import type { FastifyInstance } from "fastify";
import { MESSAGES } from "../../adapters/identity/messages.js";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const validation = typeof error === "object" && error !== null && "validation" in error;
    if (validation) {
      return reply.code(400).send({ error: { code: "validation_error", message: MESSAGES.invalidBody } });
    }
    request.log.error({ url: request.url.split("?")[0] }, "请求失败");
    return reply.code(500).send({ error: { code: "internal_error", message: "服务器错误" } });
  });
}
```

`internal_error` 只用于未预期异常，业务路径不得返回它。错误日志只写 URL，不写 `error` 对象，也不写 `request.body`，避免校验器或请求体把口令夹进日志。

创建 `apps/api/src/interfaces/http/register-auth.ts`：

```typescript
import type { FastifyInstance } from "fastify";
import { loginUser, logoutSession, registerUser, type IdentityDeps } from "../../adapters/index.js";
import { parseCredentials } from "./validation.js";
import { sendAuthError, sendInvalid } from "./send-auth-error.js";

const credentialsBody = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: { email: { type: "string" }, password: { type: "string" } },
};

const refreshBody = {
  type: "object",
  additionalProperties: false,
  required: ["refreshToken"],
  properties: { refreshToken: { type: "string", minLength: 1 } },
};

export function registerAuthRoutes(app: FastifyInstance, deps: IdentityDeps): void {
  // 禁止 request.log / reply.log，禁止把 request.body 交给 logger。
  app.post("/auth/register", { schema: { body: credentialsBody } }, async (request, reply) => {
    const body = request.body as { email: string; password: string };
    const parsed = parseCredentials(body);
    if ("message" in parsed) return sendInvalid(reply, parsed.message);
    const result = await registerUser(deps, parsed);
    if (!result.ok) return sendAuthError(reply, result);
    return reply.code(201).send(result.body);
  });

  app.post("/auth/login", { schema: { body: credentialsBody } }, async (request, reply) => {
    const body = request.body as { email: string; password: string };
    const parsed = parseCredentials(body);
    if ("message" in parsed) return sendInvalid(reply, parsed.message);
    const result = await loginUser(deps, parsed);
    if (!result.ok) return sendAuthError(reply, result);
    return reply.code(200).send(result.body);
  });

  app.post("/auth/logout", { schema: { body: refreshBody } }, async (request, reply) => {
    const body = request.body as { refreshToken: string };
    await logoutSession(deps, body.refreshToken);
    return reply.code(204).send();
  });
}
```

创建 `apps/api/src/wire-identity.ts`：

```typescript
import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import type { IdentityDeps } from "./adapters/identity/deps.js";
import type { AuthLog, Clock } from "./domain/identity/ports.js";
import { createApiKeyRepository, createRefreshTokenRepository, createUserRepository } from "./dao/index.js";
import type { AuthConfig } from "./gateways/auth/config.js";
import {
  createAccessTokenIssuer,
  createIdGenerator,
  createPasswordHasher,
  createSecretGenerator,
  createTokenHasher,
} from "./gateways/index.js";

/**
 * 组合根装配。禁止把本文件移进 adapters、interfaces、domain、dao 或 gateways。
 */
export async function createIdentityDeps(input: {
  config: AuthConfig;
  clock: Clock;
  pool: pg.Pool;
  log: AuthLog;
}): Promise<IdentityDeps> {
  return {
    accessTtlSeconds: input.config.accessTtlSeconds,
    refreshTtlSeconds: input.config.refreshTtlSeconds,
    clock: input.clock,
    ids: createIdGenerator(),
    passwords: await createPasswordHasher(),
    tokenHasher: createTokenHasher(input.config.pepper),
    accessTokens: createAccessTokenIssuer({
      secret: input.config.jwtSecret,
      ttlSeconds: input.config.accessTtlSeconds,
      clock: input.clock,
    }),
    secrets: createSecretGenerator(),
    users: createUserRepository(input.pool),
    apiKeys: createApiKeyRepository(input.pool),
    refreshTokens: createRefreshTokenRepository(input.pool),
    log: input.log,
  };
}

export function authLogFromFastify(logger: FastifyBaseLogger): AuthLog {
  return {
    warn(event, fields) {
      logger.warn({ event, userId: fields.userId, keyId: fields.keyId, keyPrefix: fields.keyPrefix }, event);
    },
  };
}
```

把 `apps/api/src/interfaces/index.ts` 改成：

```typescript
export { registerAuthRoutes } from "./http/register-auth.js";
export { registerErrorHandler } from "./http/error-handler.js";
export { registerHealthRoute } from "./http/register-health.js";
```

把 `apps/api/src/app.ts` 替换为：

```typescript
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import pg from "pg";
import { registerAuthRoutes, registerErrorHandler, registerHealthRoute } from "./interfaces/index.js";
import type { Clock } from "./domain/identity/ports.js";
import { loadAuthConfig, type AuthConfig } from "./gateways/auth/config.js";
import { SystemClock } from "./gateways/auth/system-clock.js";
import { authLoggerOptions } from "./interfaces/http/auth-logger.js";
import { authLogFromFastify, createIdentityDeps } from "./wire-identity.js";

export type BuildAppOptions = {
  logger?: boolean | FastifyServerOptions["logger"];
  config?: AuthConfig;
  clock?: Clock;
  pool?: pg.Pool;
};

/**
 * 组合根。业务规则不写在这里。
 * 传入 pool 时，close 不结束该 pool。
 * 不在这里发 SQL；GET /health 不访问数据库。
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadAuthConfig(process.env);
  const clock = options.clock ?? new SystemClock();
  const pool = options.pool ?? new pg.Pool({ connectionString: config.databaseUrl });
  const ownsPool = options.pool === undefined;
  const app = Fastify({ logger: authLoggerOptions(options.logger) });
  const deps = await createIdentityDeps({ config, clock, pool, log: authLogFromFastify(app.log) });
  registerErrorHandler(app);
  registerHealthRoute(app);
  registerAuthRoutes(app, deps);
  app.addHook("onClose", async () => {
    if (ownsPool) await pool.end();
  });
  return app;
}
```

把 `apps/api/src/index.ts` 替换为：

```typescript
import { buildApp } from "./app.js";
import { loadAuthConfig } from "./gateways/auth/config.js";

const config = loadAuthConfig(process.env);
const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "0.0.0.0";

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`PORT 无效：${process.env.PORT}`);
}

const app = await buildApp({ config });

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error({ url: "startup" }, error instanceof Error ? error.message : "启动失败");
  process.exit(1);
}
```

把 `apps/api/test/health.test.ts` 改成：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";

test("GET /health 返回 ok", async () => {
  const app = await buildApp({
    logger: false,
    config: {
      jwtSecret: "x".repeat(32),
      pepper: "y".repeat(32),
      accessTtlSeconds: 900,
      refreshTtlSeconds: 2_592_000,
      databaseUrl: "postgres://photo:unused@127.0.0.1:1/none",
    },
  });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  await app.close();
});
```

健康检查使用一个不会被查询的假 URL。`buildApp` 不得在启动时 `pool.query`。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/identity-auth.test.ts apps/api/test/health.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
node scripts/check-layer-boundaries.mjs
```

Expected: 三者退出码都是 0。默认日志用例在不注入 `log.info({ body })` 的情况下，register、login、logout 的日志不含哨兵口令、Refresh Token 和 Access JWT。redact 兜底用例仍能看到 `[Redacted]`，且不含另一组哨兵。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test/identity-auth.test.ts apps/api/test/health.test.ts
git commit -m "feat: 提供注册登录路由并禁止记录原始请求体"
```

---

### Task 8: 刷新、登出连坐、并发双刷新与过期不连坐

**Files:**
- Modify: `apps/api/src/interfaces/http/register-auth.ts`
- Modify: `apps/api/test/identity-auth.test.ts`

**Interfaces:**
- Consumes: `refreshSession(deps, refreshToken)`、`logoutSession`、Task 7 的 `app`、`pool`、`clock`、`serial`、`reset`、`registerUserHttp`、`tokenHash`、`testConfig`
- Produces: `POST /auth/refresh`。成功 200，正文与登录相同。失败 401 `unauthorized` / 「未授权」。过期不写库。已撤销则撤销整个 family。并发第二次刷新连坐时，胜者刚签发的新 Refresh Token 也必须失效。

- [ ] **Step 1: 把失败测试追加到 identity-auth.test.ts**

在文件末尾追加：

```typescript
function refreshHttp(refreshToken: string) {
  return app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
}

function logoutHttp(refreshToken: string) {
  return app.inject({ method: "POST", url: "/auth/logout", payload: { refreshToken } });
}

serial("刷新轮换旧令牌，重放会清空该 family 的未撤销行", async () => {
  await reset();
  const registered = await registerUserHttp("refresh@example.com", "correct-horse");
  const original = String(registered.json().refreshToken);
  const familyId = await familyOf(original);
  const refreshed = await refreshHttp(original);
  assert.equal(refreshed.statusCode, 200);
  assert.notEqual(refreshed.json().refreshToken, original);
  assert.equal(await familyOf(String(refreshed.json().refreshToken)), familyId);
  const replay = await refreshHttp(original);
  assert.equal(replay.statusCode, 401);
  assert.deepEqual(replay.json(), { error: { code: "unauthorized", message: "未授权" } });
  const left = await pool.query(
    "select count(*)::int as n from refresh_tokens where family_id = $1 and revoked_at is null",
    [familyId],
  );
  assert.equal(left.rows[0].n, 0);
});

serial("登出只影响一个 family，未知令牌也是 204", async () => {
  await reset();
  await registerUserHttp("families@example.com", "correct-horse");
  const first = await loginUserHttp("families@example.com", "correct-horse");
  const second = await loginUserHttp("families@example.com", "correct-horse");
  const logout = await logoutHttp(String(first.json().refreshToken));
  assert.equal(logout.statusCode, 204);
  assert.equal(logout.body, "");
  assert.equal((await refreshHttp(String(first.json().refreshToken))).statusCode, 401);
  assert.equal((await refreshHttp(String(second.json().refreshToken))).statusCode, 200);
  const missing = await logoutHttp("oalr_missing");
  assert.equal(missing.statusCode, 204);
});

serial("并发双刷新把整个 family 撤销", async () => {
  await reset();
  const registered = await registerUserHttp("race-refresh@example.com", "correct-horse");
  const original = String(registered.json().refreshToken);
  const familyId = await familyOf(original);
  const [left, right] = await Promise.all([refreshHttp(original), refreshHttp(original)]);
  assert.deepEqual([left.statusCode, right.statusCode].sort((a, b) => a - b), [200, 401]);
  const failed = left.statusCode === 401 ? left : right;
  assert.deepEqual(failed.json(), { error: { code: "unauthorized", message: "未授权" } });
  const winner = left.statusCode === 200 ? left : right;
  assert.equal((await refreshHttp(String(winner.json().refreshToken))).statusCode, 401);
  const leftRows = await pool.query(
    "select count(*)::int as n from refresh_tokens where family_id = $1 and revoked_at is null",
    [familyId],
  );
  assert.equal(leftRows.rows[0].n, 0);
});

serial("过期刷新返回 401，且不连坐 family", async () => {
  await reset();
  const registered = await registerUserHttp("expired@example.com", "correct-horse");
  const original = String(registered.json().refreshToken);
  const current = await pool.query(
    "select id, user_id, family_id from refresh_tokens where token_hash = $1",
    [tokenHash(original)],
  );
  const row = current.rows[0];
  const siblingId = "00000000-0000-4000-8000-00000000e001";
  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [siblingId, row.user_id, "ee".repeat(32), row.family_id, new Date("2099-01-01T00:00:00.000Z"), START],
  );
  clock.set(new Date(String(registered.json().refreshTokenExpiresAt)));
  const expired = await refreshHttp(original);
  assert.equal(expired.statusCode, 401);
  assert.deepEqual(expired.json(), { error: { code: "unauthorized", message: "未授权" } });
  const states = await pool.query(
    "select id, revoked_at from refresh_tokens where family_id = $1 order by id",
    [row.family_id],
  );
  for (const item of states.rows) {
    assert.equal(item.revoked_at, null);
  }
});

serial("找不到的 Refresh Token 返回 401 且不写库", async () => {
  await reset();
  const before = await pool.query("select count(*)::int as n from refresh_tokens");
  const response = await refreshHttp("oalr_not-a-real-token");
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { error: { code: "unauthorized", message: "未授权" } });
  const after = await pool.query("select count(*)::int as n from refresh_tokens");
  assert.equal(after.rows[0].n, before.rows[0].n);
});

serial("空的 refreshToken 是请求不合法", async () => {
  await reset();
  const response = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: "" } });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: { code: "validation_error", message: "请求不合法" } });
});
```

`familyOf`、`loginUserHttp`、`reset`、`tokenHash` 已在 Task 7 的测试文件里。本步骤只追加，不改它们的名字。

并发双刷新时，胜出的 200 会签发新 Refresh Token，但失败的那一次按重放把整个 family 尚未撤销的行全部标上 `revoked_at`，其中包含胜者刚插入的新行，所以胜者手里的新令牌必须立刻再刷新也得到 401。这是合同行为，实现时不要放宽断言，也不要改成「胜者的新令牌仍然有效」。

- [ ] **Step 2: 运行测试，确认新增用例失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/identity-auth.test.ts
```

Expected: 退出码非 0。刷新用例的实际状态码是 404。

- [ ] **Step 3: 接上刷新路由**

在 `register-auth.ts` 增加 `refreshSession` 的 import，并在 `registerAuthRoutes` 里、logout 路由之前加入：

```typescript
  app.post("/auth/refresh", { schema: { body: refreshBody } }, async (request, reply) => {
    const body = request.body as { refreshToken: string };
    const result = await refreshSession(deps, body.refreshToken);
    if (!result.ok) return sendAuthError(reply, result);
    return reply.code(200).send(result.body);
  });
```

文件顶部的 import 改为：

```typescript
import { loginUser, logoutSession, refreshSession, registerUser, type IdentityDeps } from "../../adapters/index.js";
```

不要在刷新路由里读 `Authorization`。过期分支禁止调用 `revokeFamily`。这个分支已经在 `refreshSession` 里：`expired` 与 `missing` 直接返回，不写库。并发连坐必须作废胜者的新 Refresh Token。若测试失败，改事务或判定顺序，不要放宽断言。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/identity-auth.test.ts
```

Expected: 退出码 0。并发用例恰好一个 200 和一个 401；胜者新令牌再次刷新仍是 401；该 family 没有 `revoked_at is null` 的行。过期用例里呈现的那一行和兄弟行的 `revoked_at` 都仍是 null。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/interfaces/http/register-auth.ts apps/api/test/identity-auth.test.ts
git commit -m "feat: 实现 Refresh Token 轮换、登出与连坐测试"
```

---

### Task 9: Bearer、GET /me，以及未过期 Access JWT 不因登出失效

**Files:**
- Create: `apps/api/src/interfaces/http/register-me.ts`
- Modify: `apps/api/src/interfaces/index.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/test/identity-auth.test.ts`

**Interfaces:**
- Consumes: `requirePrincipal`、`isPrincipal`、`getMe`、`buildApp`
- Produces: `GET /me`。Bearer 缺失、不是 Bearer、值为空、Refresh Token、坏签名、过期 JWT 都是 401 `unauthorized` / 「未授权」。用户行不存在也是这个 401。

- [ ] **Step 1: 追加失败测试**

`readFile` 已在 Task 7 的测试文件顶部引入。这里不要再写一次 import。

然后在文件末尾追加：

```typescript
function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

serial("GET /me 返回必填 credentialId，登出后 Access JWT 仍然有效", async () => {
  await reset();
  const registered = await registerUserHttp("me@example.com", "correct-horse");
  const accessToken = String(registered.json().accessToken);
  const refreshToken = String(registered.json().refreshToken);
  const refreshRow = await pool.query("select id from refresh_tokens where token_hash = $1", [tokenHash(refreshToken)]);
  const me = await app.inject({ method: "GET", url: "/me", headers: bearer(accessToken) });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().principal.credentialKind, "password_session");
  assert.equal(me.json().principal.userId, me.json().user.id);
  assert.equal(me.json().principal.credentialId, refreshRow.rows[0].id);

  assert.equal((await logoutHttp(refreshToken)).statusCode, 204);
  const still = await app.inject({ method: "GET", url: "/me", headers: bearer(accessToken) });
  assert.equal(still.statusCode, 200);
  assert.equal(still.json().principal.credentialId, refreshRow.rows[0].id);
});

serial("时钟超过 JWT_TTL 加 5 秒，或签名被篡改，都是同一个 401", async () => {
  await reset();
  const registered = await registerUserHttp("ttl@example.com", "correct-horse");
  const accessToken = String(registered.json().accessToken);
  clock.advance(124_000);
  const insideSkew = await app.inject({ method: "GET", url: "/me", headers: bearer(accessToken) });
  assert.equal(insideSkew.statusCode, 200);
  clock.advance(1_000);
  const expired = await app.inject({ method: "GET", url: "/me", headers: bearer(accessToken) });
  assert.equal(expired.statusCode, 401);
  assert.deepEqual(expired.json(), { error: { code: "unauthorized", message: "未授权" } });

  clock.set(START);
  const tampered = `${accessToken.slice(0, -1)}${accessToken.endsWith("a") ? "b" : "a"}`;
  const broken = await app.inject({ method: "GET", url: "/me", headers: bearer(tampered) });
  assert.deepEqual(broken.json(), expired.json());
});

serial("缺少 Bearer、方案错误、空值和 Refresh Token 访问 /me 都是 401", async () => {
  await reset();
  const registered = await registerUserHttp("bearer@example.com", "correct-horse");
  const refreshToken = String(registered.json().refreshToken);
  const cases = [
    {},
    { authorization: "Basic abc" },
    { authorization: "Bearer" },
    { authorization: "Bearer    " },
    { authorization: `Bearer ${refreshToken}` },
  ];
  for (const headers of cases) {
    const response = await app.inject({ method: "GET", url: "/me", headers });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: { code: "unauthorized", message: "未授权" } });
  }
});

serial("用户已被删除时，未过期 Access JWT 返回 401", async () => {
  await reset();
  const registered = await registerUserHttp("gone@example.com", "correct-horse");
  await pool.query("delete from users where email = $1", ["gone@example.com"]);
  const response = await app.inject({
    method: "GET",
    url: "/me",
    headers: bearer(String(registered.json().accessToken)),
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "unauthorized");
});

serial("校验 Access JWT 的源码不查询刷新令牌表", async () => {
  const issuer = await readFile(new URL("../src/gateways/auth/access-token-issuer.ts", import.meta.url), "utf8");
  const resolver = await readFile(new URL("../src/adapters/identity/resolve-principal.ts", import.meta.url), "utf8");
  assert.equal(issuer.includes("refresh_tokens"), false);
  assert.equal(resolver.includes("refresh_tokens"), false);
  assert.equal(issuer.includes("预埋、本阶段禁止查库"), true);
  assert.equal(resolver.includes("预埋、本阶段禁止查库"), true);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/identity-auth.test.ts
```

Expected: 退出码非 0。`GET /me` 实际是 404。源码断言此时应已通过，因为它锁的是 Task 4 和 Task 6 的注释；不要为了让它通过而删掉 `cid`。

- [ ] **Step 3: 注册 GET /me**

创建 `apps/api/src/interfaces/http/register-me.ts`：

```typescript
import type { FastifyInstance } from "fastify";
import { getMe, isPrincipal, requirePrincipal, type IdentityDeps } from "../../adapters/index.js";
import { sendAuthError } from "./send-auth-error.js";

export function registerMeRoute(app: FastifyInstance, deps: IdentityDeps): void {
  app.get("/me", async (request, reply) => {
    const header = Array.isArray(request.headers.authorization) ? undefined : request.headers.authorization;
    const principal = await requirePrincipal(deps, header);
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    const result = await getMe(deps, principal);
    if (!result.ok) return sendAuthError(reply, result);
    return reply.code(200).send(result.body);
  });
}
```

`apps/api/src/interfaces/index.ts` 增加：

```typescript
export { registerMeRoute } from "./http/register-me.js";
```

`buildApp` 在 `registerAuthRoutes(app, deps);` 之后调用 `registerMeRoute(app, deps);`。`GET /me` 不得调用 `refreshTokens`。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/identity-auth.test.ts
```

Expected: 退出码 0。登出后的 Access JWT 仍然 200。时钟前进 124 秒仍是 200，再前进 1 秒变成 401。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/interfaces/http/register-me.ts apps/api/src/interfaces/index.ts apps/api/src/app.ts apps/api/test/identity-auth.test.ts
git commit -m "feat: 实现 Bearer 解析与 GET /me"
```

---

### Task 10: API Key 创建、列表与吊销

**Files:**
- Create: `apps/api/src/interfaces/http/register-api-keys.ts`
- Modify: `apps/api/src/interfaces/index.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/test/identity-auth.test.ts`

**Interfaces:**
- Consumes: `createApiKey`、`listApiKeys`、`revokeApiKey`、`parseApiKeyName`、`parseUuid`、`requirePrincipal`
- Produces:
  - `POST /api-keys` → 201，正文含 `apiKey` 与一次性 `secret`
  - `GET /api-keys` → 200 `{ apiKeys }`，含已吊销项，按 `createdAt` 升序，无 `secret` 与 `key_hash`
  - `DELETE /api-keys/:id` → 属于当前用户时 204，可重复；不属于或不存在时 404 `not_found`；`:id` 不是 UUID 时 400 「标识不合法」
  - `api_key` 调用这三条都是 403 `forbidden` / 「当前凭证不能执行该操作」

- [ ] **Step 1: 追加失败测试**

```typescript
function authJson(token: string, method: "POST" | "GET" | "DELETE", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload }),
  });
}

serial("密码会话可以创建 Key，列表不再返回明文，库内只有 HMAC", async () => {
  await reset();
  const registered = await registerUserHttp("keys@example.com", "correct-horse");
  const accessToken = String(registered.json().accessToken);
  const created = await authJson(accessToken, "POST", "/api-keys", { name: "  我的 Agent  " });
  assert.equal(created.statusCode, 201);
  const secret = String(created.json().secret);
  const apiKey = created.json().apiKey;
  assert.match(secret, /^oalb_[A-Za-z0-9]{8}_[A-Za-z0-9_-]+$/);
  assert.equal(secret.startsWith(`${apiKey.keyPrefix}_`), true);
  assert.equal(apiKey.name, "我的 Agent");
  assert.equal(apiKey.lastUsedAt, null);
  assert.equal(apiKey.revokedAt, null);

  clock.advance(1000);
  const second = await authJson(accessToken, "POST", "/api-keys", { name: "second" });
  assert.equal(second.statusCode, 201);
  const listed = await authJson(accessToken, "GET", "/api-keys");
  assert.equal(listed.statusCode, 200);
  const bodyText = JSON.stringify(listed.json());
  assert.equal(bodyText.includes(secret), false);
  assert.equal(bodyText.includes("key_hash"), false);
  assert.deepEqual(
    listed.json().apiKeys.map((item: { name: string }) => item.name),
    ["我的 Agent", "second"],
  );

  const stored = await pool.query("select key_prefix, key_hash from api_keys where id = $1", [apiKey.id]);
  assert.equal(stored.rows[0].key_prefix, apiKey.keyPrefix);
  assert.equal(stored.rows[0].key_hash, tokenHash(secret));
  assert.equal(JSON.stringify(stored.rows[0]).includes(secret), false);

  const asKey = await app.inject({ method: "GET", url: "/me", headers: bearer(secret) });
  assert.equal(asKey.statusCode, 200);
  assert.equal(asKey.json().principal.userId, registered.json().user.id);
  assert.equal(asKey.json().principal.credentialKind, "api_key");
  assert.equal(asKey.json().principal.credentialId, apiKey.id);
  const used = await pool.query("select last_used_at from api_keys where id = $1", [apiKey.id]);
  assert.notEqual(used.rows[0].last_used_at, null);
});

serial("吊销后 Key 不能再访问，重复删除仍是 204，管理接口拒绝 API Key", async () => {
  await reset();
  const registered = await registerUserHttp("revoke@example.com", "correct-horse");
  const accessToken = String(registered.json().accessToken);
  const created = await authJson(accessToken, "POST", "/api-keys", { name: "agent" });
  const secret = String(created.json().secret);
  const id = String(created.json().apiKey.id);

  for (const [method, url] of [
    ["POST", "/api-keys"],
    ["GET", "/api-keys"],
    ["DELETE", `/api-keys/${id}`],
  ] as const) {
    const rejected = await authJson(secret, method, url, method === "POST" ? { name: "nope" } : undefined);
    assert.equal(rejected.statusCode, 403);
    assert.deepEqual(rejected.json(), { error: { code: "forbidden", message: "当前凭证不能执行该操作" } });
  }

  const removed = await authJson(accessToken, "DELETE", `/api-keys/${id}`);
  assert.equal(removed.statusCode, 204);
  assert.equal(removed.body, "");
  assert.equal((await app.inject({ method: "GET", url: "/me", headers: bearer(secret) })).statusCode, 401);
  assert.equal((await authJson(accessToken, "DELETE", `/api-keys/${id}`)).statusCode, 204);
  const listed = await authJson(accessToken, "GET", "/api-keys");
  assert.equal(listed.json().apiKeys[0].revokedAt === null, false);
  assert.equal(JSON.stringify(listed.json()).includes(secret), false);

  const badId = await authJson(accessToken, "DELETE", "/api-keys/not-a-uuid");
  assert.deepEqual(badId.json(), { error: { code: "validation_error", message: "标识不合法" } });
  const missing = await authJson(accessToken, "DELETE", "/api-keys/00000000-0000-4000-8000-000000000099");
  assert.deepEqual(missing.json(), { error: { code: "not_found", message: "未找到" } });
});

serial("空名称返回名称不合法", async () => {
  await reset();
  const registered = await registerUserHttp("name@example.com", "correct-horse");
  const response = await authJson(String(registered.json().accessToken), "POST", "/api-keys", { name: "   " });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: { code: "validation_error", message: "名称不合法" } });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/identity-auth.test.ts
```

Expected: 退出码非 0。`POST /api-keys` 实际是 404。

- [ ] **Step 3: 注册 API Key 路由**

创建 `apps/api/src/interfaces/http/register-api-keys.ts`：

```typescript
import type { FastifyInstance } from "fastify";
import {
  createApiKey,
  isPrincipal,
  listApiKeys,
  requirePrincipal,
  revokeApiKey,
  type IdentityDeps,
} from "../../adapters/index.js";
import { sendAuthError, sendInvalid } from "./send-auth-error.js";
import { parseApiKeyName, parseUuid } from "./validation.js";

const nameBody = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string" } },
};

export function registerApiKeyRoutes(app: FastifyInstance, deps: IdentityDeps): void {
  async function principalOf(authorization: string | string[] | undefined) {
    const header = Array.isArray(authorization) ? undefined : authorization;
    return requirePrincipal(deps, header);
  }

  app.post("/api-keys", { schema: { body: nameBody } }, async (request, reply) => {
    const principal = await principalOf(request.headers.authorization);
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    const name = parseApiKeyName((request.body as { name: string }).name);
    if (typeof name !== "string") return sendInvalid(reply, name.message);
    const result = await createApiKey(deps, principal, name);
    if (!result.ok) return sendAuthError(reply, result);
    return reply.code(201).send(result.body);
  });

  app.get("/api-keys", async (request, reply) => {
    const principal = await principalOf(request.headers.authorization);
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    const result = await listApiKeys(deps, principal);
    if (!result.ok) return sendAuthError(reply, result);
    return reply.code(200).send(result.body);
  });

  app.delete("/api-keys/:id", async (request, reply) => {
    const principal = await principalOf(request.headers.authorization);
    if (!isPrincipal(principal)) return sendAuthError(reply, principal);
    const id = parseUuid((request.params as { id: string }).id);
    if (typeof id !== "string") return sendInvalid(reply, id.message);
    const result = await revokeApiKey(deps, principal, id);
    if (!result.ok) return sendAuthError(reply, result);
    return reply.code(204).send();
  });
}
```

从 `interfaces/index.ts` 导出 `registerApiKeyRoutes`。在 `buildApp` 里于 `registerMeRoute` 之后调用它。

- [ ] **Step 4: 运行测试，确认通过**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npx tsx --test apps/api/test/identity-auth.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

Expected: 两者退出码都是 0。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/interfaces apps/api/src/app.ts apps/api/test/identity-auth.test.ts
git commit -m "feat: 实现 API Key 的创建、列表与吊销"
```

---

### Task 11: 领域层禁令覆盖 argon2 与 jose

**Files:**
- Modify: `scripts/check-layer-boundaries.mjs`

**Interfaces:**
- Consumes: 现有 `domainPackages`
- Produces: 领域文件 import `argon2` 或 `jose` 时，`node scripts/check-layer-boundaries.mjs` 退出码为 1

- [ ] **Step 1: 把两个包放进禁令集合**

`scripts/check-layer-boundaries.mjs` 的 `domainPackages` 改为：

```javascript
const domainPackages = new Set([
  "fastify",
  "pg",
  "postgres",
  "mysql",
  "mysql2",
  "minio",
  "aws-sdk",
  "undici",
  "http",
  "https",
  "net",
  "argon2",
  "jose",
]);
```

只加最后两项，不要改各层的相对 import 规则。

- [ ] **Step 2: 运行完整测试**

Run:

```bash
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
npm test
npx tsc -p apps/api/tsconfig.json --noEmit
npm run build -w apps/api
```

Expected: `npm test` 先打印 `分层边界检查通过`，然后 API 测试 `# fail 0`，退出码 0。`tsc` 与 `build` 退出码 0。`GET /health` 仍然不需要真实数据库。

- [ ] **Step 3: Commit**

```bash
git add scripts/check-layer-boundaries.mjs
git commit -m "test: 把 argon2 与 jose 纳入领域层禁令"
```

---

### Task 12: 验收通过后把阶段标成 done

**Files:**
- Modify: `specs/phases/01-identity-auth.md`
- Modify: `specs/SPEC.md`

**Interfaces:**
- Consumes: Task 11 的 `npm test`、`tsc`、`build` 都已通过
- Produces: 阶段规格状态 `done`，七条验收框勾上；`specs/SPEC.md` 索引表阶段 1 为 `done`

这个任务只有在 Task 11 的三条命令都成功之后才能做。测试失败时不要改状态。

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

`specs/phases/01-identity-auth.md` 的状态行改为：

```markdown
**状态：** done
```

验收列表改为：

```markdown
- [x] 新用户可注册并登录，获得 Access JWT 与 Refresh Token
- [x] 重复邮箱注册返回 409；错误密码与未知邮箱的登录失败均为 401，且响应不区分二者，也不返回密码哈希
- [x] Refresh Token 可换发新的 Access JWT 与新 Refresh Token；被轮换或登出的旧 Refresh Token 再使用会被拒绝
- [x] 已登录用户可创建 Key，响应中的明文不能从后续列表接口再次取得
- [x] 数据库中不存在 Key 明文或 Refresh Token 明文
- [x] 有效 Key 能解析为所属用户；已吊销 Key 被拒绝
- [x] 领域层边界检查仍然通过
```

不要把设计文件的「状态：已定稿（待实现）」改成 done。

- [ ] **Step 3: 更新索引表**

`specs/SPEC.md` 里阶段 1 那一行改为：

```markdown
| 1 | [phases/01-identity-auth.md](phases/01-identity-auth.md) | done | 用户、Access JWT + Refresh、API Key（仅 HTTP API） |
```

不要勾选「任何阶段的完成定义」那一组模板复选框，那不是阶段状态。

- [ ] **Step 4: Commit**

```bash
git add specs/phases/01-identity-auth.md specs/SPEC.md
git commit -m "docs: 将 Phase 1 状态标记为 done"
```

---

## 自检（计划作者已完成，实现时不要重做这一节）

实现代理跳过本节。下列是写计划时对照设计合同的覆盖记录。

| 设计 | 落点 | 结论 |
|------|------|------|
| §1 只交付 HTTP API 与测试，不改 `apps/web`，状态由实现提交更新 | Global Constraints；Task 12 | 已覆盖 |
| §2.1 `credentialId` 必填 | Task 1 两处文档；`Principal`；Task 9 断言等于 refresh 行 id | 已覆盖 |
| §2.2 HS256、claims、15m、5 秒偏差、不入库 | Task 2 默认值；Task 4 issuer，并断言 `iss=openalbum`、`aud=openalbum-api` 以及错误 iss/aud 被拒绝；Task 9 时钟与篡改 | 已覆盖 |
| §2.2 `cid` 保留但本阶段不查库 | issuer 与 `resolvePrincipal` 注释「预埋、本阶段禁止查库」；Task 9 源码断言与登出后 JWT 仍有效 | 已覆盖 |
| §2.3 四态、轮换、登出不连坐 | `decideRefresh`；DAO `FOR UPDATE`；Task 8 | 已覆盖 |
| 审查：并发双刷新连坐 | Task 8：连坐作废胜者刚签发的新 Refresh Token，禁止放宽断言 | 已覆盖 |
| 审查：过期 401 且不连坐 | Task 8 兄弟行 `revoked_at` 仍为 null | 已覆盖 |
| §2.4 API Key 形态、一次性明文、软删除、`last_used_at` 失败仍放行 | Task 4 生成器；Task 6 单测；Task 10 HTTP | 已覆盖 |
| §2.5 Bearer 顺序 | `resolvePrincipal`；Task 6 与 Task 9 | 已覆盖 |
| §3 全部路由、固定文案、409 并发注册 | Task 7–10 | 已覆盖 |
| §4 分层与端口 | 文件地图；`wire-identity.ts` 留在 `src/`；Task 6 与 Task 11 | 已覆盖 |
| §5 `refresh_tokens` DDL | Task 2，SQL 与设计一致 | 已覆盖 |
| §6 argon2id 参数、HMAC、哑哈希、日志不出现明文 | Task 4；Task 7 默认日志路径与 redact 兜底 | 已覆盖 |
| 审查：鉴权路由不记录原始请求体 | Task 7：默认日志不含哨兵；路由禁止 `request.log` 与 `request.body`；`auth-logger` 的 serializer 与 `REDACT` 被用例锁住 | 已覆盖 |
| 审查：没有限流不要公开注册/登录 | Global Constraints；`deploy/README.md`；`deploy/nginx.example.conf` 只有注释 | 已覆盖 |
| 审查：`API_KEY_PEPPER` 双重用途 | 保留变量名，`env.example` 与 `token-hasher.ts` 注释；不引入 `TOKEN_PEPPER` | 已覆盖 |
| §7 第 1–16 条 | Task 7–11 的 `identity-auth.test.ts` 与边界脚本 | 已覆盖 |
| §8 明确不做 | Global Constraints，无对应实现任务 | 已覆盖 |
| §9 已确认决策 | 与上文相同 | 已覆盖 |

占位符扫描：计划正文没有 TBD、TODO、待定，也没有「类似 Task N」这种未展开的实现步骤。`credentialId`、`decideRefresh`、`ResolvePrincipalDeps`、`refreshSession`、`buildApp` 在前后任务里的名字一致。

## 执行交接

计划保存在 `docs/superpowers/plans/2026-11-03-openalbum-phase1-identity-auth.md`。实现时二选一：

1. **Subagent-Driven（推荐）**：每个任务一个新的子代理，任务之间做审查。子代理使用 Composer 2.5，不用 fast 模式。所需技能是 `superpowers:subagent-driven-development`。
2. **Inline Execution**：在同一会话里按 `superpowers:executing-plans` 批量执行，并在检查点停下来审查。

写这份计划的提交不实现鉴权代码。
