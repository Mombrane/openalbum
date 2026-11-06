# 部署 — AI Native 共享相册

构建、本地运行，以及新加坡 CVM 的部署提纲。**本目录不存放真实凭证**。把 `env.example` 复制到仓库外的私有 `.env`（或 systemd 的 `EnvironmentFile`）再填写。

## 布局

| 路径 | 用途 |
|------|------|
| `env.example` | 所需环境变量，值均为占位符 |
| `db/schema.sql` | 演进中的 DDL 草图（运维草图的事实源；应用迁移须与之对齐） |
| `db/CONNECTION.md` | 如何连接 Postgres（占位符） |
| `nginx.example.conf` | 反向代理与 TLS 终结草图 |
| `systemd/photo-api.service.example` | API 进程的 systemd 单元草图 |
| `systemd/photo-worker.service.example` | 处理流水线 worker 的 systemd 单元草图 |

## 本地开发

Phase 0 的 `GET /health` 与网页占位**不需要**数据库。从 Phase 1 起再启动 Postgres。

1. 复制 `deploy/env.example` 为仓库根目录 `.env`，填上占位符（本地数据库口令、用于联调的模型 Key 即可）。
2. 启动数据库：`docker compose up -d`（带 pgvector 的 Postgres）。
3. 应用草图：见 `db/CONNECTION.md`（对本地 URL 执行 `psql`）。
4. 安装并启动进程：

```bash
npm ci
npm run dev:api
npm run dev:web
```

5. 对象存储：本地可用 MinIO 或单独的桶；密钥只放在 `.env`。

存活探针：`GET /health`，成功时正文为 `{ "status": "ok" }`。默认监听 `PORT`（示例为 `3000`）。

## 构建（提纲）

```bash
npm ci
npm run build -w apps/api
npm run build -w apps/web
```

产物：API 的 `apps/api/dist/`；网页静态文件在 `apps/web/dist/`（由 Nginx 或后续的 API 静态托管提供）。

## 新加坡 CVM 部署（提纲）

1. 在腾讯云新加坡准备 Ubuntu（或同类系统）；开放 80/443；使用 SSH 公钥登录。
2. 安装 Node 20+。数据库可选 Docker，或本机 Postgres 16 与 `pgvector`。
3. 创建数据库角色与库，应用 `db/schema.sql`（此后改为应用自己的迁移时，仍保持与草图一致）。
4. 按 `env.example` 编写私有环境文件，例如 `/etc/photo-album/api.env`。
5. 配置 S3 兼容存储（COS）桶；密钥只写入该环境文件。
6. 参考 `systemd/photo-api.service.example` 安装单元，执行 `daemon-reload` 后 `enable --now`。
7. 把域名 A/AAAA 指到这台 CVM；用 certbot 签发证书；以 `nginx.example.conf` 为起点。
8. 冒烟：`GET /health`。注册用户与上传照片要等 Phase 1、Phase 2 完成后再测。

## 注册与登录不要裸露到公网

`POST /auth/register` 与 `POST /auth/login` 在 Phase 1 没有限流。在反向代理或网关加上限流之前，不要把这两个路径公开到互联网。本仓库不实现限流器，也不规定阈值。口令长度上限 128 只是为了避免超长 argon2 输入，不是限流。

Phase 1 的 `schema.sql` 在身份段增加 `refresh_tokens`。本地仍然用 `docker compose up -d` 后执行该文件。

Phase 2 在 `schema.sql` 的个人库段追加 `upload_sessions` 与 `upload_parts`。签名 GET 的有效期是 `S3_SIGNED_URL_TTL`，默认 `15m`，语法与 `JWT_TTL` 相同，超过 7 天时进程拒绝启动。本阶段不读取 `S3_PUBLIC_BASE_URL`。

Phase 3 将 `jobs` 定为 `process_photo` 与 `reembed`。`photo_id` 外键级联删除照片的任务，并增加 `locked_at`。Worker 读取 `PIPELINE_POLL_MS`（空白时 2000，闭区间 200 到 60000）、`PIPELINE_CONCURRENCY`（空白时 2，闭区间 1 到 8）、`VISION_TIMEOUT_MS`（空白时 60000）与 `EMBED_TIMEOUT_MS`（空白时 30000）。`EMBED_DIMENSIONS` 必须是 `1536`，与 `vector(1536)` 相同。`NODE_ENV=production` 时，视觉、嵌入或对象存储占位符让 worker 以退出码 1 结束；API 进程只在对象存储占位符上以退出码 1 结束，文案是 `对象存储配置仍是占位符`。非 production 的视觉与嵌入占位符使用假网关。本阶段仍不读取 `S3_PUBLIC_BASE_URL`。

Worker 单元草图是 `systemd/photo-worker.service.example`。`EnvironmentFile` 与 API 相同，`ExecStart` 指向 `dist/worker.js`，不监听端口。

## 密钥清单

- [ ] 数据库口令
- [ ] JWT 签名密钥
- [ ] S3/COS 访问密钥与私有密钥
- [ ] 视觉 API Key
- [ ] 嵌入 API Key
- [ ] 共享册口令哈希的 pepper（若与 API Key pepper 分开）
- [ ] `API_KEY_PEPPER`（API Key 与 Refresh Token 共用的 HMAC 键）

禁止提交填好的值。一旦泄漏就轮换。
