-- AI Native 共享相册 — 初始 DDL 草图
-- 随 specs/phases 演进；出现应用迁移后须与 apps/api 保持一致。
-- 这里只有结构，没有凭证。

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 身份
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  key_prefix    TEXT NOT NULL,
  key_hash      TEXT NOT NULL,
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

-- 个人库
-- status: processing | ready | failed
CREATE TABLE IF NOT EXISTS photos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key      TEXT NOT NULL,
  thumb_key       TEXT,
  content_type    TEXT,
  byte_size       BIGINT,
  taken_at        TIMESTAMPTZ,
  location_text   TEXT,
  latitude        DOUBLE PRECISION,
  longitude       DOUBLE PRECISION,
  description     TEXT,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'processing',
  source_user_id  UUID REFERENCES users(id),
  source_key_id   UUID REFERENCES api_keys(id),
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_photos_owner_created ON photos(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_photos_status ON photos(status);

-- 嵌入（维度必须与 EMBED_DIMENSIONS 一致；换模型时一起改）
CREATE TABLE IF NOT EXISTS photo_embeddings (
  photo_id    UUID PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  embedding   vector(1536) NOT NULL,
  model       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 数据量上来之后再加 IVFFlat / HNSW（Phase 4）。

-- 共享册
CREATE TABLE IF NOT EXISTS albums (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  passphrase_hash TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ,
  readonly_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- role: owner | uploader | reader
CREATE TABLE IF NOT EXISTS album_members (
  album_id   UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (album_id, user_id)
);

CREATE TABLE IF NOT EXISTS album_photos (
  album_id   UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  photo_id   UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  added_by   UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (album_id, photo_id)
);

-- 异步流水线任务
-- type 示例：process_photo | reembed
-- status: pending | running | done | failed
CREATE TABLE IF NOT EXISTS jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_poll ON jobs(status, run_after);
