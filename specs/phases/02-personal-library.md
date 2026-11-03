# Phase 2 — 个人库

**Status:** planned

## Goal

个人库照片的增删改查，以及对象存储。

## In scope

设计说明已经写明的部分：每用户一个默认个人库；仅本人与其有效 Key 可读写；上传、浏览、删除、改元数据。对象字节走用户提供的 S3 兼容存储。

## Out of scope

EXIF、缩略图、视觉描述、嵌入、检索、共享册、完整网页。

## Domain touches

`domain/library`。存储端口由网关实现，不写在领域层。

## Acceptance

以设计说明里的个人库描述为准。原文阶段 Spec 未包含在可用产物中，这里不补写实现步骤。

## Depends on

Phase 1。
