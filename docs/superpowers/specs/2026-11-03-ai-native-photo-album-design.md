# AI Native 共享相册 — 设计说明

日期：2026-11-03  
部署目标：新加坡腾讯云服务器  
状态：已定稿（含 DDD 分层与分阶段 Spec 流程）  
权威实现规格：仓库根目录 [`specs/SPEC.md`](../../../specs/SPEC.md)

## 1. 目标

做一个 **AI Native** 的照片平台：人用网页，个人 AI Agent 用 API 管理照片。每张照片携带语义元数据（时间、地点、内容描述等），并支持向量召回。

非目标（MVP 不做）：社交动态流、原生 App、开放 Agent 市场、多租户计费、自托管大模型。

## 2. 核心模型

### 2.1 用户与鉴权

- 人类：邮箱 + 密码登录网页。
- Agent：用户在网页创建 **API Key / Token**，请求头 `Authorization: Bearer <token>`。
- Key 仅存储哈希；可命名、吊销、查看末次使用时间。

### 2.2 个人库

- 每用户一个默认个人库。
- 仅该用户本人与持其有效 Key 的 Agent 可读写。
- 支持上传、浏览、删除、改元数据、语义/关键词搜索。

### 2.3 共享册

- 用户创建「活动/主题」共享册，生成 **链接 + 口令**。
- 角色：册主 / 可上传 / 只读。
- 册主可设过期或锁成只读纪念册。
- 口令兑换短期会话，不明文写进日志。

### 2.4 照片对象

每张照片包含：

| 字段 | 说明 |
|------|------|
| 原图 / 缩略图 | 存储路径或对象键 |
| 拍摄时间 | 优先 EXIF，可覆盖 |
| 地点 | EXIF GPS 或用户/Agent 填写 |
| 描述 | 视觉模型自动生成，可覆盖 |
| 标签 | 自动 + 可覆盖 |
| 来源 | 上传者用户 ID 或 Agent Key 标识 |
| 向量 | 描述/图像嵌入，供召回 |
| 状态 | `processing` / `ready` / `failed` |

流水线：收图 → 存原图与缩略图 → 抽 EXIF → 调外部视觉模型写描述/标签 → 嵌入向量 → `ready`。模型失败时仍保留原图，状态 `failed`，可重试语义补全。Agent 覆盖元数据后可触发重嵌入。

## 3. 接口与网页

### 3.1 网页（人类）

- 登录 / 注册
- 个人库瀑布流、上传、详情
- 搜索：关键词 + 自然语言找图
- 创建与管理共享册、口令与权限
- 管理 API Key（创建、吊销）

### 3.2 REST API（与网页同一后端）

示例能力（路径可在实现时微调，语义保持）：

- `POST/GET/PATCH/DELETE /photos` — 个人库照片增删改查
- `POST /photos/search` — 语义与过滤检索
- `POST/GET/PATCH /albums` — 共享册
- `POST /albums/:id/photos` — 向共享册上传
- 上传支持中断后续传；列表带缩略图 URL 与元数据

Agent 与人类操作落在同一权限模型上，不另开「超级后门」。

## 4. 技术栈与部署

| 层 | MVP 选择 | 备注 |
|----|----------|------|
| 后端 | Node + TypeScript | 已定 |
| 前端 | React（Vite） | 已定 |
| 元数据 DB | PostgreSQL + pgvector | 同机部署在新加坡 CVM |
| 文件 | 用户提供的 S3 兼容对象存储 | 已定；缩略图可缓存本机 |
| 队列 | DB 任务表（可后续换 Redis） | 描述与嵌入异步 |
| 模型 | 外部视觉 / Embedding API | 不在 CVM 上跑大模型 |
| 入口 | Nginx + HTTPS | 域名指向新加坡机 |

部署骨架与连接占位符见 [`deploy/`](../../../deploy/)。

## 5. DDD 分层架构

后端 `apps/api` 按五层分包。**依赖方向只能向内**：接口 → 适配 → 领域；DAO / 网关实现依赖领域定义的端口，领域层 **禁止** 引入基础设施（HTTP、SQL、S3、外部 SDK）。

### 5.1 接口层（interfaces）

- **包意**：对外边界。HTTP 路由、Controller、请求/响应 DTO、OpenAPI 形状。
- **做**：解析路由参数、校验入参形状、调用适配层用例入口、写出 HTTP 状态码。
- **不做**：业务规则、直接访问 DB/对象存储、拼装领域不变量。
- **示例路径**：`apps/api/src/interfaces/http/...`

### 5.2 适配层（adapters）

- **包意**：应用用例编排 + 边界映射。把 HTTP/鉴权上下文映射成领域命令；把领域结果映射成 DTO。
- **做**：鉴权上下文解析（JWT / API Key）、multipart 收流后交给用例、事务边界（应用服务）、Presenter。
- **不做**：领域规则正文；不直接写 SQL；不直接调外部 HTTP SDK（走网关端口）。
- **示例路径**：`apps/api/src/adapters/...`

### 5.3 领域层（domain）

- **包意**：核心业务。实体、值对象、领域服务、领域事件、仓储 **端口**（接口）。
- **做**：照片状态机、权限判定规则、元数据覆盖与重嵌入策略、共享册角色规则。
- **不做**：`import` 任何 DB 驱动、S3 SDK、Fastify、外部模型客户端。
- **示例路径**：`apps/api/src/domain/{identity,library,album,search}/...`

### 5.4 网关层（gateways / ports 实现）

