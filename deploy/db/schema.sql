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

-- Refresh Token。只存 HMAC 摘要。family_id 把一次登录之后的轮换串成一族。
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  family_id    UUID NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  replaced_by  UUID REFERENCES refresh_tokens(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);

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

-- 进行中的原图上传。对象存储完成之后才插入 photos。
-- status: open | completing | completed | aborted
CREATE TABLE IF NOT EXISTS upload_sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id             UUID NOT NULL UNIQUE,
  object_key           TEXT NOT NULL,
  content_type         TEXT NOT NULL,
  byte_size            BIGINT NOT NULL,
  s3_upload_id         TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open',
  object_completed_at  TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT upload_sessions_status CHECK (status IN ('open', 'completing', 'completed', 'aborted')),
  CONSTRAINT upload_sessions_byte_size CHECK (byte_size >= 1 AND byte_size <= 33554432)
);

CREATE TABLE IF NOT EXISTS upload_parts (
  upload_session_id UUID NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_number       INT NOT NULL,
  etag              TEXT NOT NULL,
  byte_size         BIGINT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_session_id, part_number),
  CONSTRAINT upload_parts_part_number CHECK (part_number >= 1 AND part_number <= 10000),
  CONSTRAINT upload_parts_byte_size CHECK (byte_size >= 1 AND byte_size <= 33554432)
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_owner_status
  ON upload_sessions(owner_id, status, expires_at);

-- 嵌入（维度必须与 EMBED_DIMENSIONS 一致；换模型时一起改）
CREATE TABLE IF NOT EXISTS photo_embeddings (
  photo_id    UUID PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  embedding   vector(1536) NOT NULL,
  model       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 本阶段不建 ANN 索引。切换条件见 docs/superpowers/specs/2026-11-06-openalbum-phase4-search-design.md 第 7 节。
-- 全表 photo_embeddings 行数达到 100000，或语义检索数据库侧 p95 超过 200 毫秒且该用户 ready 照片达到 10000 时，
-- 才允许后续提交使用 HNSW（vector_cosine_ops，m = 16，ef_construction = 64）。在那之前禁止创建该索引。

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
-- type: process_photo | reembed
-- status: pending | running | done | failed
-- payload.step: exif | thumbnail | vision | embed | done
CREATE TABLE IF NOT EXISTS jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT NOT NULL,
  photo_id     UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  payload      JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jobs_type CHECK (type IN ('process_photo', 'reembed')),
  CONSTRAINT jobs_status CHECK (status IN ('pending', 'running', 'done', 'failed')),
  CONSTRAINT jobs_attempts CHECK (attempts >= 0)
);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS photo_id UUID;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_photo_id_fkey') THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_photo_id_fkey
      FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE;
  END IF;
END $$;

DELETE FROM jobs WHERE photo_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'jobs'
      AND column_name = 'photo_id'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE jobs ALTER COLUMN photo_id SET NOT NULL;
  END IF;
END $$;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type;
ALTER TABLE jobs ADD CONSTRAINT jobs_type CHECK (type IN ('process_photo', 'reembed'));
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status;
ALTER TABLE jobs ADD CONSTRAINT jobs_status CHECK (status IN ('pending', 'running', 'done', 'failed'));
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_attempts;
ALTER TABLE jobs ADD CONSTRAINT jobs_attempts CHECK (attempts >= 0);

CREATE INDEX IF NOT EXISTS idx_jobs_poll ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_jobs_photo ON jobs(photo_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active
  ON jobs (photo_id, type)
  WHERE status IN ('pending', 'running');
