# AI Native 共享相册 — 项目规格入口

**状态：** 生效中  
**产品设计：** [`docs/superpowers/specs/2026-11-03-ai-native-photo-album-design.md`](../docs/superpowers/specs/2026-11-03-ai-native-photo-album-design.md)  
**部署：** [`deploy/README.md`](../deploy/README.md)  
**领域概览：** [`domain/overview.md`](domain/overview.md)

本目录是实现的**权威事实源**。阶段 Spec 未标记为 `ready` 或 `in_progress` 的能力，不得提前实现。`docs/superpowers/plans/` 里的早期英文单体计划只作历史说明，不指导实现。

## 如何推进一个阶段

1. 先读本索引，再读 `phases/` 下对应阶段文件。
2. 确认依赖阶段的状态已是 `done`。
3. 把下表中该阶段状态改为 `in_progress`（可以和开工放在同一次提交）。
4. 只实现该阶段的**范围内**内容，不把后续阶段的功能提前做进来。
5. 满足**验收标准**后，把状态改为 `done`。
6. 该阶段如果改了持久化或运维方式，同步更新 `deploy/db/schema.sql` 与环境变量文档。

## 任何阶段的完成定义

- [ ] 该阶段 Spec 中的验收标准全部满足
- [ ] 该阶段要求的自动化测试通过（纯部署项可以改为写明的手工检查）
- [ ] 分层得到遵守：领域层不引用基础设施
- [ ] 本索引表中该阶段状态已更新为 `done`
- [ ] 没有提交密钥；`deploy/` 里只有占位符

## 阶段索引

| 阶段 | 规格 | 状态 | 摘要 |
|------:|------|--------|---------|
| 0 | [phases/00-scaffold.md](phases/00-scaffold.md) | done | 单仓、DDD 空包、Compose、部署占位 |
| 1 | [phases/01-identity-auth.md](phases/01-identity-auth.md) | done | 用户、Access JWT + Refresh、API Key（仅 HTTP API） |
| 2 | [phases/02-personal-library.md](phases/02-personal-library.md) | in_progress | 个人照片增删改查与对象存储 |
| 3 | [phases/03-processing-pipeline.md](phases/03-processing-pipeline.md) | planned | EXIF、缩略图、视觉描述、嵌入、任务 |
| 4 | [phases/04-search.md](phases/04-search.md) | planned | 关键词与向量检索 |
| 5 | [phases/05-shared-albums.md](phases/05-shared-albums.md) | planned | 共享册、口令、角色 |
| 6 | [phases/06-web-ui.md](phases/06-web-ui.md) | planned | React 界面与端到端主路径 |

## 如何新增阶段

1. 在 `specs/phases/` 新建 `NN-短名.md`，沿用现有阶段的章节：目标、范围内、范围外、领域触点、验收、依赖。
2. 在上表增加一行，状态写 `planned`。
3. 若出现新的限界上下文，在 `specs/domain/` 补说明并链过来。
4. 不重排已完成阶段；新阶段追加，或插入时写清依赖。

## 全局约束（所有阶段）

- 后端：Node + TypeScript + Fastify；代码位于 `apps/api/src/{interfaces,adapters,domain,gateways,dao}`
- 前端：React（Vite），位于 `apps/web`
- 数据库：PostgreSQL + pgvector，部署在新加坡 CVM（本地用 Compose）
- 对象存储：S3 兼容；凭证只通过环境变量占位符进入仓库
- Agent：`Authorization: Bearer <apiKey>`；Key 只存哈希
- 不在 CVM 上跑大模型推理；视觉与嵌入只调用外部 HTTP API
