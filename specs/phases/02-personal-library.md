# Phase 2 — 个人照片库

**状态：** done  
**依赖：** Phase 1  
**设计：** [`docs/superpowers/specs/2026-11-04-openalbum-phase2-personal-library-design.md`](../../docs/superpowers/specs/2026-11-04-openalbum-phase2-personal-library-design.md)

## 目标

主人本人，以及持有其有效 API Key 的 Agent，可以向个人库上传、列出、查看、修改元数据并删除照片。原图进入 S3 兼容对象存储，元数据进入 PostgreSQL。

## 范围内

- 上传：服务端中转。全程经 API 的 S3 multipart 续传（创建会话 → 分片 → 完成），客户端可中止
- 单文件上限 32 MiB（33554432 字节）
- content-type 白名单，本阶段固定为：`image/jpeg`、`image/png`、`image/webp`、`image/heic`、`image/heif`，以及 RAW：`image/x-canon-cr2`、`image/x-nikon-nef`、`image/x-sony-arw`、`image/x-adobe-dng`
- 完成 multipart 后才插入 `photos`，初始状态 `processing`。进行中的上传写在 `upload_sessions`（方案 A）。呼叫对象存储完成之前会话先进入 `completing`，此期间分片与中止返回 409
- 对象键在创建会话时确定：预生成 photo UUID，键为 `owners/{userId}/photos/{photoId}/original`，完成时插入同一 id
- 列出与查看仅限该主人的照片。列表和详情返回签名 GET URL，TTL 由 `S3_SIGNED_URL_TTL` 配置，默认 `15m`
- 修改仅限 `description`、`tags`、`taken_at`、`location_text`、`latitude`、`longitude`。不可改 `content_type`、`object_key`、`status`
- 删除：先删 `photos` 行，原图尽力删；`thumb_key` 非空时缩略图也尽力删。对象删除失败只记日志，接口仍成功
- 他人的 JWT 或 Key 不能读写这批照片。已认证的越权访问统一表现为「未找到」
- 对象存储配置只来自环境变量（既有 `S3_*`，另加 `S3_SIGNED_URL_TTL`）

## 范围外

- EXIF 解析、缩略图、视觉模型、向量（Phase 3）
- 搜索接口的召回语义（Phase 4）；本阶段列表只按主人与时间等直接过滤
- 共享册（Phase 5）
- 网页瀑布流（Phase 6）；本阶段以 API 与测试为准
- 预签名客户端直传、上传限流器、按文件魔数识别类型

## 领域触点

`domain/library`：照片实体、个人库访问规则、元数据覆盖规则、上传会话规则、仓储端口与对象存储端口。领域层不引入 S3 SDK。  
`gateways/storage`：对象存储端口的实现。未配置真实对象存储时，测试用的假实现也只放在这一层。  
身份上下文只提供主体，不在本阶段改写登录规则。

## 验收

- [x] 主人用 JWT 或自己的 API Key 都能上传并在列表中看到该照片
- [x] 其他用户不能读取或删除该照片
- [x] 元数据修改只作用于调用者有权的照片
- [x] 对象键与数据库行一致；存储凭证不出现在日志或响应正文
- [x] 未配置真实对象存储时，测试可以使用本地假实现，且假实现位于网关层
- [x] 领域层边界检查仍然通过

## 依赖

Phase 1 为 `done`。
