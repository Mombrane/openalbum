# Phase 0 — 仓库脚手架

**状态：** done  
**依赖：** 无

## 目标

建立可继续分阶段开发的单仓：中文规格入口、DDD 五层空包、部署占位、本地数据库 Compose，以及不接触业务数据的存活探针。不实现注册、照片、检索或共享册。

## 范围内

- npm workspaces：`apps/api`、`apps/web`
- `apps/api` 五层目录与入口模块：`interfaces`、`adapters`、`domain`、`gateways`、`dao`
- 领域子目录占位：`identity`、`library`、`album`、`search`
- 网关子目录占位：`storage`、`vision`、`embed`
- 组合根上的 `GET /health`，不访问数据库或对象存储
- `apps/web` 最小 Vite + React 占位页
- `deploy/` 文档、环境变量示例、DDL 草图、Nginx 与 systemd 示例
- `docker-compose.yml`：PostgreSQL 16 + pgvector，口令使用占位符
- 分层边界检查脚本，纳入 `npm test`
- 根目录中文 README 与 `.gitignore`

## 范围外

- 用户、会话、API Key 的任何行为（Phase 1）
- 照片读写与对象存储客户端（Phase 2）
- 流水线、检索、共享册、完整网页
- `packages/shared`（尚无跨端 DTO）
- 真实密钥、真实域名、真实桶名

## 领域触点

无业务类型。仅固定包边界：领域层不得引用其他层或基础设施包。

## 验收

- [x] `specs/SPEC.md` 索引阶段 0–6，且本文件状态为 `done`
- [x] `apps/api/src` 下五层入口模块存在，领域含四个上下文占位
- [x] `npm test` 通过：边界脚本无违规，`GET /health` 返回 200 与 `{ "status": "ok" }`
- [x] `npm run typecheck` 与 `npm run build` 通过
- [x] `deploy/` 与 Compose 中的口令、密钥、域名均为占位符
- [x] 网页占位可启动，且不调用业务 API

## 依赖

无。
