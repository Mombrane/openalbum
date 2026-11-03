# Phase 3 — 处理流水线

**Status:** planned

## Goal

EXIF、缩略图、视觉描述、嵌入、任务表。

## In scope

设计说明已经写明的流水线：保存原图与缩略图，抽取 EXIF，调用外部视觉模型写描述和标签，再做嵌入。状态为 `processing` / `ready` / `failed`。模型失败时保留原图。不在 CVM 上跑大模型。

## Out of scope

检索接口、共享册、完整网页。

## Domain touches

`domain/library` 中的状态与覆盖后重嵌入策略。外部调用走网关。

## Acceptance

以设计说明里的照片对象和流水线描述为准。原文阶段 Spec 未包含在可用产物中，这里不补写实现步骤。

## Depends on

Phase 2。
