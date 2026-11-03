# 数据库连接

PostgreSQL + **pgvector**，运行在新加坡 CVM 上；本地开发用 Docker Compose。

## 占位符

| 项 | 占位符 | 说明 |
|----|--------|------|
| 主机 | `127.0.0.1`，或 Compose 服务名 `db` | CVM 上优先本机套接字或本机 TCP |
| 端口 | `5432` | |
| 数据库 | `photo_album` | |
| 用户 | `photo` | 应用使用的最小权限角色 |
| 口令 | `CHANGE_ME_DB_PASSWORD` | 只来自私有环境变量 |
| URL | `postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album` | 即 `DATABASE_URL` |

## 本地（Compose）

```bash
docker compose up -d
export DATABASE_URL='postgres://photo:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/photo_album'
psql "$DATABASE_URL" -f deploy/db/schema.sql
```

Phase 0 不会在 API 启动时自动执行这段 SQL。

## CVM

1. 安装 Postgres 16+，以及支持 `CREATE EXTENSION vector` 的扩展包。
2. 以超级用户创建角色和库（把口令换成私有值）：

```sql
CREATE USER photo WITH PASSWORD 'CHANGE_ME_DB_PASSWORD';
CREATE DATABASE photo_album OWNER photo;
\c photo_album
CREATE EXTENSION IF NOT EXISTS vector;
-- 应用 schema 之后按需要再授权
```

3. 用有建表权限的角色执行 `schema.sql`。Phase 0 之后逐步改为应用拥有的迁移，并保持与此草图同步。
4. 把 API 的 `DATABASE_URL` 指到该实例；`pg_hba.conf` 只允许本机或应用所在主机。

## 安全

- 生产口令不进入 git。
- 数据库如果离开本机，连接应走 TLS。MVP 同机 TCP 可以接受，但主机防火墙要收紧。
- 备份：`pg_dump` 的周期由运维负责，生产上线时再写进运行手册。
