# OpenAlbum

人用网页管理照片，个人 AI Agent 用同一套 API 管理同一批照片。每张照片带有时间、地点、描述和标签，并可以按语义召回。服务预定部署在新加坡腾讯云 CVM；大模型只通过外部 HTTP API 调用，不在这台机器上推理。

当前仓库是 **Phase 0 脚手架**：规格、部署占位、DDD 空包、存活探针和一页前端占位。注册、上传、检索和共享册都还没有实现。

## 仓库怎么读

实现以 [`specs/SPEC.md`](specs/SPEC.md) 为唯一入口。产品意图见 [`docs/superpowers/specs/2026-11-03-ai-native-photo-album-design.md`](docs/superpowers/specs/2026-11-03-ai-native-photo-album-design.md)。部署提纲、环境变量和 DDL 草图在 [`deploy/`](deploy/README.md)，里面只有占位符。

`docs/superpowers/plans/` 是早期英文单体计划的历史说明，停用，不能当作施工依据。

## DDD 分层

后端在 `apps/api/src`。依赖只能向内：接口层调用适配层，适配层调用领域层。DAO 与网关实现领域定义的端口，再由组合根（`src/index.ts`、`src/app.ts`）装配。

| 层 | 目录 | 职责 |
|----|------|------|
| 接口层 | `interfaces` | HTTP 路由、请求与响应形状。Phase 0 只有 `GET /health` |
| 适配层 | `adapters` | 用例编排、鉴权上下文、事务边界。本阶段为空包 |
| 领域层 | `domain` | 实体、规则、仓储端口。禁止引用 Fastify、数据库、对象存储和外部 SDK |
| 网关层 | `gateways` | 对象存储、视觉、嵌入等出站实现。本阶段只有 `storage`、`vision`、`embed` 占位 |
| DAO 层 | `dao` | SQL 与 pgvector。本阶段为空包；DDL 草图在 `deploy/db/schema.sql` |

领域上下文占位：`identity`、`library`、`album`、`search`。说明见 [`specs/domain/overview.md`](specs/domain/overview.md)。

`npm run check:layers` 会扫描这些目录的 import，防止领域层碰到基础设施，也防止接口层直接调用 DAO 或网关。

## 阶段 0–6

一次只做一个状态为 `in_progress` 的阶段，并且它依赖的阶段必须已经是 `done`。

| 阶段 | 状态 | 内容 |
|------:|------|------|
| 0 | done | 本仓库的脚手架、空包、Compose 与部署占位 |
| 1 | planned | 用户、JWT、API Key |
| 2 | planned | 个人库与对象存储 |
| 3 | planned | EXIF、缩略图、视觉描述、嵌入、任务表 |
| 4 | planned | 关键词与向量检索 |
| 5 | planned | 共享册、口令、角色 |
| 6 | planned | React 网页与主路径 |

开工时把 `specs/SPEC.md` 里对应行改成 `in_progress`，做完并满足该阶段验收后再改成 `done`。不要把后面阶段的接口提前写进当前阶段。

## 本地运行

需要 Node.js 20 或更高版本。

```bash
npm ci
npm test
npm run dev:api    # 默认端口 3000，GET /health
npm run dev:web    # http://127.0.0.1:43123
```

数据库从 Phase 1 才需要：

```bash
docker compose up -d
```

连接方式与占位口令见 [`deploy/db/CONNECTION.md`](deploy/db/CONNECTION.md)。把 `deploy/env.example` 复制为仓库根目录的 `.env` 后再填私有值，不要把填好的文件提交进来。

## 构建

```bash
npm run build
```

API 产物在 `apps/api/dist/`，网页产物在 `apps/web/dist/`。CVM 上的 Nginx 与 systemd 示例在 `deploy/`。
