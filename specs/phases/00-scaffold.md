# Phase 0 — 脚手架

**Status:** planned

## Goal

Monorepo、DDD 空包、本地 compose、deploy 占位。

## In scope

- npm workspace：`apps/api`、`apps/web`、`packages/shared`
- `apps/api/src` 下的接口、适配、领域、网关、DAO 空包
- 带 pgvector 的本地 Postgres compose
- `deploy/` 中的环境、连接、Nginx、systemd 占位，不含真实密钥
- `GET /health` 返回 `{"status":"ok"}`
- 网页只放 Phase 0 占位，说明规格入口、健康检查和部署目录

## Out of scope

注册登录、照片、流水线、检索、共享册，以及 Phase 6 的业务界面。

## Domain touches

不写业务规则。领域目录只占位，不引入基础设施。

## Acceptance

- 上述目录与脚本存在，`npm test` 覆盖健康检查
- 占位页不提供上传、搜索或登录
- 仓库中没有真实密钥

## Depends on

无

## 重建说明

阶段原文不在可用产物里。本节只使用 `specs/SPEC.md` 的索引摘要，以及 Phase 0 演示中已经出现的健康检查和占位页。
