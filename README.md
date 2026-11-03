# OpenAlbum

人用网页管理照片，个人 Agent 用 API 做同一件事。照片带语义元数据，并支持向量召回。

当前仓库是 **Phase 0 脚手架**：规格在 `specs/`，部署占位在 `deploy/`，后端按 DDD 五层留空包，网页只是占位。业务功能从 Phase 1 起按阶段做，不要跳过 `specs/SPEC.md` 里的依赖。

## 从哪里读

- 规格入口：[`specs/SPEC.md`](specs/SPEC.md)
- 产品设计：[`docs/superpowers/specs/2026-11-03-ai-native-photo-album-design.md`](docs/superpowers/specs/2026-11-03-ai-native-photo-album-design.md)
- 部署占位：[`deploy/README.md`](deploy/README.md)
- 历史计划（已被 `specs/` 取代，目录结构不要照搬）：[`docs/superpowers/plans/README.md`](docs/superpowers/plans/README.md)

## 本地

```bash
cp deploy/env.example .env
docker compose up -d
npm install
npm test
npm run dev:api
npm run dev:web
```

API 存活探针：`GET /health` → `{"status":"ok"}`。网页开发服务器默认 `http://127.0.0.1:5173`。

## 关于这份树

Origin 私有库 `202321090310/ai-native-photo`（约 `8baeb23`）在本环境无法克隆：未注入 `CURSOR_AUTH_TOKEN`。树是按同账号已有产物重建的，包括规格入口、`deploy/README.md`、定稿设计说明，以及 Phase 0 演示里的占位页和健康检查响应。这不是该提交的逐字节拷贝。阶段 Spec 正文在产物里只有索引摘要，没有原文，因此 `specs/phases/` 只保留摘要，没有补写未出现的实现步骤。
