# Phase 3 — 处理流水线

**状态：** planned  
**依赖：** Phase 2  
**设计：** [`docs/superpowers/specs/2026-11-06-openalbum-phase3-processing-pipeline-design.md`](../../docs/superpowers/specs/2026-11-06-openalbum-phase3-processing-pipeline-design.md)

## 目标

照片入库后异步完成：抽取 EXIF、生成缩略图、调用外部视觉模型写描述与标签、调用外部嵌入模型写向量，然后进入 `ready`。模型失败时保留原图，状态为 `failed`，并且可以重试语义步骤。Agent 覆盖元数据后可以触发重新嵌入。

## 范围内

- `jobs` 表驱动的 worker（轮询间隔与并发来自 `PIPELINE_POLL_MS`、`PIPELINE_CONCURRENCY`）
- EXIF 时间与 GPS；用户或 Agent 已填写的字段不被静默覆盖
- 缩略图写入对象存储
- 视觉与嵌入通过 `gateways/vision`、`gateways/embed` 调用外部 HTTP API
- `photo_embeddings` 的维度与 `EMBED_DIMENSIONS`、`schema.sql` 中的 `vector(n)` 一致
- 失败可重试；成功后状态为 `ready`
- 不在 CVM 上加载或运行大模型

## 范围外

- 面向用户的搜索排序与过滤语法（Phase 4）
- 共享册内的可见性（Phase 5）
- 人脸聚类、自动事件分组

## 领域触点

`domain/library`：状态机 `processing | ready | failed`，以及「元数据被覆盖后需要重嵌入」的规则。  
任务的领取与重试次数属于应用编排，规则（何时允许重试、何时算失败）放在领域。  
DAO 负责任务与嵌入的 SQL。网关负责 EXIF 之外的外部 I/O；EXIF 解析库若只是纯解析，可以放在网关或适配层，不得把 Fastify 或 S3 SDK 引进领域层。

## 验收

- [ ] 上传后的照片最终变为 `ready` 或在外部 API 失败时变为 `failed`，原图仍可访问
- [ ] `ready` 的照片具备缩略图、描述或标签（模型有返回时）、以及一条嵌入
- [ ] 嵌入维度与配置一致，不匹配时任务失败并可观察错误，而不是写坏向量列
- [ ] 覆盖描述或标签后能再次嵌入
- [ ] worker 不向日志打印 API Key、对象存储密钥或口令
- [ ] 领域层边界检查仍然通过

## 依赖

Phase 2 为 `done`。
