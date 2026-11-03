# Phase 1 — 身份与 API Key

**Status:** planned

## Goal

用户、JWT 会话、API Key。

## In scope

设计说明已经写明的部分：邮箱加密码登录；用户创建可命名、可吊销的 API Key；Key 只存哈希，可看末次使用时间；Agent 使用 `Authorization: Bearer <apiKey>`。

## Out of scope

个人库、流水线、检索、共享册、完整网页。

## Domain touches

`domain/identity`。规则留到本阶段实现，Phase 0 不写。

## Acceptance

以设计说明里的身份与 API Key 描述为准。原文阶段 Spec 未包含在可用产物中，这里不补写实现步骤。

## Depends on

Phase 0。
