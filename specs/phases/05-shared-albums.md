# Phase 5 — 共享册

**Status:** planned

## Goal

共享册、口令、角色。

## In scope

设计说明已经写明的部分：链接加口令；角色为册主、可上传、只读；册主可设过期或锁成只读；口令兑换短期会话且不明文写日志；无权限返回 403，不泄露是否存在。

## Out of scope

完整网页打磨。

## Domain touches

`domain/album`。

## Acceptance

以设计说明里的共享册描述为准。原文阶段 Spec 未包含在可用产物中，这里不补写实现步骤。

## Depends on

Phase 4。
