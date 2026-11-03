# 连接 Postgres

本地开发：

1. 在仓库根目录执行 `docker compose up -d`（镜像为带 pgvector 的 Postgres）。
2. 把 `deploy/env.example` 复制为仓库根目录的 `.env`，只在那份私有文件里替换 `DATABASE_URL` 的密码。
3. 对本地连接串执行：

```bash
psql "$DATABASE_URL" -f deploy/db/schema.sql
```

新加坡 CVM 上使用同一份占位说明。账号、密码和主机只放在 `/etc/photo-album/api.env` 这类未入库的文件里。