- **包意**：出站基础设施适配。实现领域或应用定义的端口：`Storage`、`Vision`、`Embed`、`Clock`、`IdGen` 等。
- **做**：S3/COS 上传下载、视觉描述 API、向量嵌入 API、时间与 ID 生成。
- **不做**：业务决策；不暴露给接口层直接调用（由适配层注入）。
- **示例路径**：`apps/api/src/gateways/{storage,vision,embed,...}/...`

### 5.5 DAO 层（persistence）

- **包意**：持久化实现。实现领域仓储端口；SQL / migrations；pgvector 查询。
- **做**：`UserRepository`、`PhotoRepository`、`AlbumRepository`、`JobRepository`、embedding 读写。
- **不做**：HTTP、领域规则；迁移文件与运行时 DAO 同属本层关注点。
- **示例路径**：`apps/api/src/dao/...`；权威 DDL 草图同步维护在 `deploy/db/`。

### 5.6 分层示意

```
HTTP 请求
  → 接口层 (routes / DTO)
    → 适配层 (auth / use-cases / presenters)
      → 领域层 (entities / services / ports)
          ↑ 实现                ↑ 实现
      DAO 层 (SQL/repos)    网关层 (Storage/Vision/Embed/…)
```

## 6. 分阶段 Spec 开发流程

**禁止**一次性实现整个代码库。需求拆成多个阶段 Spec，每个阶段走完整的「规格 → 实现 → 验收」循环。

- **权威事实源**：仓库根目录 `specs/`。项目入口为 [`specs/SPEC.md`](../../../specs/SPEC.md)，索引全部阶段 Spec。
- **历史计划**：早期英文单体实现计划只作历史说明，见 [`docs/superpowers/plans/`](../plans/README.md)。它已被 `specs/` 分阶段流程取代，不再指导实现。
- **阶段完成定义**：该阶段 Spec 的验收标准全部满足；对应测试/手工检查通过；入口 `SPEC.md` 中该阶段状态更新为 `done`。
- **加新阶段**：在 `specs/phases/` 新增文件，并在 `SPEC.md` 登记；不得跳过依赖阶段进入实现。

### 6.1 建议交付顺序

| 阶段 | Spec | 内容 |
|------|------|------|
| Phase 0 | `phases/00-scaffold.md` | 仓库脚手架、分层空包、deploy 占位、本地 compose |
| Phase 1 | `phases/01-identity-auth.md` | 用户注册登录、JWT、API Key |
| Phase 2 | `phases/02-personal-library.md` | 个人库上传/列表/删除、对象存储接入 |
| Phase 3 | `phases/03-processing-pipeline.md` | EXIF、缩略图、视觉描述、嵌入、任务表 |
| Phase 4 | `phases/04-search.md` | 关键词 + 向量语义检索 |
| Phase 5 | `phases/05-shared-albums.md` | 共享册、口令、角色、册内上传 |
| Phase 6 | `phases/06-web-ui.md` | React 网页打磨与联调 |

## 7. 建议仓库树

```
/
├── specs/
│   ├── SPEC.md                 # 项目级入口（权威索引）
│   ├── domain/
│   │   └── overview.md         # 限界上下文概览
│   └── phases/
│       ├── 00-scaffold.md
│       ├── 01-identity-auth.md
│       ├── 02-personal-library.md
│       ├── 03-processing-pipeline.md
│       ├── 04-search.md
│       ├── 05-shared-albums.md
│       └── 06-web-ui.md
├── deploy/
│   ├── README.md
│   ├── env.example
│   ├── nginx.example.conf
│   ├── db/
│   │   ├── schema.sql
│   │   └── CONNECTION.md
│   └── systemd/
│       └── photo-api.service.example
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── interfaces/     # 接口层
│   │       ├── adapters/       # 适配层
│   │       ├── domain/         # 领域层
│   │       ├── gateways/       # 网关层
│   │       └── dao/            # DAO 层
│   └── web/                    # React SPA
├── packages/
│   └── shared/                 # 共享 DTO / 类型（可选）
├── docs/superpowers/
│   ├── specs/                  # 产品设计说明（本文件）
│   └── plans/                  # 历史实现计划（已 superseded）
├── package.json
├── docker-compose.yml
└── README.md
```

## 8. 权限与失败处理

- 个人库：主人 + 其 API Key。
- 共享册：按角色；无权限返回 403，不泄露是否存在。
- 上传中断可续；流水线 `failed` 可重试；配额耗尽时原图仍保存，语义后补。

## 9. MVP 验收标准

1. 用户能注册登录，上传照片到个人库并在网页看到缩略图。
2. 照片在处理后具有描述/标签，并可用自然语言搜到。
3. 用户能创建 API Key；用 Key 完成上传、改元数据、语义搜索。
4. 用户能建共享册（链接+口令），另一人/Agent 可按权限上传或只读浏览。
5. 服务部署在新加坡腾讯云，HTTPS 可公网访问。

## 10. 明确不做（MVP）

- 仿虾聊的开放 Agent 社交网络
- 多端原生 App
- 计费与复杂多租户
- 站内大模型推理

## 11. 后续可演进

- MCP / skill.md 一键让 Agent 接入
- COS + CDN、多机拆分
- 人脸/相册智能分组（需额外合规考虑）

## 12. 已确认决策（2026-11-03）

- 后端：Node + TypeScript
- 前端：React
- 数据库：PostgreSQL + pgvector，安装在同一台新加坡 CVM
- 对象存储：由用户提供 S3 兼容（实现时接入）
- 本机磁盘：可用（系统、DB、临时/缓存）
- 架构：DDD 五层（接口 → 适配 → 领域 → 网关 / DAO）
- 开发流程：`specs/` 分阶段 Spec 驱动；禁止一次性整库实现
