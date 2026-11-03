# Phase 1 — 身份与鉴权

**状态：** planned  
**依赖：** Phase 0  
**设计：** [`docs/superpowers/specs/2026-11-03-openalbum-phase1-identity-auth-design.md`](../../docs/superpowers/specs/2026-11-03-openalbum-phase1-identity-auth-design.md)

## 目标

人类可以用邮箱和密码注册、登录，并拿到短时 Access JWT 与可轮换的 Refresh Token。用户可以创建、命名、吊销 API Key。Agent 使用 `Authorization: Bearer <apiKey>`，与该用户的密码会话落在同一 `userId` 上。

本阶段只交付 HTTP API 与自动化测试。网页和小程序界面留到 Phase 6。鉴权模型按多端 Bearer 设计，不绑定某一种客户端。

## 范围内

- 用户注册与登录；密码只存哈希
- Access JWT 签发与校验；有效期来自 `JWT_TTL`；不入库
- Refresh Token：不透明串，只存哈希；有效期来自 `REFRESH_TTL`；可吊销；刷新时轮换
- API Key：创建时明文只返回一次；库内保存前缀与哈希；记录末次使用时间；支持吊销
- 适配层把 Access JWT 或 API Key 解析为领域主体（`Authorization: Bearer`；先 JWT，再 API Key 前缀）
- 身份相关表与 `deploy/db/schema.sql` 对齐（`users`、`api_keys`、`refresh_tokens`）
- 覆盖注册、登录、刷新、登出、Key 创建、吊销后拒绝、错误口令的自动化测试

## 范围外

- 网页、小程序或其他客户端 UI
- 照片、对象存储、流水线、检索、共享册
- 相册与其它资源的 ACL（本阶段只回答「是谁」）
- 第三方登录、邮箱验证、找回密码
- 限流阈值与实现
- 角色系统之外的管理员后台（本阶段只有资源主人自己）

## 领域触点

`domain/identity`：用户、口令凭证、Refresh Token、API Key 实体或值对象；校验、轮换与吊销规则；用户、Refresh Token 与 Key 的仓储端口。主体是 `userId` + `credentialKind`（`password_session` | `api_key`）+ 必填 `credentialId`（密码会话为签发该 Access JWT 的 Refresh Token 行 id，API Key 为 `api_keys.id`；两种成功凭证都必须带上它），不含相册权限。

DAO 实现仓储。网关提供时钟、ID、Access JWT 与哈希。接口层提供鉴权所需的 HTTP 入口。口令、Refresh Token 与 API Key 的哈希由适配层通过端口完成；领域层只调用该端口，不 import Fastify、`pg` 或具体哈希库。端口实现放在网关，由组合根注入。适配层不直接引用 DAO 与网关包。

## 验收

- [ ] 新用户可注册并登录，获得 Access JWT 与 Refresh Token
- [ ] 重复邮箱注册返回 409；错误密码与未知邮箱的登录失败均为 401，且响应不区分二者，也不返回密码哈希
- [ ] Refresh Token 可换发新的 Access JWT 与新 Refresh Token；被轮换或登出的旧 Refresh Token 再使用会被拒绝
- [ ] 已登录用户可创建 Key，响应中的明文不能从后续列表接口再次取得
- [ ] 数据库中不存在 Key 明文或 Refresh Token 明文
- [ ] 有效 Key 能解析为所属用户；已吊销 Key 被拒绝
- [ ] 领域层边界检查仍然通过

## 依赖

Phase 0 为 `done`。
