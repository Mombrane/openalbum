# AI Native Photo Album Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an AI-native photo platform where humans use a React SPA and personal AI Agents use Bearer API keys to manage a personal library and shared albums, with automatic semantic metadata, overrideable fields, and vector search — deployed on a Singapore Tencent CVM behind Nginx+HTTPS.

**Architecture:** npm monorepo with `apps/api` (Fastify + TypeScript), `apps/web` (React + Vite + TypeScript), and `packages/shared` (DTO/types). PostgreSQL + pgvector on the same host stores users, albums, photo metadata, and embeddings; object bytes go through a `Storage` interface (local FS in tests, S3-compatible for production/COS). Vision describe + embedding run via pluggable providers (mock in tests, HTTP in prod). A DB-backed job table drives the async pipeline: store → EXIF → describe → embed → ready/failed.

**Tech Stack:** Node 20+, TypeScript 5.x, Fastify 5, @fastify/jwt, bcryptjs, pg, sharp, exifr, React 18, Vite 5, React Router 6, pgvector, docker compose (dev Postgres only), Nginx, Let's Encrypt.

## Global Constraints

- Backend: Node + TypeScript (Fastify); no Go.
- Frontend: React SPA (Vite); no Vue.
- Database: PostgreSQL + pgvector on the same Singapore Tencent CVM; local disk OK for DB data and temp/cache.
- Object storage: user-provided S3-compatible (COS later); tests use local filesystem adapter.
- Models: external vision + embedding HTTP APIs only; never run LLMs on the CVM.
- Auth: humans email/password; Agents `Authorization: Bearer <apiKey>`; keys stored hashed only.
- MVP非目标: 社交动态流、原生 App、开放 Agent 市场、多租户计费、自托管大模型、仿虾聊开放 Agent 社交网络.
- Permissions: personal library = owner + their API keys; shared albums by role; 403 must not leak existence.
- Upload pipeline failure: keep original bytes, mark `failed`, allow retry; Agent metadata override may re-embed.
- Deploy: Nginx + HTTPS on Singapore CVM; public access required for MVP acceptance #5.
- Prefer smaller focused files; no TBD/TODO/"implement later" in code delivered by a task.

---

## File Structure

```
/
├── package.json
├── tsconfig.base.json
├── docker-compose.yml
├── .env.example
├── .gitignore
├── README.md
├── apps/
│   ├── api/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── app.ts
│   │   │   ├── config.ts
│   │   │   ├── db/client.ts
│   │   │   ├── db/migrate.ts
│   │   │   ├── db/migrations/001_init.sql
│   │   │   ├── db/migrations/002_pgvector.sql
│   │   │   ├── auth/password.ts
│   │   │   ├── auth/plugin.ts
│   │   │   ├── auth/apiKeys.ts
│   │   │   ├── auth/apiKeyRoutes.ts
│   │   │   ├── storage/types.ts
│   │   │   ├── storage/local.ts
│   │   │   ├── storage/s3.ts
│   │   │   ├── storage/index.ts
│   │   │   ├── ai/types.ts
│   │   │   ├── ai/mockVision.ts
│   │   │   ├── ai/mockEmbed.ts
│   │   │   ├── ai/httpVision.ts
│   │   │   ├── ai/httpEmbed.ts
│   │   │   ├── ai/index.ts
│   │   │   ├── users/repo.ts
│   │   │   ├── users/service.ts
│   │   │   ├── users/routes.ts
│   │   │   ├── photos/repo.ts
│   │   │   ├── photos/service.ts
│   │   │   ├── photos/routes.ts
│   │   │   ├── photos/search.ts
│   │   │   ├── albums/repo.ts
│   │   │   ├── albums/service.ts
│   │   │   ├── albums/routes.ts
│   │   │   ├── pipeline/jobs.ts
│   │   │   ├── pipeline/worker.ts
│   │   │   ├── pipeline/exif.ts
│   │   │   └── pipeline/thumbnails.ts
│   │   └── test/
│   │       ├── helpers.ts
│   │       ├── health.test.ts
│   │       ├── migrate.test.ts
│   │       ├── storage.test.ts
│   │       ├── ai.test.ts
│   │       ├── auth.test.ts
│   │       ├── apiKeys.test.ts
│   │       ├── photos.test.ts
│   │       ├── pipeline.test.ts
│   │       ├── photoPatch.test.ts
│   │       ├── search.test.ts
│   │       ├── albums.test.ts
│   │       └── mvpAcceptance.test.ts
│   └── web/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── api/client.ts
│           ├── auth/AuthContext.tsx
│           ├── components/Layout.tsx
│           ├── components/PhotoGrid.tsx
│           ├── components/UploadButton.tsx
│           └── pages/{Login,Register,Library,PhotoDetail,Search,Albums,AlbumDetail,JoinAlbum,ApiKeys}Page.tsx
├── packages/shared/src/{index,auth,photo,album}.ts
└── deploy/{nginx.conf.example,CVM.md,album-api.service}
```

---

### Task 1: Monorepo scaffold + shared types + health check

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `docker-compose.yml`, `README.md`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/{index,auth,photo,album}.ts`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/vitest.config.ts`, `apps/api/src/{config,app,index}.ts`, `apps/api/test/health.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `buildApp(deps): Promise<FastifyInstance>`; shared types `PhotoStatus`, `AlbumRole`, `PhotoDto`, `AlbumDto`, `UserPublic`, `ApiKeyPublic`, `CreateApiKeyResponse`, `PhotoSearchRequest`, `PatchPhotoRequest`, `JoinAlbumResponse`; scripts `npm run test -w @album/api`

- [ ] **Step 1: Write the failing health test and scaffold files that the test imports**

Create root `package.json`:
```json
{
  "name": "ai-native-photo-album",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "test": "npm run test -w @album/api",
    "dev:api": "npm run dev -w @album/api",
    "dev:web": "npm run dev -w @album/web",
    "build": "npm run build -w @album/shared && npm run build -w @album/api && npm run build -w @album/web"
  },
  "engines": { "node": ">=20" }
}
```

Create `tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

Create `.gitignore`:
```
node_modules/
dist/
.env
coverage/
data/
*.log
.DS_Store
```

Create `.env.example`:
```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://album:album@localhost:5432/album
JWT_SECRET=change-me-in-prod
STORAGE_DRIVER=local
LOCAL_STORAGE_ROOT=./data/storage
S3_ENDPOINT=
S3_REGION=ap-singapore
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
VISION_PROVIDER=mock
EMBED_PROVIDER=mock
VISION_API_URL=
VISION_API_KEY=
EMBED_API_URL=
EMBED_API_KEY=
EMBED_DIMENSIONS=1536
CORS_ORIGIN=http://localhost:5173
```

Create `packages/shared/package.json`:
```json
{
  "name": "@album/shared",
  "version": "0.0.1",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "devDependencies": { "typescript": "^5.6.0" }
}
```

Create `packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

Create `packages/shared/src/auth.ts`:
```typescript
export type UserPublic = { id: string; email: string; createdAt: string };
export type ApiKeyPublic = {
  id: string; name: string; prefix: string;
  lastUsedAt: string | null; createdAt: string; revokedAt: string | null;
};
export type CreateApiKeyResponse = ApiKeyPublic & { token: string };
```

Create `packages/shared/src/photo.ts`:
```typescript
export type PhotoStatus = 'processing' | 'ready' | 'failed';
export type PhotoDto = {
  id: string; ownerUserId: string; albumId: string | null;
  originalKey: string; thumbKey: string | null; thumbUrl: string | null;
  takenAt: string | null; locationText: string | null;
  latitude: number | null; longitude: number | null;
  description: string | null; tags: string[]; sourceLabel: string;
  status: PhotoStatus; createdAt: string; updatedAt: string;
};
export type PhotoSearchRequest = {
  query?: string; mode?: 'semantic' | 'keyword' | 'hybrid';
  limit?: number; albumId?: string;
};
export type PhotoSearchResponse = { items: Array<PhotoDto & { score?: number }> };
export type PatchPhotoRequest = {
  description?: string; tags?: string[]; takenAt?: string | null;
  locationText?: string | null; latitude?: number | null; longitude?: number | null;
  reembed?: boolean;
};
```

Create `packages/shared/src/album.ts`:
```typescript
export type AlbumRole = 'owner' | 'uploader' | 'viewer';
export type AlbumDto = {
  id: string; title: string; ownerUserId: string; shareSlug: string;
  defaultRole: Exclude<AlbumRole, 'owner'>; expiresAt: string | null;
  lockedReadOnly: boolean; createdAt: string;
};
export type CreateAlbumRequest = {
  title: string; passphrase: string;
  defaultRole?: 'uploader' | 'viewer'; expiresAt?: string | null;
};
export type JoinAlbumRequest = { passphrase: string };
export type JoinAlbumResponse = {
  album: AlbumDto; role: AlbumRole; sessionToken: string; expiresAt: string;
};
```

Create `packages/shared/src/index.ts`:
```typescript
export * from './auth.js';
export * from './photo.js';
export * from './album.js';
```

Create `apps/api/package.json`:
```json
{
  "name": "@album/api",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "migrate": "tsx src/db/migrate.ts"
  },
  "dependencies": {
    "@album/shared": "0.0.1",
    "fastify": "^5.0.0",
    "@fastify/cors": "^10.0.0",
    "@fastify/jwt": "^9.0.0",
    "@fastify/multipart": "^9.0.0",
    "fastify-plugin": "^5.0.0",
    "bcryptjs": "^2.4.3",
    "pg": "^8.13.0",
    "sharp": "^0.33.5",
    "exifr": "^7.1.3",
    "zod": "^3.23.0",
    "dotenv": "^16.4.0",
    "@aws-sdk/client-s3": "^3.650.0",
    "@aws-sdk/s3-request-presigner": "^3.650.0",
    "form-data": "^4.0.0"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

Create `apps/api/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

Create `apps/api/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', fileParallelism: false, hookTimeout: 60_000, testTimeout: 60_000 },
});
```

Create `apps/api/src/config.ts`:
```typescript
import 'dotenv/config';
export type AppConfig = {
  port: number; databaseUrl: string; jwtSecret: string;
  storageDriver: 'local' | 's3'; localStorageRoot: string;
  s3: { endpoint?: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
  visionProvider: 'mock' | 'http'; embedProvider: 'mock' | 'http';
  visionApiUrl: string; visionApiKey: string; embedApiUrl: string; embedApiKey: string;
  embedDimensions: number; corsOrigin: string;
};
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://album:album@localhost:5432/album',
    jwtSecret: env.JWT_SECRET ?? 'dev-secret',
    storageDriver: (env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
    localStorageRoot: env.LOCAL_STORAGE_ROOT ?? './data/storage',
    s3: {
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION ?? 'ap-singapore',
      bucket: env.S3_BUCKET ?? '',
      accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
    },
    visionProvider: (env.VISION_PROVIDER ?? 'mock') as 'mock' | 'http',
    embedProvider: (env.EMBED_PROVIDER ?? 'mock') as 'mock' | 'http',
    visionApiUrl: env.VISION_API_URL ?? '',
    visionApiKey: env.VISION_API_KEY ?? '',
    embedApiUrl: env.EMBED_API_URL ?? '',
    embedApiKey: env.EMBED_API_KEY ?? '',
    embedDimensions: Number(env.EMBED_DIMENSIONS ?? 1536),
    corsOrigin: env.CORS_ORIGIN ?? 'http://localhost:5173',
  };
}
```

Create `apps/api/src/app.ts` (minimal for this task):
```typescript
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppConfig } from './config.js';
export type AppDeps = { config: AppConfig };
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: deps.config.corsOrigin });
  app.get('/health', async () => ({ ok: true, service: 'album-api' }));
  return app;
}
```

Create `apps/api/src/index.ts`:
```typescript
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
const config = loadConfig();
const app = await buildApp({ config });
await app.listen({ port: config.port, host: '0.0.0.0' });
```

Create `apps/api/test/health.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
describe('GET /health', () => {
  it('returns ok', async () => {
    const app = await buildApp({ config: loadConfig() });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'album-api' });
    await app.close();
  });
});
```

Create `docker-compose.yml`:
```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: album
      POSTGRES_PASSWORD: album
      POSTGRES_DB: album
    ports: ["5432:5432"]
    volumes: [album_pg:/var/lib/postgresql/data]
volumes:
  album_pg:
```

Create `README.md`:
```markdown
# AI Native Photo Album

Monorepo: `apps/api` (Fastify), `apps/web` (React), `packages/shared`.

## Dev

```bash
cp .env.example .env
docker compose up -d
npm install
npm run build -w @album/shared
npm run migrate -w @album/api
npm run dev:api
npm run dev:web
```

Production: see `deploy/CVM.md`.
```

- [ ] **Step 2: Run health test to verify it fails before install/build wiring is complete**

Run: `cd /workspace && npm run test -w @album/api -- test/health.test.ts`
Expected: FAIL (workspace/deps missing) OR after Step 3 setup, proceed to install.

- [ ] **Step 3: Install and make the health test pass**

Run:
```bash
cd /workspace && npm install && npm run build -w @album/shared && npm run test -w @album/api -- test/health.test.ts
```
Expected: PASS (`GET /health` returns ok)

- [ ] **Step 4: Commit**

```bash
git add package.json tsconfig.base.json .gitignore .env.example docker-compose.yml README.md packages/shared apps/api
git commit -m "chore: scaffold monorepo with shared types and API health check"
```

---

### Task 2: Database client, migrations, and core schema

**Files:**
- Create: `apps/api/src/db/client.ts`, `apps/api/src/db/migrate.ts`, `apps/api/src/db/migrations/001_init.sql`, `apps/api/src/db/migrations/002_pgvector.sql`
- Create: `apps/api/test/helpers.ts`, `apps/api/test/migrate.test.ts`

**Interfaces:**
- Consumes: `AppConfig.databaseUrl`
- Produces: `createPool(databaseUrl: string): Pool`; `migrate(pool: Pool): Promise<void>`; tables `users`, `api_keys`, `albums`, `album_sessions`, `photos`, `jobs`, `schema_migrations`; `photos.embedding vector(1536)`

- [ ] **Step 1: Write the failing migration test**

```typescript
// apps/api/test/migrate.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';

const config = loadConfig();

describe('migrate', () => {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  beforeAll(async () => {
    await pool.query(`
      DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
    `);
  });
  afterAll(async () => { await pool.end(); });
  it('creates core tables', async () => {
    await migrate(pool);
    const { rows } = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`);
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(expect.arrayContaining([
      'users', 'api_keys', 'albums', 'album_sessions', 'photos', 'jobs', 'schema_migrations',
    ]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose up -d && sleep 3 && npm run test -w @album/api -- test/migrate.test.ts`
Expected: FAIL with `Cannot find module '../src/db/migrate.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/db/client.ts
import pg from 'pg';
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}
export type { Pool, PoolClient } from 'pg';
```

```sql
-- apps/api/src/db/migrations/001_init.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL,
  last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys(prefix);
CREATE TABLE IF NOT EXISTS albums (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, share_slug TEXT NOT NULL UNIQUE,
  passphrase_hash TEXT NOT NULL,
  default_role TEXT NOT NULL CHECK (default_role IN ('uploader', 'viewer')),
  expires_at TIMESTAMPTZ, locked_read_only BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS album_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'uploader', 'viewer')),
  token_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS album_sessions_album_id_idx ON album_sessions(album_id);
CREATE TABLE IF NOT EXISTS photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  album_id UUID REFERENCES albums(id) ON DELETE SET NULL,
  original_key TEXT NOT NULL, thumb_key TEXT,
  taken_at TIMESTAMPTZ, location_text TEXT,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  description TEXT, tags TEXT[] NOT NULL DEFAULT '{}',
  source_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed')),
  fail_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photos_owner_user_id_idx ON photos(owner_user_id);
CREATE INDEX IF NOT EXISTS photos_album_id_idx ON photos(album_id);
CREATE INDEX IF NOT EXISTS photos_status_idx ON photos(status);
CREATE INDEX IF NOT EXISTS photos_tags_gin ON photos USING GIN (tags);
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  photo_id UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts INT NOT NULL DEFAULT 0, last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);
```

```sql
-- apps/api/src/db/migrations/002_pgvector.sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX IF NOT EXISTS photos_embedding_ivfflat
  ON photos USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

```typescript
// apps/api/src/db/migrate.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { createPool } from './client.js';
import { loadConfig } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
  const dir = path.join(__dirname, 'migrations');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
    if (exists.rowCount) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirect) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await migrate(pool);
  await pool.end();
  console.log('migrations applied');
}
```

```typescript
// apps/api/test/helpers.ts (minimal for now; expand in Task 5)
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';

export async function resetDb(pool: pg.Pool): Promise<void> {
  await pool.query(`
    DROP SCHEMA public CASCADE; CREATE SCHEMA public;
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  `);
  await migrate(pool);
}

export function testPool(): pg.Pool {
  return new pg.Pool({ connectionString: loadConfig().databaseUrl });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @album/api -- test/migrate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db apps/api/test/migrate.test.ts apps/api/test/helpers.ts
git commit -m "feat(api): add Postgres migrations for users, photos, albums, jobs"
```

---

### Task 3: Storage interface — local FS + S3-compatible

**Files:**
- Create: `apps/api/src/storage/{types,local,s3,index}.ts`, `apps/api/test/storage.test.ts`

**Interfaces:**
- Consumes: `AppConfig.storageDriver`, `localStorageRoot`, `s3.*`
- Produces:
```typescript
export interface Storage {
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<{ body: Buffer; contentType: string }>;
  deleteObject(key: string): Promise<void>;
  getSignedUrl(key: string, expiresSeconds: number): Promise<string>;
  publicUrl(key: string): string;
}
export function createStorage(config: AppConfig): Storage;
export class LocalFsStorage implements Storage;
export class S3CompatibleStorage implements Storage;
```

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/storage.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalFsStorage } from '../src/storage/local.js';

describe('LocalFsStorage', () => {
  let root: string;
  let storage: LocalFsStorage;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'album-st-'));
    storage = new LocalFsStorage(root, 'http://localhost:3000/files');
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  it('puts and gets an object', async () => {
    const body = Buffer.from('hello-photo');
    await storage.putObject('u1/orig.jpg', body, 'image/jpeg');
    const got = await storage.getObject('u1/orig.jpg');
    expect(got.contentType).toBe('image/jpeg');
    expect(got.body.equals(body)).toBe(true);
  });
  it('returns a public URL path', () => {
    expect(storage.publicUrl('u1/orig.jpg')).toBe('http://localhost:3000/files/u1/orig.jpg');
  });
  it('deletes an object', async () => {
    await storage.putObject('u1/x.jpg', Buffer.from('x'), 'image/jpeg');
    await storage.deleteObject('u1/x.jpg');
    await expect(storage.getObject('u1/x.jpg')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @album/api -- test/storage.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/storage/types.ts
export interface Storage {
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<{ body: Buffer; contentType: string }>;
  deleteObject(key: string): Promise<void>;
  getSignedUrl(key: string, expiresSeconds: number): Promise<string>;
  publicUrl(key: string): string;
}
```

```typescript
// apps/api/src/storage/local.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Storage } from './types.js';
type Meta = { contentType: string };
export class LocalFsStorage implements Storage {
  constructor(private readonly root: string, private readonly publicBaseUrl = 'http://localhost:3000/files') {}
  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root))) throw new Error('invalid storage key');
    return full;
  }
  private metaPath(key: string): string { return `${this.resolve(key)}.meta.json`; }
  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
    await fs.writeFile(this.metaPath(key), JSON.stringify({ contentType } satisfies Meta));
  }
  async getObject(key: string): Promise<{ body: Buffer; contentType: string }> {
    const body = await fs.readFile(this.resolve(key));
    const meta = JSON.parse(await fs.readFile(this.metaPath(key), 'utf8')) as Meta;
    return { body, contentType: meta.contentType };
  }
  async deleteObject(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
    await fs.rm(this.metaPath(key), { force: true });
  }
  async getSignedUrl(key: string, _expiresSeconds: number): Promise<string> { return this.publicUrl(key); }
  publicUrl(key: string): string {
    return `${this.publicBaseUrl.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
}
```

```typescript
// apps/api/src/storage/s3.ts
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Storage } from './types.js';
export type S3StorageOptions = {
  endpoint?: string; region: string; bucket: string;
  accessKeyId: string; secretAccessKey: string; publicBaseUrl?: string;
};
export class S3CompatibleStorage implements Storage {
  private client: S3Client;
  constructor(private readonly opts: S3StorageOptions) {
    this.client = new S3Client({
      region: opts.region, endpoint: opts.endpoint, forcePathStyle: Boolean(opts.endpoint),
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }
  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async getObject(key: string): Promise<{ body: Buffer; contentType: string }> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    const bytes = await out.Body!.transformToByteArray();
    return { body: Buffer.from(bytes), contentType: out.ContentType ?? 'application/octet-stream' };
  }
  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }
  async getSignedUrl(key: string, expiresSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }), { expiresIn: expiresSeconds });
  }
  publicUrl(key: string): string {
    if (this.opts.publicBaseUrl) return `${this.opts.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    return `s3://${this.opts.bucket}/${key}`;
  }
}
```

```typescript
// apps/api/src/storage/index.ts
import type { AppConfig } from '../config.js';
import type { Storage } from './types.js';
import { LocalFsStorage } from './local.js';
import { S3CompatibleStorage } from './s3.js';
export type { Storage } from './types.js';
export { LocalFsStorage } from './local.js';
export { S3CompatibleStorage } from './s3.js';
export function createStorage(config: AppConfig): Storage {
  if (config.storageDriver === 's3') {
    return new S3CompatibleStorage({
      endpoint: config.s3.endpoint, region: config.s3.region, bucket: config.s3.bucket,
      accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey,
    });
  }
  return new LocalFsStorage(config.localStorageRoot);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @album/api -- test/storage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/storage apps/api/test/storage.test.ts
git commit -m "feat(api): add local and S3-compatible storage adapters"
```

---

### Task 4: Vision + Embed provider interfaces (mock + HTTP)

**Files:**
- Create: `apps/api/src/ai/{types,mockVision,mockEmbed,httpVision,httpEmbed,index}.ts`, `apps/api/test/ai.test.ts`

**Interfaces:**
- Consumes: `AppConfig.vision*`, `embed*`
- Produces:
```typescript
export type VisionResult = { description: string; tags: string[] };
export interface VisionProvider { describe(imageBytes: Buffer, mimeType: string): Promise<VisionResult>; }
export interface EmbedProvider { embedText(text: string): Promise<number[]>; readonly dimensions: number; }
export function createVisionProvider(config: AppConfig): VisionProvider;
export function createEmbedProvider(config: AppConfig): EmbedProvider;
```

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/ai.test.ts
import { describe, it, expect } from 'vitest';
import { MockVisionProvider } from '../src/ai/mockVision.js';
import { MockEmbedProvider } from '../src/ai/mockEmbed.js';

describe('MockVisionProvider', () => {
  it('returns deterministic description and tags', async () => {
    const r = await new MockVisionProvider().describe(Buffer.from('fake'), 'image/jpeg');
    expect(r.description.length).toBeGreaterThan(0);
    expect(r.tags.length).toBeGreaterThan(0);
  });
});

describe('MockEmbedProvider', () => {
  it('returns fixed-dimension deterministic vectors', async () => {
    const e = new MockEmbedProvider(8);
    const a = await e.embedText('a cat on a beach');
    const b = await e.embedText('a cat on a beach');
    const c = await e.embedText('totally different');
    expect(a).toHaveLength(8);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @album/api -- test/ai.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/ai/types.ts
export type VisionResult = { description: string; tags: string[] };
export interface VisionProvider { describe(imageBytes: Buffer, mimeType: string): Promise<VisionResult>; }
export interface EmbedProvider { embedText(text: string): Promise<number[]>; readonly dimensions: number; }
```

```typescript
// apps/api/src/ai/mockVision.ts
import type { VisionProvider, VisionResult } from './types.js';
export class MockVisionProvider implements VisionProvider {
  async describe(_imageBytes: Buffer, _mimeType: string): Promise<VisionResult> {
    return { description: 'A mock photo of everyday life under soft light', tags: ['mock', 'photo', 'everyday'] };
  }
}
```

```typescript
// apps/api/src/ai/mockEmbed.ts
import { createHash } from 'node:crypto';
import type { EmbedProvider } from './types.js';
export class MockEmbedProvider implements EmbedProvider {
  constructor(public readonly dimensions: number) {}
  async embedText(text: string): Promise<number[]> {
    const hash = createHash('sha256').update(text).digest();
    const out = new Array<number>(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) out[i] = ((hash[i % hash.length] / 255) * 2) - 1;
    const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
    return out.map((x) => x / norm);
  }
}
```

```typescript
// apps/api/src/ai/httpVision.ts
import type { VisionProvider, VisionResult } from './types.js';
export class HttpVisionProvider implements VisionProvider {
  constructor(private readonly opts: { apiUrl: string; apiKey: string }) {}
  async describe(imageBytes: Buffer, mimeType: string): Promise<VisionResult> {
    const dataUrl = `data:${mimeType};base64,${imageBytes.toString('base64')}`;
    const res = await fetch(this.opts.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this photo in one sentence and list 3-8 short tags. Reply JSON: {"description": string, "tags": string[]}' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error(`vision HTTP ${res.status}: ${await res.text()}`);
    const payload = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const parsed = JSON.parse(payload.choices[0].message.content) as VisionResult;
    return { description: String(parsed.description ?? ''), tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [] };
  }
}
```

```typescript
// apps/api/src/ai/httpEmbed.ts
import type { EmbedProvider } from './types.js';
export class HttpEmbedProvider implements EmbedProvider {
  constructor(private readonly opts: { apiUrl: string; apiKey: string; dimensions: number; model?: string }) {}
  get dimensions(): number { return this.opts.dimensions; }
  async embedText(text: string): Promise<number[]> {
    const res = await fetch(this.opts.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.opts.model ?? 'text-embedding-3-small', input: text, dimensions: this.opts.dimensions }),
    });
    if (!res.ok) throw new Error(`embed HTTP ${res.status}: ${await res.text()}`);
    const payload = (await res.json()) as { data: Array<{ embedding: number[] }> };
    const vec = payload.data[0]?.embedding;
    if (!vec || vec.length !== this.opts.dimensions) throw new Error('unexpected embedding dimensions');
    return vec;
  }
}
```

```typescript
// apps/api/src/ai/index.ts
import type { AppConfig } from '../config.js';
import type { EmbedProvider, VisionProvider } from './types.js';
import { MockVisionProvider } from './mockVision.js';
import { MockEmbedProvider } from './mockEmbed.js';
import { HttpVisionProvider } from './httpVision.js';
import { HttpEmbedProvider } from './httpEmbed.js';
export type { VisionProvider, EmbedProvider, VisionResult } from './types.js';
export { MockVisionProvider } from './mockVision.js';
export { MockEmbedProvider } from './mockEmbed.js';
export function createVisionProvider(config: AppConfig): VisionProvider {
  if (config.visionProvider === 'http') return new HttpVisionProvider({ apiUrl: config.visionApiUrl, apiKey: config.visionApiKey });
  return new MockVisionProvider();
}
export function createEmbedProvider(config: AppConfig): EmbedProvider {
  if (config.embedProvider === 'http') {
    return new HttpEmbedProvider({ apiUrl: config.embedApiUrl, apiKey: config.embedApiKey, dimensions: config.embedDimensions });
  }
  return new MockEmbedProvider(config.embedDimensions);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @album/api -- test/ai.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ai apps/api/test/ai.test.ts
git commit -m "feat(api): add mock and HTTP vision/embed providers"
```

---

### Task 5: User register / login (JWT) + auth plugin

**Files:**
- Create: `apps/api/src/auth/password.ts`, `apps/api/src/auth/plugin.ts`, `apps/api/src/users/{repo,service,routes}.ts`, `apps/api/test/auth.test.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/test/helpers.ts`

**Interfaces:**
- Consumes: `createPool`, `migrate`, `AppConfig.jwtSecret`, Storage/Vision/Embed factories
- Produces: `POST /auth/register`, `POST /auth/login`, `GET /auth/me`; `request.auth: { userId: string; via: 'jwt' | 'api_key'; keyId?: string }`; `app.authenticate(req)`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/auth.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { withTestApp, type TestContext } from './helpers.js';

describe('auth', () => {
  let ctx: TestContext;
  afterEach(async () => { await ctx.app.close(); await ctx.pool.end(); });

  it('registers and returns a JWT', async () => {
    ctx = await withTestApp();
    const res = await ctx.app.inject({
      method: 'POST', url: '/auth/register',
      payload: { email: 'a@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.email).toBe('a@example.com');
    expect(typeof res.json().token).toBe('string');
  });

  it('logs in with email/password', async () => {
    ctx = await withTestApp();
    await ctx.app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'b@example.com', password: 'password123' } });
    const res = await ctx.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'b@example.com', password: 'password123' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  it('rejects wrong password', async () => {
    ctx = await withTestApp();
    await ctx.app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'c@example.com', password: 'password123' } });
    const res = await ctx.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'c@example.com', password: 'nope' } });
    expect(res.statusCode).toBe(401);
  });

  it('returns current user from JWT', async () => {
    ctx = await withTestApp();
    const reg = await ctx.app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'd@example.com', password: 'password123' } });
    const me = await ctx.app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${reg.json().token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('d@example.com');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @album/api -- test/auth.test.ts`
Expected: FAIL (`withTestApp` / routes missing)

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/auth/password.ts
import bcrypt from 'bcryptjs';
export async function hashPassword(password: string): Promise<string> { return bcrypt.hash(password, 10); }
export async function verifyPassword(password: string, hash: string): Promise<boolean> { return bcrypt.compare(password, hash); }
```

```typescript
// apps/api/src/users/repo.ts
import type pg from 'pg';
export type UserRow = { id: string; email: string; password_hash: string; created_at: Date };
export class UsersRepo {
  constructor(private readonly pool: pg.Pool) {}
  async create(email: string, passwordHash: string): Promise<UserRow> {
    const { rows } = await this.pool.query<UserRow>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *`,
      [email.toLowerCase(), passwordHash],
    );
    return rows[0];
  }
  async findByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
    return rows[0] ?? null;
  }
  async findById(id: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }
}
```

```typescript
// apps/api/src/users/service.ts
import type { UserPublic } from '@album/shared';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { UsersRepo, type UserRow } from './repo.js';
export function toUserPublic(row: UserRow): UserPublic {
  return { id: row.id, email: row.email, createdAt: row.created_at.toISOString() };
}
export class UsersService {
  constructor(private readonly repo: UsersRepo) {}
  async register(email: string, password: string): Promise<UserPublic> {
    if (!email.includes('@') || password.length < 8) throw Object.assign(new Error('invalid email or password'), { statusCode: 400 });
    if (await this.repo.findByEmail(email)) throw Object.assign(new Error('email already registered'), { statusCode: 409 });
    return toUserPublic(await this.repo.create(email, await hashPassword(password)));
  }
  async login(email: string, password: string): Promise<UserPublic> {
    const row = await this.repo.findByEmail(email);
    if (!row || !(await verifyPassword(password, row.password_hash))) throw Object.assign(new Error('invalid credentials'), { statusCode: 401 });
    return toUserPublic(row);
  }
  async getById(id: string): Promise<UserPublic | null> {
    const row = await this.repo.findById(id);
    return row ? toUserPublic(row) : null;
  }
}
```

```typescript
// apps/api/src/auth/plugin.ts
import fp from 'fastify-plugin';
import fjwt from '@fastify/jwt';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { createHash, timingSafeEqual } from 'node:crypto';

export type AuthContext = { userId: string; via: 'jwt' | 'api_key'; keyId?: string };
declare module 'fastify' {
  interface FastifyInstance { authenticate: (req: FastifyRequest) => Promise<void>; }
  interface FastifyRequest { auth: AuthContext; }
}
declare module '@fastify/jwt' {
  interface FastifyJWT { payload: { sub: string }; user: { sub: string }; }
}
function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }
function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex'); const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
export const authPlugin: FastifyPluginAsync<{ jwtSecret: string; pool: pg.Pool }> = fp(async (app, opts) => {
  await app.register(fjwt, { secret: opts.jwtSecret });
  app.decorate('authenticate', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    const token = header.slice(7).trim();
    if (token.startsWith('alk_')) {
      const parts = token.split('_');
      if (parts.length < 3) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
      const prefix = parts[1];
      const { rows } = await opts.pool.query<{ id: string; user_id: string; key_hash: string; revoked_at: Date | null }>(
        `SELECT id, user_id, key_hash, revoked_at FROM api_keys WHERE prefix = $1`, [prefix],
      );
      const row = rows.find((r) => !r.revoked_at && safeEqualHex(r.key_hash, sha256(token)));
      if (!row) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
      await opts.pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]);
      req.auth = { userId: row.user_id, via: 'api_key', keyId: row.id };
      return;
    }
    try {
      const payload = await req.jwtVerify<{ sub: string }>();
      req.auth = { userId: payload.sub, via: 'jwt' };
    } catch {
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    }
  });
});
```

```typescript
// apps/api/src/users/routes.ts
import type { FastifyInstance } from 'fastify';
import { UsersService } from './service.js';
export async function registerUserRoutes(app: FastifyInstance, users: UsersService) {
  app.post('/auth/register', async (req, reply) => {
    const body = req.body as { email?: string; password?: string };
    try {
      const user = await users.register(String(body.email ?? ''), String(body.password ?? ''));
      const token = await reply.jwtSign({ sub: user.id });
      return reply.code(201).send({ user, token });
    } catch (err) {
      const e = err as { statusCode?: number; message: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });
  app.post('/auth/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string };
    try {
      const user = await users.login(String(body.email ?? ''), String(body.password ?? ''));
      const token = await reply.jwtSign({ sub: user.id });
      return reply.send({ user, token });
    } catch (err) {
      const e = err as { statusCode?: number; message: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });
  app.get('/auth/me', async (req, reply) => {
    try {
      await app.authenticate(req);
      const user = await users.getById(req.auth.userId);
      if (!user) return reply.code(401).send({ error: 'unauthorized' });
      return { user };
    } catch (err) {
      const e = err as { statusCode?: number; message: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });
}
```

Replace `apps/api/src/app.ts` with dependency-injected version:

```typescript
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type pg from 'pg';
import type { AppConfig } from './config.js';
import type { Storage } from './storage/types.js';
import type { VisionProvider, EmbedProvider } from './ai/types.js';
import { createStorage } from './storage/index.js';
import { createVisionProvider, createEmbedProvider } from './ai/index.js';
import { createPool } from './db/client.js';
import { authPlugin } from './auth/plugin.js';
import { UsersRepo } from './users/repo.js';
import { UsersService } from './users/service.js';
import { registerUserRoutes } from './users/routes.js';

export type AppDeps = {
  config: AppConfig; pool?: pg.Pool; storage?: Storage;
  vision?: VisionProvider; embed?: EmbedProvider;
};

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const pool = deps.pool ?? createPool(deps.config.databaseUrl);
  const storage = deps.storage ?? createStorage(deps.config);
  const vision = deps.vision ?? createVisionProvider(deps.config);
  const embed = deps.embed ?? createEmbedProvider(deps.config);
  await app.register(cors, { origin: deps.config.corsOrigin });
  await app.register(authPlugin, { jwtSecret: deps.config.jwtSecret, pool });
  app.decorate('pool', pool);
  app.decorate('storage', storage);
  app.decorate('vision', vision);
  app.decorate('embed', embed);
  app.get('/health', async () => ({ ok: true, service: 'album-api' }));
  await registerUserRoutes(app, new UsersService(new UsersRepo(pool)));
  app.addHook('onClose', async () => { if (!deps.pool) await pool.end(); });
  return app;
}
```

Expand `apps/api/test/helpers.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type AppDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { LocalFsStorage } from '../src/storage/local.js';
import { MockVisionProvider } from '../src/ai/mockVision.js';
import { MockEmbedProvider } from '../src/ai/mockEmbed.js';

export async function resetDb(pool: pg.Pool): Promise<void> {
  await pool.query(`
    DROP SCHEMA public CASCADE; CREATE SCHEMA public;
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  `);
  await migrate(pool);
}

export type TestContext = { app: FastifyInstance; pool: pg.Pool; storageRoot: string };

export async function withTestApp(overrides: Partial<AppDeps> = {}): Promise<TestContext> {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  await resetDb(pool);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-storage-'));
  const app = await buildApp({
    config, pool,
    storage: new LocalFsStorage(storageRoot, 'http://localhost:3000/files'),
    vision: new MockVisionProvider(),
    embed: new MockEmbedProvider(config.embedDimensions),
    ...overrides,
  });
  return { app, pool, storageRoot };
}

export async function registerAndLogin(app: FastifyInstance, email: string, password = 'password123') {
  const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password } });
  const body = res.json();
  return { token: body.token as string, userId: body.user.id as string };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @album/api -- test/auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth apps/api/src/users apps/api/src/app.ts apps/api/test/auth.test.ts apps/api/test/helpers.ts
git commit -m "feat(api): email/password register login and JWT auth plugin"
```

---

### Task 6: API Key create / list / revoke

**Files:**
- Create: `apps/api/src/auth/apiKeys.ts`, `apps/api/src/auth/apiKeyRoutes.ts`, `apps/api/test/apiKeys.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `app.authenticate`, users table
- Produces: `POST /api-keys`, `GET /api-keys`, `DELETE /api-keys/:id`; token format `alk_<8charPrefix>_<32byteHexSecret>`; `ApiKeysService.create/list/revoke`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/apiKeys.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { withTestApp, type TestContext, registerAndLogin } from './helpers.js';

describe('api keys', () => {
  let ctx: TestContext;
  afterEach(async () => { await ctx.app.close(); await ctx.pool.end(); });

  it('creates a key and authenticates with it', async () => {
    ctx = await withTestApp();
    const { token } = await registerAndLogin(ctx.app, 'agent@example.com');
    const created = await ctx.app.inject({
      method: 'POST', url: '/api-keys',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'laptop-agent' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().token.startsWith('alk_')).toBe(true);
    const me = await ctx.app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${created.json().token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('agent@example.com');
  });

  it('revokes a key so it stops working', async () => {
    ctx = await withTestApp();
    const { token } = await registerAndLogin(ctx.app, 'agent2@example.com');
    const created = await ctx.app.inject({
      method: 'POST', url: '/api-keys',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'temp' },
    });
    const apiToken = created.json().token;
    const del = await ctx.app.inject({
      method: 'DELETE', url: `/api-keys/${created.json().id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(200);
    const me = await ctx.app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${apiToken}` },
    });
    expect(me.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @album/api -- test/apiKeys.test.ts`
Expected: FAIL (404 on `/api-keys`)

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/auth/apiKeys.ts
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { ApiKeyPublic, CreateApiKeyResponse } from '@album/shared';
function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }
export function mintApiKeyToken(): { token: string; prefix: string; keyHash: string } {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const token = `alk_${prefix}_${secret}`;
  return { token, prefix, keyHash: sha256(token) };
}
type Row = { id: string; name: string; prefix: string; last_used_at: Date | null; created_at: Date; revoked_at: Date | null };
function toPublic(row: Row): ApiKeyPublic {
  return {
    id: row.id, name: row.name, prefix: row.prefix,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}
export class ApiKeysService {
  constructor(private readonly pool: pg.Pool) {}
  async create(userId: string, name: string): Promise<CreateApiKeyResponse> {
    const { token, prefix, keyHash } = mintApiKeyToken();
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1,$2,$3,$4)
       RETURNING id, name, prefix, last_used_at, created_at, revoked_at`,
      [userId, name, prefix, keyHash],
    );
    return { ...toPublic(rows[0]), token };
  }
  async list(userId: string): Promise<ApiKeyPublic[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT id, name, prefix, last_used_at, created_at, revoked_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(toPublic);
  }
  async revoke(userId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [id, userId],
    );
    return (rowCount ?? 0) > 0;
  }
}
```

```typescript
// apps/api/src/auth/apiKeyRoutes.ts
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { ApiKeysService } from './apiKeys.js';
export async function registerApiKeyRoutes(app: FastifyInstance, pool: pg.Pool) {
  const keys = new ApiKeysService(pool);
  app.post('/api-keys', async (req, reply) => {
    await app.authenticate(req);
    const name = String((req.body as { name?: string }).name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    return reply.code(201).send(await keys.create(req.auth.userId, name));
  });
  app.get('/api-keys', async (req) => {
    await app.authenticate(req);
    return { items: await keys.list(req.auth.userId) };
  });
  app.delete('/api-keys/:id', async (req, reply) => {
    await app.authenticate(req);
    const ok = await keys.revoke(req.auth.userId, (req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });
}
```

In `buildApp`, after user routes: `await registerApiKeyRoutes(app, pool);`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @album/api -- test/apiKeys.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/apiKeys.ts apps/api/src/auth/apiKeyRoutes.ts apps/api/src/app.ts apps/api/test/apiKeys.test.ts
git commit -m "feat(api): API key create list revoke with Bearer auth"
```

---

### Task 7: Photo upload to personal library + list/get/delete

**Files:**
- Create: `apps/api/src/photos/{repo,service,routes}.ts`, `apps/api/src/pipeline/{jobs,thumbnails}.ts`, `apps/api/test/photos.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `Storage`, `authenticate`, job enqueue
- Produces: `POST/GET/DELETE /photos`, `GET /photos/:id`; enqueue `process_photo`; local `GET /files/*`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/photos.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { withTestApp, registerAndLogin, type TestContext } from './helpers.js';
import sharp from 'sharp';
import FormData from 'form-data';

async function tinyJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 20, g: 80, b: 180 } } }).jpeg().toBuffer();
}

describe('photos personal library', () => {
  let ctx: TestContext;
  afterEach(async () => { await ctx.app.close(); await ctx.pool.end(); });

  it('uploads a photo and lists it with processing status', async () => {
    ctx = await withTestApp();
    const { token } = await registerAndLogin(ctx.app, 'p@example.com');
    const form = new FormData();
    form.append('file', await tinyJpeg(), { filename: 'shot.jpg', contentType: 'image/jpeg' });
    const up = await ctx.app.inject({
      method: 'POST', url: '/photos',
      headers: { authorization: `Bearer ${token}`, ...form.getHeaders() },
      payload: form,
    });
    expect(up.statusCode).toBe(201);
    expect(up.json().status).toBe('processing');
    const list = await ctx.app.inject({ method: 'GET', url: '/photos', headers: { authorization: `Bearer ${token}` } });
    expect(list.json().items).toHaveLength(1);
  });

  it('does not leak another user photo', async () => {
    ctx = await withTestApp();
    const a = await registerAndLogin(ctx.app, 'a1@example.com');
    const b = await registerAndLogin(ctx.app, 'b1@example.com');
    const form = new FormData();
    form.append('file', await tinyJpeg(), { filename: 'shot.jpg', contentType: 'image/jpeg' });
    const up = await ctx.app.inject({
      method: 'POST', url: '/photos',
      headers: { authorization: `Bearer ${a.token}`, ...form.getHeaders() },
      payload: form,
    });
    const get = await ctx.app.inject({
      method: 'GET', url: `/photos/${up.json().id}`,
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(get.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @album/api -- test/photos.test.ts`
Expected: FAIL (404 `/photos`)

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/pipeline/jobs.ts
import type pg from 'pg';
export type JobType = 'process_photo' | 'reembed_photo';
export class JobsService {
  constructor(private readonly pool: pg.Pool) {}
  async enqueue(type: JobType, photoId: string, payload: Record<string, unknown> = {}): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO jobs (type, photo_id, payload, status) VALUES ($1,$2,$3::jsonb,'pending') RETURNING id`,
      [type, photoId, JSON.stringify(payload)],
    );
    return rows[0].id;
  }
  async claimNext(): Promise<{ id: string; type: JobType; photo_id: string; payload: Record<string, unknown>; attempts: number } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, type, photo_id, payload, attempts FROM jobs WHERE status='pending' ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!rows[0]) { await client.query('COMMIT'); return null; }
      await client.query(`UPDATE jobs SET status='running', attempts=attempts+1, updated_at=now() WHERE id=$1`, [rows[0].id]);
      await client.query('COMMIT');
      return rows[0];
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async markDone(id: string): Promise<void> {
    await this.pool.query(`UPDATE jobs SET status='done', updated_at=now() WHERE id=$1`, [id]);
  }
  async markFailed(id: string, error: string): Promise<void> {
    await this.pool.query(`UPDATE jobs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1`, [id, error]);
  }
}
```

```typescript
// apps/api/src/pipeline/thumbnails.ts
import sharp from 'sharp';
export async function makeThumbnail(image: Buffer): Promise<Buffer> {
  return sharp(image).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
}
```

```typescript
// apps/api/src/photos/repo.ts
import type pg from 'pg';
import type { PhotoStatus } from '@album/shared';
export type PhotoRow = {
  id: string; owner_user_id: string; album_id: string | null;
  original_key: string; thumb_key: string | null;
  taken_at: Date | null; location_text: string | null;
  latitude: number | null; longitude: number | null;
  description: string | null; tags: string[]; source_label: string;
  status: PhotoStatus; fail_reason: string | null;
  created_at: Date; updated_at: Date;
};
export class PhotosRepo {
  constructor(private readonly pool: pg.Pool) {}
  async insert(input: { id: string; ownerUserId: string; albumId?: string | null; originalKey: string; sourceLabel: string; }): Promise<PhotoRow> {
    const { rows } = await this.pool.query<PhotoRow>(
      `INSERT INTO photos (id, owner_user_id, album_id, original_key, source_label, status)
       VALUES ($1,$2,$3,$4,$5,'processing') RETURNING *`,
      [input.id, input.ownerUserId, input.albumId ?? null, input.originalKey, input.sourceLabel],
    );
    return rows[0];
  }
  async listByOwner(ownerUserId: string): Promise<PhotoRow[]> {
    const { rows } = await this.pool.query<PhotoRow>(
      `SELECT * FROM photos WHERE owner_user_id=$1 AND album_id IS NULL ORDER BY created_at DESC`, [ownerUserId],
    );
    return rows;
  }
  async listByAlbum(albumId: string): Promise<PhotoRow[]> {
    const { rows } = await this.pool.query<PhotoRow>(
      `SELECT * FROM photos WHERE album_id=$1 ORDER BY created_at DESC`, [albumId],
    );
    return rows;
  }
  async findById(id: string): Promise<PhotoRow | null> {
    const { rows } = await this.pool.query<PhotoRow>(`SELECT * FROM photos WHERE id=$1`, [id]);
    return rows[0] ?? null;
  }
  async delete(id: string, ownerUserId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM photos WHERE id=$1 AND owner_user_id=$2`, [id, ownerUserId]);
    return (rowCount ?? 0) > 0;
  }
  async updateProcessingResult(id: string, patch: Partial<{
    thumb_key: string; taken_at: Date | null; latitude: number | null; longitude: number | null;
    description: string; tags: string[]; status: PhotoStatus; fail_reason: string | null; embedding: number[] | null;
  }>): Promise<void> {
    const embeddingLiteral = patch.embedding ? `[${patch.embedding.join(',')}]` : null;
    await this.pool.query(
      `UPDATE photos SET
         thumb_key = COALESCE($2, thumb_key),
         taken_at = COALESCE($3, taken_at),
         latitude = COALESCE($4, latitude),
         longitude = COALESCE($5, longitude),
         description = COALESCE($6, description),
         tags = COALESCE($7, tags),
         status = COALESCE($8, status),
         fail_reason = $9,
         embedding = CASE WHEN $10::text IS NULL THEN embedding ELSE $10::vector END,
         updated_at = now()
       WHERE id = $1`,
      [
        id, patch.thumb_key ?? null, patch.taken_at ?? null, patch.latitude ?? null, patch.longitude ?? null,
        patch.description ?? null, patch.tags ?? null, patch.status ?? null, patch.fail_reason ?? null, embeddingLiteral,
      ],
    );
  }
  async patchMetadata(id: string, fields: {
    description?: string; tags?: string[]; taken_at?: Date | null;
    location_text?: string | null; latitude?: number | null; longitude?: number | null;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE photos SET
        description = COALESCE($2, description),
        tags = COALESCE($3, tags),
        taken_at = CASE WHEN $4::boolean THEN $5 ELSE taken_at END,
        location_text = CASE WHEN $6::boolean THEN $7 ELSE location_text END,
        latitude = CASE WHEN $8::boolean THEN $9 ELSE latitude END,
        longitude = CASE WHEN $10::boolean THEN $11 ELSE longitude END,
        updated_at = now()
       WHERE id = $1`,
      [
        id, fields.description ?? null, fields.tags ?? null,
        fields.taken_at !== undefined, fields.taken_at ?? null,
        fields.location_text !== undefined, fields.location_text ?? null,
        fields.latitude !== undefined, fields.latitude ?? null,
        fields.longitude !== undefined, fields.longitude ?? null,
      ],
    );
  }
}
```

```typescript
// apps/api/src/photos/service.ts
import { randomUUID } from 'node:crypto';
import type { PhotoDto, PatchPhotoRequest } from '@album/shared';
import type { Storage } from '../storage/types.js';
import type { AuthContext } from '../auth/plugin.js';
import { PhotosRepo, type PhotoRow } from './repo.js';
import { JobsService } from '../pipeline/jobs.js';

export function toPhotoDto(row: PhotoRow, storage: Storage): PhotoDto {
  return {
    id: row.id, ownerUserId: row.owner_user_id, albumId: row.album_id,
    originalKey: row.original_key, thumbKey: row.thumb_key,
    thumbUrl: row.thumb_key ? storage.publicUrl(row.thumb_key) : null,
    takenAt: row.taken_at?.toISOString() ?? null, locationText: row.location_text,
    latitude: row.latitude, longitude: row.longitude,
    description: row.description, tags: row.tags ?? [], sourceLabel: row.source_label,
    status: row.status, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

export class PhotosService {
  constructor(
    private readonly repo: PhotosRepo,
    private readonly jobs: JobsService,
    private readonly storage: Storage,
  ) {}

  async uploadPersonal(auth: AuthContext, file: { buffer: Buffer; filename: string; mimetype: string }): Promise<PhotoDto> {
    const id = randomUUID();
    const ext = file.mimetype === 'image/png' ? 'png' : 'jpg';
    const originalKey = `users/${auth.userId}/photos/${id}/original.${ext}`;
    await this.storage.putObject(originalKey, file.buffer, file.mimetype);
    const sourceLabel = auth.via === 'api_key' ? `api_key:${auth.keyId}` : `user:${auth.userId}`;
    const row = await this.repo.insert({ id, ownerUserId: auth.userId, originalKey, sourceLabel });
    await this.jobs.enqueue('process_photo', id);
    return toPhotoDto(row, this.storage);
  }

  async uploadToAlbum(auth: AuthContext, albumId: string, file: { buffer: Buffer; filename: string; mimetype: string }): Promise<PhotoDto> {
    const id = randomUUID();
    const ext = file.mimetype === 'image/png' ? 'png' : 'jpg';
    const originalKey = `albums/${albumId}/photos/${id}/original.${ext}`;
    await this.storage.putObject(originalKey, file.buffer, file.mimetype);
    const sourceLabel = auth.via === 'api_key' ? `api_key:${auth.keyId}` : `user:${auth.userId}`;
    const row = await this.repo.insert({ id, ownerUserId: auth.userId, albumId, originalKey, sourceLabel });
    await this.jobs.enqueue('process_photo', id);
    return toPhotoDto(row, this.storage);
  }

  async listPersonal(userId: string): Promise<PhotoDto[]> {
    return (await this.repo.listByOwner(userId)).map((r) => toPhotoDto(r, this.storage));
  }

  async getForUser(id: string, userId: string): Promise<PhotoDto> {
    const row = await this.repo.findById(id);
    if (!row || row.owner_user_id !== userId) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    return toPhotoDto(row, this.storage);
  }

  async deleteForUser(id: string, userId: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row || row.owner_user_id !== userId) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    await this.storage.deleteObject(row.original_key);
    if (row.thumb_key) await this.storage.deleteObject(row.thumb_key);
    await this.repo.delete(id, userId);
  }

  async patchForUser(id: string, userId: string, body: PatchPhotoRequest): Promise<PhotoDto> {
    const row = await this.repo.findById(id);
    if (!row || row.owner_user_id !== userId) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    await this.repo.patchMetadata(id, {
      description: body.description,
      tags: body.tags,
      taken_at: body.takenAt === undefined ? undefined : body.takenAt ? new Date(body.takenAt) : null,
      location_text: body.locationText,
      latitude: body.latitude,
      longitude: body.longitude,
    });
    const shouldReembed = body.reembed === true || body.description !== undefined || body.tags !== undefined;
    if (shouldReembed) await this.jobs.enqueue('reembed_photo', id);
    return toPhotoDto((await this.repo.findById(id))!, this.storage);
  }

  async retryProcessing(id: string, userId: string): Promise<PhotoDto> {
    const row = await this.repo.findById(id);
    if (!row || row.owner_user_id !== userId) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    await this.repo.updateProcessingResult(id, { status: 'processing', fail_reason: null });
    await this.jobs.enqueue('process_photo', id);
    return toPhotoDto((await this.repo.findById(id))!, this.storage);
  }
}
```

```typescript
// apps/api/src/photos/routes.ts
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type { PhotosService } from './service.js';
import type { PhotoSearchService } from './search.js';
import type { Storage } from '../storage/types.js';
import { LocalFsStorage } from '../storage/local.js';
import type { PatchPhotoRequest } from '@album/shared';

export async function registerPhotoRoutes(
  app: FastifyInstance,
  photos: PhotosService,
  storage: Storage,
  searchService?: PhotoSearchService,
) {
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  app.post('/photos', async (req, reply) => {
    await app.authenticate(req);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'file required' });
    const buffer = await file.toBuffer();
    try {
      const photo = await photos.uploadPersonal(req.auth, { buffer, filename: file.filename, mimetype: file.mimetype });
      return reply.code(201).send(photo);
    } catch (err) {
      const e = err as { statusCode?: number; message: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.get('/photos', async (req) => {
    await app.authenticate(req);
    return { items: await photos.listPersonal(req.auth.userId) };
  });

  app.get('/photos/:id', async (req, reply) => {
    await app.authenticate(req);
    try { return await photos.getForUser((req.params as { id: string }).id, req.auth.userId); }
    catch (err) { const e = err as { statusCode?: number; message: string }; return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  app.delete('/photos/:id', async (req, reply) => {
    await app.authenticate(req);
    try { await photos.deleteForUser((req.params as { id: string }).id, req.auth.userId); return { ok: true }; }
    catch (err) { const e = err as { statusCode?: number; message: string }; return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  app.patch('/photos/:id', async (req, reply) => {
    await app.authenticate(req);
    try { return await photos.patchForUser((req.params as { id: string }).id, req.auth.userId, req.body as PatchPhotoRequest); }
    catch (err) { const e = err as { statusCode?: number; message: string }; return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  app.post('/photos/:id/retry', async (req, reply) => {
    await app.authenticate(req);
    try { return await photos.retryProcessing((req.params as { id: string }).id, req.auth.userId); }
    catch (err) { const e = err as { statusCode?: number; message: string }; return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  if (searchService) {
    app.post('/photos/search', async (req, reply) => {
      await app.authenticate(req);
      const body = req.body as { query?: string; mode?: 'semantic' | 'keyword' | 'hybrid'; limit?: number; albumId?: string };
      if (!body.query?.trim()) return reply.code(400).send({ error: 'query required' });
      const items = await searchService.search({
        userId: req.auth.userId, query: body.query.trim(),
        mode: body.mode ?? 'hybrid', limit: body.limit ?? 20, albumId: body.albumId,
      });
      return { items };
    });
  }

  if (storage instanceof LocalFsStorage) {
    app.get('/files/*', async (req, reply) => {
      const key = (req.params as { '*': string })['*'];
      try {
        const obj = await storage.getObject(key);
        return reply.type(obj.contentType).send(obj.body);
      } catch {
        return reply.code(404).send({ error: 'not found' });
      }
    });
  }
}
```

Wire in `buildApp`:
```typescript
import { JobsService } from './pipeline/jobs.js';
import { PhotosRepo } from './photos/repo.js';
import { PhotosService } from './photos/service.js';
import { registerPhotoRoutes } from './photos/routes.js';
const jobs = new JobsService(pool);
const photosRepo = new PhotosRepo(pool);
const photosService = new PhotosService(photosRepo, jobs, storage);
await registerPhotoRoutes(app, photosService, storage);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @album/api -- test/photos.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/photos apps/api/src/pipeline/jobs.ts apps/api/src/pipeline/thumbnails.ts apps/api/src/app.ts apps/api/test/photos.test.ts
git commit -m "feat(api): personal library photo upload list get delete"
```

---

### Task 8: Processing pipeline — EXIF, thumbnail, vision, embed

**Files:**
- Create: `apps/api/src/pipeline/exif.ts`, `apps/api/src/pipeline/worker.ts`, `apps/api/test/pipeline.test.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Consumes: `JobsService`, `Storage`, `VisionProvider`, `EmbedProvider`, `PhotosRepo`
- Produces: `extractExif(buffer)`, `processNextJob(deps): Promise<boolean>`, `startWorkerLoop(deps, intervalMs)`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/pipeline.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { withTestApp, registerAndLogin, type TestContext } from './helpers.js';
import sharp from 'sharp';
import FormData from 'form-data';
import { processNextJob } from '../src/pipeline/worker.js';

async function tinyJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 100, b: 50 } } }).jpeg().toBuffer();
}

describe('processing pipeline', () => {
  let ctx: TestContext;
  afterEach(async () => { await ctx.app.close(); await ctx.pool.end(); });

  it('moves uploaded photo to ready with description tags and embedding', async () => {
    ctx = await withTestApp();
    const { token } = await registerAndLogin(ctx.app, 'pipe@example.com');
    const form = new FormData();
    form.append('file', await tinyJpeg(), { filename: 'x.jpg', contentType: 'image/jpeg' });
    const up = await ctx.app.inject({
      method: 'POST', url: '/photos',
      headers: { authorization: `Bearer ${token}`, ...form.getHeaders() },
      payload: form,
    });
    const processed = await processNextJob({
      pool: ctx.pool,
      storage: (ctx.app as any).storage,
      vision: (ctx.app as any).vision,
      embed: (ctx.app as any).embed,
    });
    expect(processed).toBe(true);
    const get = await ctx.app.inject({
      method: 'GET', url: `/photos/${up.json().id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.json().status).toBe('ready');
    expect(get.json().description).toBeTruthy();
    expect(get.json().tags.length).toBeGreaterThan(0);
    expect(get.json().thumbUrl).toBeTruthy();
    const { rows } = await ctx.pool.query(`SELECT embedding IS NOT NULL AS has_embedding FROM photos WHERE id=$1`, [up.json().id]);
    expect(rows[0].has_embedding).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @album/api -- test/pipeline.test.ts`
Expected: FAIL (`processNextJob` missing)

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/pipeline/exif.ts
import exifr from 'exifr';
export type ExifData = { takenAt: Date | null; latitude: number | null; longitude: number | null };
export async function extractExif(image: Buffer): Promise<ExifData> {
  try {
    const data = await exifr.parse(image, { gps: true });
    if (!data) return { takenAt: null, latitude: null, longitude: null };
    const takenAt = data.DateTimeOriginal instanceof Date ? data.DateTimeOriginal
      : data.CreateDate instanceof Date ? data.CreateDate : null;
    return {
      takenAt,
      latitude: typeof data.latitude === 'number' ? data.latitude : null,
      longitude: typeof data.longitude === 'number' ? data.longitude : null,
    };
  } catch {
    return { takenAt: null, latitude: null, longitude: null };
  }
}
```

```typescript
// apps/api/src/pipeline/worker.ts
import type pg from 'pg';
import type { Storage } from '../storage/types.js';
import type { VisionProvider, EmbedProvider } from '../ai/types.js';
import { JobsService } from './jobs.js';
import { PhotosRepo } from '../photos/repo.js';
import { extractExif } from './exif.js';
import { makeThumbnail } from './thumbnails.js';

export type WorkerDeps = { pool: pg.Pool; storage: Storage; vision: VisionProvider; embed: EmbedProvider };

export async function processNextJob(deps: WorkerDeps): Promise<boolean> {
  const jobs = new JobsService(deps.pool);
  const photos = new PhotosRepo(deps.pool);
  const job = await jobs.claimNext();
  if (!job) return false;
  try {
    const photo = await photos.findById(job.photo_id);
    if (!photo) { await jobs.markFailed(job.id, 'photo missing'); return true; }

    if (job.type === 'process_photo') {
      const original = await deps.storage.getObject(photo.original_key);
      const exif = await extractExif(original.body);
      const thumb = await makeThumbnail(original.body);
      const thumbKey = photo.original_key.replace('/original.', '/thumb.').replace(/\.(png|jpeg|jpg)$/i, '.jpg');
      await deps.storage.putObject(thumbKey, thumb, 'image/jpeg');
      let description = photo.description;
      let tags = photo.tags;
      let status: 'ready' | 'failed' = 'ready';
      let failReason: string | null = null;
      let embedding: number[] | null = null;
      try {
        const vision = await deps.vision.describe(original.body, original.contentType);
        description = vision.description;
        tags = vision.tags;
        embedding = await deps.embed.embedText(`${description}\n${tags.join(', ')}`);
      } catch (err) {
        status = 'failed';
        failReason = err instanceof Error ? err.message : String(err);
      }
      await photos.updateProcessingResult(photo.id, {
        thumb_key: thumbKey, taken_at: exif.takenAt, latitude: exif.latitude, longitude: exif.longitude,
        description: description ?? undefined, tags, status, fail_reason: failReason, embedding,
      });
      await jobs.markDone(job.id);
      return true;
    }

    if (job.type === 'reembed_photo') {
      const embedding = await deps.embed.embedText(`${photo.description ?? ''}\n${(photo.tags ?? []).join(', ')}`);
      await photos.updateProcessingResult(photo.id, { status: 'ready', fail_reason: null, embedding });
      await jobs.markDone(job.id);
      return true;
    }

    await jobs.markFailed(job.id, `unknown job type ${job.type}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await jobs.markFailed(job.id, message);
    await new PhotosRepo(deps.pool).updateProcessingResult(job.photo_id, { status: 'failed', fail_reason: message });
    return true;
  }
}

export function startWorkerLoop(deps: WorkerDeps, intervalMs = 1000): NodeJS.Timeout {
  return setInterval(() => { void processNextJob(deps); }, intervalMs);
}
```

Replace `apps/api/src/index.ts`:
```typescript
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db/client.js';
import { createStorage } from './storage/index.js';
import { createVisionProvider, createEmbedProvider } from './ai/index.js';
import { startWorkerLoop } from './pipeline/worker.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const storage = createStorage(config);
const vision = createVisionProvider(config);
const embed = createEmbedProvider(config);
const app = await buildApp({ config, pool, storage, vision, embed });
startWorkerLoop({ pool, storage, vision, embed }, 1000);
await app.listen({ port: config.port, host: '0.0.0.0' });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @album/api -- test/pipeline.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pipeline apps/api/src/index.ts apps/api/test/pipeline.test.ts
git commit -m "feat(api): async photo pipeline with EXIF vision embed"
```

---

### Task 9: PATCH photo metadata + re-embed + retry failed

**Files:**
- Create: `apps/api/test/photoPatch.test.ts`
- Modify: `apps/api/src/photos/service.ts`, `apps/api/src/photos/routes.ts` (already include patch/retry from Task 7 — ensure wired)

**Interfaces:**
- Consumes: `PatchPhotoRequest`, `JobsService.enqueue('reembed_photo'|'process_photo')`
- Produces: `PATCH /photos/:id`, `POST /photos/:id/retry`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/photoPatch.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { withTestApp, registerAndLogin, type TestContext } from './helpers.js';
import sharp from 'sharp';
import FormData from 'form-data';
import { processNextJob } from '../src/pipeline/worker.js';

async function tinyJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 10, g: 10, b: 10 } } }).jpeg().toBuffer();
}

describe('PATCH /photos/:id', () => {
  let ctx: TestContext;
  afterEach(async () => { await ctx.app.close(); await ctx.pool.end(); });

  it('allows agent to override description and reembed', async () => {
    ctx = await withTestApp();
    const { token } = await registerAndLogin(ctx.app, 'patch@example.com');
    const keyRes = await ctx.app.inject({
      method: 'POST', url: '/api-keys',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'bot' },
    });
    const apiToken = keyRes.json().token;
    const form = new FormData();
    form.append('file', await tinyJpeg(), { filename: 'x.jpg', contentType: 'image/jpeg' });
    const up = await ctx.app.inject({
      method: 'POST', url: '/photos',
      headers: { authorization: `Bearer ${apiToken}`, ...form.getHeaders() },
      payload: form,
    });
    const deps = { pool: ctx.pool, storage: (ctx.app as any).storage, vision: (ctx.app as any).vision, embed: (ctx.app as any).embed };
    await processNextJob(deps);
    const patch = await ctx.app.inject({
      method: 'PATCH', url: `/photos/${up.json().id}`,
      headers: { authorization: `Bearer ${apiToken}` },
      payload: { description: 'sunset over marina bay', tags: ['singapore', 'sunset'], reembed: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().description).toBe('sunset over marina bay');
    await processNextJob(deps);
    const { rows } = await ctx.pool.query(`SELECT description FROM photos WHERE id=$1`, [up.json().id]);
    expect(rows[0].description).toBe('sunset over marina bay');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @album/api -- test/photoPatch.test.ts`
Expected: FAIL if PATCH not yet registered; otherwise adjust and make green in Step 3

- [ ] **Step 3: Confirm `patchForUser` / `retryProcessing` and routes from Task 7 are registered in `buildApp`**

If Task 7 already added these methods and routes, this step only verifies wiring. If missing, copy the `patchForUser`, `retryProcessing`, `PATCH /photos/:id`, and `POST /photos/:id/retry` implementations from Task 7 Step 3 into the live files.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @album/api -- test/photoPatch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/photos apps/api/test/photoPatch.test.ts
git commit -m "feat(api): patch photo metadata with reembed and retry"
```

---

### Task 10: Semantic + keyword search

**Files:**
- Create: `apps/api/src/photos/search.ts`, `apps/api/test/search.test.ts`
- Modify: `apps/api/src/photos/routes.ts`, `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `EmbedProvider.embedText`, `PhotoSearchRequest`
- Produces: `POST /photos/search`; `PhotoSearchService.search(...)`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/search.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { withTestApp, registerAndLogin, type TestContext } from './helpers.js';
import sharp from 'sharp';
import FormData from 'form-data';
import { processNextJob } from '../src/pipeline/worker.js';

async function tinyJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
}

describe('POST /photos/search', () => {
  let ctx: TestContext;
  afterEach(async () => { await ctx.app.close(); await ctx.pool.end(); });

  it('finds a photo by natural language after processing', async () => {
    ctx = await withTestApp();
    const { token } = await registerAndLogin(ctx.app, 'search@example.com');
    const form = new FormData();
    form.append('file', await tinyJpeg(), { filename: 'x.jpg', contentType: 'image/jpeg' });
    await ctx.app.inject({
      method: 'POST', url: '/photos',
      headers: { authorization: `Bearer ${token}`, ...form.getHeaders() },
      payload: form,
    });
    await processNextJob({
      pool: ctx.pool, storage: (ctx.app as any).storage,
      vision: (ctx.app as any).vision, embed: (ctx.app as any).embed,
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/photos/search',
      headers: { authorization: `Bearer ${token}` },
      payload: { query: 'everyday life soft light', mode: 'semantic', limit: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @album/api -- test/search.test.ts`
Expected: FAIL (404 or searchService undefined)

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/photos/search.ts
import type pg from 'pg';
import type { EmbedProvider } from '../ai/types.js';
import type { Storage } from '../storage/types.js';
import { toPhotoDto } from './service.js';
import type { PhotoRow } from './repo.js';

export class PhotoSearchService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly embed: EmbedProvider,
    private readonly storage: Storage,
  ) {}

  async search(opts: {
    userId: string; query: string; mode: 'semantic' | 'keyword' | 'hybrid';
    limit: number; albumId?: string;
  }) {
    const limit = Math.min(Math.max(opts.limit, 1), 50);
    if (opts.mode === 'keyword') return this.keyword(opts.userId, opts.query, limit, opts.albumId);
    if (opts.mode === 'semantic') return this.semantic(opts.userId, opts.query, limit, opts.albumId);
    const [sem, key] = await Promise.all([
      this.semantic(opts.userId, opts.query, limit, opts.albumId),
      this.keyword(opts.userId, opts.query, limit, opts.albumId),
    ]);
    const map = new Map<string, (typeof sem)[0]>();
    for (const item of [...sem, ...key]) if (!map.has(item.id)) map.set(item.id, item);
    return [...map.values()].slice(0, limit);
  }

  private async keyword(userId: string, query: string, limit: number, albumId?: string) {
    const q = `%${query}%`;
    const { rows } = await this.pool.query<PhotoRow>(
      `SELECT * FROM photos
       WHERE owner_user_id = $1
         AND ($4::uuid IS NULL OR album_id = $4)
         AND ($4::uuid IS NOT NULL OR album_id IS NULL)
         AND status = 'ready'
         AND (description ILIKE $2 OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE $2))
       ORDER BY created_at DESC LIMIT $3`,
      [userId, q, limit, albumId ?? null],
    );
    return rows.map((r) => ({ ...toPhotoDto(r, this.storage), score: 1 }));
  }

  private async semantic(userId: string, query: string, limit: number, albumId?: string) {
    const vector = await this.embed.embedText(query);
    const literal = `[${vector.join(',')}]`;
    const { rows } = await this.pool.query<PhotoRow & { score: number }>(
      `SELECT *, 1 - (embedding <=> $2::vector) AS score FROM photos
       WHERE owner_user_id = $1
         AND ($4::uuid IS NULL OR album_id = $4)
         AND ($4::uuid IS NOT NULL OR album_id IS NULL)
         AND status = 'ready' AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector LIMIT $3`,
      [userId, literal, limit, albumId ?? null],
    );
    return rows.map((r) => ({ ...toPhotoDto(r, this.storage), score: Number(r.score) }));
  }
}
```

In `buildApp`, construct `PhotoSearchService` and pass it into `registerPhotoRoutes(app, photosService, storage, searchService)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @album/api -- test/search.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/photos/search.ts apps/api/src/photos/routes.ts apps/api/src/app.ts apps/api/test/search.test.ts
git commit -m "feat(api): keyword and semantic photo search"
```

---

### Task 11: Shared albums (create, join, role-aware upload)

**Files:**
- Create: `apps/api/src/albums/{repo,service,routes}.ts`, `apps/api/test/albums.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: passphrase hash/verify; `PhotosService.uploadToAlbum`; `PhotosRepo.listByAlbum`
- Produces:
  - `POST /albums`, `GET /albums`, `PATCH /albums/:id`
  - `POST /albums/join/:shareSlug` → `JoinAlbumResponse`
  - `GET /albums/:id`, `GET /albums/:id/photos`, `POST /albums/:id/photos`
  - Guest session header `x-album-session`; tokens `als_<hex>`; wrong passphrase → 403 `{ error: 'forbidden' }`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/albums.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { withTestApp, registerAndLogin, type TestContext } from './helpers.js';
import sharp from 'sharp';
import FormData from 'form-data';

async function tinyJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 9, g: 9, b: 9 } } }).jpeg().toBuffer();
}

describe('shared albums', () => {
  let ctx: TestContext;
  afterEach(async () => { await ctx.app.close(); await ctx.pool.end(); });

  it('creates album and allows guest upload with passphrase session', async () => {
    ctx = await withTestApp();
    const owner = await registerAndLogin(ctx.app, 'owner@example.com');
    const created = await ctx.app.inject({
      method: 'POST', url: '/albums',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { title: 'SG trip', passphrase: 'secret-pass', defaultRole: 'uploader' },
    });
    expect(created.statusCode).toBe(201);
    const album = created.json();
    const guest = await registerAndLogin(ctx.app, 'guest@example.com');
    const join = await ctx.app.inject({
      method: 'POST', url: `/albums/join/${album.shareSlug}`,
      headers: { authorization: `Bearer ${guest.token}` },
      payload: { passphrase: 'secret-pass' },
    });
    expect(join.statusCode).toBe(200);
    const form = new FormData();
    form.append('file', await tinyJpeg(), { filename: 'g.jpg', contentType: 'image/jpeg' });
    const up = await ctx.app.inject({
      method: 'POST', url: `/albums/${album.id}/photos`,
      headers: {
        authorization: `Bearer ${guest.token}`,
        'x-album-session': join.json().sessionToken,
        ...form.getHeaders(),
      },
      payload: form,
    });
    expect(up.statusCode).toBe(201);
    expect(up.json().albumId).toBe(album.id);
  });

  it('returns 403 for wrong passphrase without leaking', async () => {
    ctx = await withTestApp();
    const owner = await registerAndLogin(ctx.app, 'owner2@example.com');
    const created = await ctx.app.inject({
      method: 'POST', url: '/albums',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { title: 'Private', passphrase: 'right', defaultRole: 'viewer' },
    });
    const guest = await registerAndLogin(ctx.app, 'guest2@example.com');
    const join = await ctx.app.inject({
      method: 'POST', url: `/albums/join/${created.json().shareSlug}`,
      headers: { authorization: `Bearer ${guest.token}` },
      payload: { passphrase: 'wrong' },
    });
    expect(join.statusCode).toBe(403);
    expect(join.json().error).toBe('forbidden');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @album/api -- test/albums.test.ts`
Expected: FAIL (404)

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/albums/repo.ts
import type pg from 'pg';
import type { AlbumRole } from '@album/shared';
export type AlbumRow = {
  id: string; owner_user_id: string; title: string; share_slug: string;
  passphrase_hash: string; default_role: 'uploader' | 'viewer';
  expires_at: Date | null; locked_read_only: boolean; created_at: Date;
};
export class AlbumsRepo {
  constructor(private readonly pool: pg.Pool) {}
  async create(input: {
    ownerUserId: string; title: string; shareSlug: string; passphraseHash: string;
    defaultRole: 'uploader' | 'viewer'; expiresAt: Date | null;
  }): Promise<AlbumRow> {
    const { rows } = await this.pool.query<AlbumRow>(
      `INSERT INTO albums (owner_user_id, title, share_slug, passphrase_hash, default_role, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [input.ownerUserId, input.title, input.shareSlug, input.passphraseHash, input.defaultRole, input.expiresAt],
    );
    return rows[0];
  }
  async listByOwner(ownerUserId: string): Promise<AlbumRow[]> {
    const { rows } = await this.pool.query<AlbumRow>(`SELECT * FROM albums WHERE owner_user_id=$1 ORDER BY created_at DESC`, [ownerUserId]);
    return rows;
  }
  async findById(id: string): Promise<AlbumRow | null> {
    const { rows } = await this.pool.query<AlbumRow>(`SELECT * FROM albums WHERE id=$1`, [id]);
    return rows[0] ?? null;
  }
  async findBySlug(slug: string): Promise<AlbumRow | null> {
    const { rows } = await this.pool.query<AlbumRow>(`SELECT * FROM albums WHERE share_slug=$1`, [slug]);
    return rows[0] ?? null;
  }
  async update(id: string, ownerUserId: string, patch: { title?: string; lockedReadOnly?: boolean; expiresAt?: Date | null; }): Promise<AlbumRow | null> {
    const { rows } = await this.pool.query<AlbumRow>(
      `UPDATE albums SET
         title = COALESCE($3, title),
         locked_read_only = COALESCE($4, locked_read_only),
         expires_at = CASE WHEN $5::boolean THEN $6 ELSE expires_at END
       WHERE id=$1 AND owner_user_id=$2 RETURNING *`,
      [id, ownerUserId, patch.title ?? null, patch.lockedReadOnly ?? null, patch.expiresAt !== undefined, patch.expiresAt ?? null],
    );
    return rows[0] ?? null;
  }
  async createSession(input: { albumId: string; role: AlbumRole; tokenHash: string; expiresAt: Date }): Promise<void> {
    await this.pool.query(
      `INSERT INTO album_sessions (album_id, role, token_hash, expires_at) VALUES ($1,$2,$3,$4)`,
      [input.albumId, input.role, input.tokenHash, input.expiresAt],
    );
  }
  async findValidSession(albumId: string, tokenHash: string): Promise<{ role: AlbumRole } | null> {
    const { rows } = await this.pool.query<{ role: AlbumRole }>(
      `SELECT role FROM album_sessions WHERE album_id=$1 AND token_hash=$2 AND expires_at > now() LIMIT 1`,
      [albumId, tokenHash],
    );
    return rows[0] ?? null;
  }
}
```

```typescript
// apps/api/src/albums/service.ts
import { createHash, randomBytes } from 'node:crypto';
import type { AlbumDto, AlbumRole, JoinAlbumResponse } from '@album/shared';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { AlbumsRepo, type AlbumRow } from './repo.js';

function slug(): string { return randomBytes(6).toString('base64url'); }
function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

export function toAlbumDto(row: AlbumRow): AlbumDto {
  return {
    id: row.id, title: row.title, ownerUserId: row.owner_user_id, shareSlug: row.share_slug,
    defaultRole: row.default_role, expiresAt: row.expires_at?.toISOString() ?? null,
    lockedReadOnly: row.locked_read_only, createdAt: row.created_at.toISOString(),
  };
}

export class AlbumsService {
  constructor(private readonly repo: AlbumsRepo) {}

  async create(ownerUserId: string, input: {
    title: string; passphrase: string; defaultRole?: 'uploader' | 'viewer'; expiresAt?: string | null;
  }): Promise<AlbumDto> {
    if (!input.title.trim() || input.passphrase.length < 4) throw Object.assign(new Error('invalid album'), { statusCode: 400 });
    const row = await this.repo.create({
      ownerUserId, title: input.title.trim(), shareSlug: slug(),
      passphraseHash: await hashPassword(input.passphrase),
      defaultRole: input.defaultRole ?? 'uploader',
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    });
    return toAlbumDto(row);
  }

  async list(ownerUserId: string): Promise<AlbumDto[]> {
    return (await this.repo.listByOwner(ownerUserId)).map(toAlbumDto);
  }

  async join(shareSlug: string, passphrase: string): Promise<JoinAlbumResponse> {
    const row = await this.repo.findBySlug(shareSlug);
    if (!row || (row.expires_at && row.expires_at.getTime() < Date.now())) {
      throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    }
    if (!(await verifyPassword(passphrase, row.passphrase_hash))) {
      throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    }
    const sessionToken = `als_${randomBytes(24).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const role = row.locked_read_only ? 'viewer' : row.default_role;
    await this.repo.createSession({ albumId: row.id, role, tokenHash: sha256(sessionToken), expiresAt });
    return { album: toAlbumDto(row), role, sessionToken, expiresAt: expiresAt.toISOString() };
  }

  async resolveAccess(opts: { albumId: string; userId: string; albumSessionToken?: string }): Promise<{ album: AlbumRow; role: AlbumRole }> {
    const album = await this.repo.findById(opts.albumId);
    if (!album) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    if (album.expires_at && album.expires_at.getTime() < Date.now()) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    if (album.owner_user_id === opts.userId) return { album, role: 'owner' };
    if (!opts.albumSessionToken) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    const session = await this.repo.findValidSession(album.id, sha256(opts.albumSessionToken));
    if (!session) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    return { album, role: album.locked_read_only ? 'viewer' : session.role };
  }

  async patch(ownerUserId: string, id: string, patch: { title?: string; lockedReadOnly?: boolean; expiresAt?: string | null }): Promise<AlbumDto> {
    const row = await this.repo.update(id, ownerUserId, {
      title: patch.title,
      lockedReadOnly: patch.lockedReadOnly,
      expiresAt: patch.expiresAt === undefined ? undefined : patch.expiresAt ? new Date(patch.expiresAt) : null,
    });
    if (!row) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    return toAlbumDto(row);
  }
}
```

```typescript
// apps/api/src/albums/routes.ts
import type { FastifyInstance } from 'fastify';
import type { AlbumsService } from './service.js';
import { toAlbumDto } from './service.js';
import type { PhotosService } from '../photos/service.js';
import type { PhotosRepo } from '../photos/repo.js';
import type { Storage } from '../storage/types.js';
import { toPhotoDto } from '../photos/service.js';

export async function registerAlbumRoutes(
  app: FastifyInstance,
  albums: AlbumsService,
  photos: PhotosService,
  photosRepo: PhotosRepo,
  storage: Storage,
) {
  app.post('/albums', async (req, reply) => {
    await app.authenticate(req);
    try { return reply.code(201).send(await albums.create(req.auth.userId, req.body as any)); }
    catch (err) { const e = err as { statusCode?: number; message: string }; return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  app.get('/albums', async (req) => {
    await app.authenticate(req);
    return { items: await albums.list(req.auth.userId) };
  });

  app.post('/albums/join/:shareSlug', async (req, reply) => {
    await app.authenticate(req);
    try {
      return await albums.join((req.params as { shareSlug: string }).shareSlug, String((req.body as any).passphrase ?? ''));
    } catch (err) {
      const e = err as { statusCode?: number; message: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.get('/albums/:id', async (req, reply) => {
    await app.authenticate(req);
    try {
      const access = await albums.resolveAccess({
        albumId: (req.params as { id: string }).id,
        userId: req.auth.userId,
        albumSessionToken: String(req.headers['x-album-session'] ?? '') || undefined,
      });
      return { album: toAlbumDto(access.album), role: access.role };
    } catch (err) {
      const e = err as { statusCode?: number; message: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.patch('/albums/:id', async (req, reply) => {
    await app.authenticate(req);
    try { return await albums.patch(req.auth.userId, (req.params as { id: string }).id, req.body as any); }
    catch (err) { const e = err as { statusCode?: number; message: string }; return reply.code(e.statusCode ?? 500).send({ error: e.message }); }
  });

  app.get('/albums/:id/photos', async (req, reply) => {
    await app.authenticate(req);
    try {
      const access = await albums.resolveAccess({
        albumId: (req.params as { id: string }).id,
        userId: req.auth.userId,
        albumSessionToken: String(req.headers['x-album-session'] ?? '') || undefined,
      });
      const rows = await photosRepo.listByAlbum(access.album.id);
      return { items: rows.map((r) => toPhotoDto(r, storage)) };
    } catch (err) {
      const e = err as { statusCode?: number; message: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  app.post('/albums/:id/photos', async (req, reply) => {
    await app.authenticate(req);
    try {
      const access = await albums.resolveAccess({
        albumId: (req.params as { id: string }).id,
        userId: req.auth.userId,
        albumSessionToken: String(req.headers['x-album-session'] ?? '') || undefined,
      });
      if (access.role === 'viewer' || access.album.locked_read_only) return reply.code(403).send({ error: 'forbidden' });
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'file required' });
      const buffer = await file.toBuffer();
      const photo = await photos.uploadToAlbum(req.auth, access.album.id, {
        buffer, filename: file.filename, mimetype: file.mimetype,
      });
      return reply.code(201).send(photo);
    } catch (err) {
      const e = err as { statusCode?: number; message: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });
}
```

Wire in `buildApp` with `AlbumsRepo`, `AlbumsService`, `registerAlbumRoutes`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @album/api -- test/albums.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/albums apps/api/src/app.ts apps/api/test/albums.test.ts
git commit -m "feat(api): shared albums with passphrase sessions and role-aware upload"
```

---

### Task 12: React web app — auth, library upload/grid, API keys

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/auth/AuthContext.tsx`
- Create: `apps/web/src/components/{Layout,PhotoGrid,UploadButton}.tsx`
- Create: `apps/web/src/pages/{Login,Register,Library,PhotoDetail,ApiKeys}Page.tsx`
- Create stub pages: `SearchPage.tsx`, `AlbumsPage.tsx`, `AlbumDetailPage.tsx`, `JoinAlbumPage.tsx` (filled in Task 13)

**Interfaces:**
- Consumes: `/auth/*`, `/photos`, `/api-keys`
- Produces: SPA covering MVP acceptance #1 and human half of #3

- [ ] **Step 1: Write package scaffold and core UI files**

```json
// apps/web/package.json
{
  "name": "@album/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@album/shared": "0.0.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0"
  }
}
```

```json
// apps/web/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true
  },
  "include": ["src"]
}
```

```typescript
// apps/web/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': 'http://localhost:3000',
      '/photos': 'http://localhost:3000',
      '/api-keys': 'http://localhost:3000',
      '/albums': 'http://localhost:3000',
      '/files': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
```

```html
<!-- apps/web/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Native Album</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```typescript
// apps/web/src/api/client.ts
const TOKEN_KEY = 'album_jwt';
export function getToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
export function setToken(token: string | null) {
  if (!token) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'request failed');
  }
  return res.json() as Promise<T>;
}
```

```tsx
// apps/web/src/auth/AuthContext.tsx
import React, { createContext, useContext, useEffect, useState } from 'react';
import type { UserPublic } from '@album/shared';
import { api, getToken, setToken } from '../api/client';

type AuthState = {
  user: UserPublic | null; loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
};
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserPublic | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!getToken()) { setLoading(false); return; }
    api<{ user: UserPublic }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);
  async function login(email: string, password: string) {
    const r = await api<{ user: UserPublic; token: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    setToken(r.token); setUser(r.user);
  }
  async function register(email: string, password: string) {
    const r = await api<{ user: UserPublic; token: string }>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
    setToken(r.token); setUser(r.user);
  }
  function logout() { setToken(null); setUser(null); }
  return <Ctx.Provider value={{ user, loading, login, register, logout }}>{children}</Ctx.Provider>;
}
export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider missing');
  return v;
}
```

```tsx
// apps/web/src/pages/LoginPage.tsx
import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try { await login(email, password); nav('/'); }
    catch (err) { setError(err instanceof Error ? err.message : 'login failed'); }
  }
  return (
    <form onSubmit={onSubmit}>
      <h1>Login</h1>
      {error && <p>{error}</p>}
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" />
      <button type="submit">Login</button>
      <p><Link to="/register">Register</Link></p>
    </form>
  );
}
```

```tsx
// apps/web/src/pages/RegisterPage.tsx
import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
export function RegisterPage() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try { await register(email, password); nav('/'); }
    catch (err) { setError(err instanceof Error ? err.message : 'register failed'); }
  }
  return (
    <form onSubmit={onSubmit}>
      <h1>Register</h1>
      {error && <p>{error}</p>}
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" />
      <button type="submit">Create account</button>
      <p><Link to="/login">Login</Link></p>
    </form>
  );
}
```

```tsx
// apps/web/src/components/UploadButton.tsx
import { useState } from 'react';
import { api } from '../api/client';
import type { PhotoDto } from '@album/shared';
export function UploadButton({ onUploaded }: { onUploaded: (p: PhotoDto) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <label>
      {busy ? 'Uploading…' : 'Upload photo'}
      <input type="file" accept="image/*" hidden disabled={busy} onChange={async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setBusy(true);
        try {
          const fd = new FormData();
          fd.append('file', file);
          onUploaded(await api<PhotoDto>('/photos', { method: 'POST', body: fd }));
        } finally { setBusy(false); e.target.value = ''; }
      }} />
    </label>
  );
}
```

```tsx
// apps/web/src/components/PhotoGrid.tsx
import { Link } from 'react-router-dom';
import type { PhotoDto } from '@album/shared';
export function PhotoGrid({ items }: { items: PhotoDto[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
      {items.map((p) => (
        <Link key={p.id} to={`/photos/${p.id}`}>
          {p.thumbUrl ? <img src={p.thumbUrl} alt={p.description ?? p.id} style={{ width: '100%', borderRadius: 8 }} /> : <div>{p.status}</div>}
        </Link>
      ))}
    </div>
  );
}
```

```tsx
// apps/web/src/pages/LibraryPage.tsx
import { useEffect, useState } from 'react';
import type { PhotoDto } from '@album/shared';
import { api } from '../api/client';
import { PhotoGrid } from '../components/PhotoGrid';
import { UploadButton } from '../components/UploadButton';
export function LibraryPage() {
  const [items, setItems] = useState<PhotoDto[]>([]);
  useEffect(() => { api<{ items: PhotoDto[] }>('/photos').then((r) => setItems(r.items)); }, []);
  return (
    <div>
      <h1>My library</h1>
      <UploadButton onUploaded={(p) => setItems((prev) => [p, ...prev])} />
      <PhotoGrid items={items} />
    </div>
  );
}
```

```tsx
// apps/web/src/pages/PhotoDetailPage.tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { PhotoDto } from '@album/shared';
import { api } from '../api/client';
export function PhotoDetailPage() {
  const { id } = useParams();
  const [photo, setPhoto] = useState<PhotoDto | null>(null);
  useEffect(() => { if (id) api<PhotoDto>(`/photos/${id}`).then(setPhoto); }, [id]);
  if (!photo) return <p>Loading…</p>;
  return (
    <div>
      <h1>Photo</h1>
      {photo.thumbUrl && <img src={photo.thumbUrl} alt="" style={{ maxWidth: 480 }} />}
      <p>Status: {photo.status}</p>
      <p>{photo.description}</p>
      <p>Tags: {photo.tags.join(', ')}</p>
    </div>
  );
}
```

```tsx
// apps/web/src/pages/ApiKeysPage.tsx
import { FormEvent, useEffect, useState } from 'react';
import type { ApiKeyPublic, CreateApiKeyResponse } from '@album/shared';
import { api } from '../api/client';
export function ApiKeysPage() {
  const [items, setItems] = useState<ApiKeyPublic[]>([]);
  const [name, setName] = useState('my-agent');
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  async function refresh() { setItems((await api<{ items: ApiKeyPublic[] }>('/api-keys')).items); }
  useEffect(() => { void refresh(); }, []);
  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const r = await api<CreateApiKeyResponse>('/api-keys', { method: 'POST', body: JSON.stringify({ name }) });
    setCreatedToken(r.token);
    await refresh();
  }
  return (
    <div>
      <h1>API Keys</h1>
      {createdToken && <p>Copy now: <code>{createdToken}</code></p>}
      <form onSubmit={onCreate}>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">Create</button>
      </form>
      <ul>
        {items.map((k) => (
          <li key={k.id}>
            {k.name} ({k.prefix}…) {k.revokedAt ? 'revoked' : ''}
            {!k.revokedAt && (
              <button onClick={async () => { await api(`/api-keys/${k.id}`, { method: 'DELETE' }); await refresh(); }}>Revoke</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

```tsx
// apps/web/src/components/Layout.tsx
import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
export function Layout() {
  const { user, logout } = useAuth();
  return (
    <div style={{ fontFamily: 'system-ui', margin: '0 auto', maxWidth: 960, padding: 16 }}>
      <nav style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <Link to="/">Library</Link>
        <Link to="/search">Search</Link>
        <Link to="/albums">Albums</Link>
        <Link to="/api-keys">API Keys</Link>
        <span style={{ marginLeft: 'auto' }}>{user?.email}</span>
        <button onClick={logout}>Logout</button>
      </nav>
      <Outlet />
    </div>
  );
}
```

```tsx
// apps/web/src/pages/SearchPage.tsx
export function SearchPage() { return <p>Search coming next task</p>; }
// apps/web/src/pages/AlbumsPage.tsx
export function AlbumsPage() { return <p>Albums coming next task</p>; }
// apps/web/src/pages/AlbumDetailPage.tsx
export function AlbumDetailPage() { return <p>Album detail coming next task</p>; }
// apps/web/src/pages/JoinAlbumPage.tsx
export function JoinAlbumPage() { return <p>Join coming next task</p>; }
```

```tsx
// apps/web/src/App.tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { LibraryPage } from './pages/LibraryPage';
import { PhotoDetailPage } from './pages/PhotoDetailPage';
import { ApiKeysPage } from './pages/ApiKeysPage';
import { SearchPage } from './pages/SearchPage';
import { AlbumsPage } from './pages/AlbumsPage';
import { AlbumDetailPage } from './pages/AlbumDetailPage';
import { JoinAlbumPage } from './pages/JoinAlbumPage';

function Private({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <p>Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/join/:shareSlug" element={<Private><JoinAlbumPage /></Private>} />
        <Route element={<Private><Layout /></Private>}>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/photos/:id" element={<PhotoDetailPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/albums" element={<AlbumsPage />} />
          <Route path="/albums/:id" element={<AlbumDetailPage />} />
          <Route path="/api-keys" element={<ApiKeysPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
```

```tsx
// apps/web/src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><BrowserRouter><App /></BrowserRouter></React.StrictMode>,
);
```

- [ ] **Step 2: Install and typecheck (acts as the failing check before stubs compile)**

Run:
```bash
npm install && npm run build -w @album/shared && npx tsc -p apps/web/tsconfig.json --noEmit
```
Expected: exit 0

- [ ] **Step 3: Production build**

Run: `npm run build -w @album/web`
Expected: PASS (`apps/web/dist` created)

- [ ] **Step 4: Commit**

```bash
git add apps/web package-lock.json
git commit -m "feat(web): React SPA auth library upload and API key management"
```

---

### Task 13: Web search + shared album UI

**Files:**
- Modify: `apps/web/src/pages/{Search,Albums,AlbumDetail,JoinAlbum}Page.tsx`

**Interfaces:**
- Consumes: `POST /photos/search`, album APIs, `x-album-session`
- Produces: UI for MVP acceptance #2 and #4

- [ ] **Step 1: Replace stub SearchPage with real implementation**

```tsx
// apps/web/src/pages/SearchPage.tsx
import { FormEvent, useState } from 'react';
import type { PhotoDto } from '@album/shared';
import { api } from '../api/client';
import { PhotoGrid } from '../components/PhotoGrid';
export function SearchPage() {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<PhotoDto[]>([]);
  const [error, setError] = useState('');
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ items: PhotoDto[] }>('/photos/search', {
        method: 'POST', body: JSON.stringify({ query, mode: 'hybrid', limit: 30 }),
      });
      setItems(r.items);
    } catch (err) { setError(err instanceof Error ? err.message : 'search failed'); }
  }
  return (
    <div>
      <h1>Search</h1>
      <form onSubmit={onSubmit}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="natural language or keyword" style={{ width: '70%' }} />
        <button type="submit">Search</button>
      </form>
      {error && <p>{error}</p>}
      <PhotoGrid items={items} />
    </div>
  );
}
```

- [ ] **Step 2: Replace album stubs**

```tsx
// apps/web/src/pages/AlbumsPage.tsx
import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AlbumDto } from '@album/shared';
import { api } from '../api/client';
export function AlbumsPage() {
  const [items, setItems] = useState<AlbumDto[]>([]);
  const [title, setTitle] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  async function refresh() { setItems((await api<{ items: AlbumDto[] }>('/albums')).items); }
  useEffect(() => { void refresh(); }, []);
  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const album = await api<AlbumDto>('/albums', {
      method: 'POST', body: JSON.stringify({ title, passphrase, defaultRole: 'uploader' }),
    });
    setCreatedSlug(album.shareSlug);
    setTitle(''); setPassphrase('');
    await refresh();
  }
  return (
    <div>
      <h1>Shared albums</h1>
      {createdSlug && <p>Share link path: <code>/join/{createdSlug}</code></p>}
      <form onSubmit={onCreate}>
        <input placeholder="title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input placeholder="passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        <button type="submit">Create</button>
      </form>
      <ul>
        {items.map((a) => (
          <li key={a.id}><Link to={`/albums/${a.id}`}>{a.title}</Link> — slug {a.shareSlug}</li>
        ))}
      </ul>
    </div>
  );
}
```

```tsx
// apps/web/src/pages/JoinAlbumPage.tsx
import { FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { JoinAlbumResponse } from '@album/shared';
import { api } from '../api/client';
const SESSION_KEY = 'album_session_';
export function JoinAlbumPage() {
  const { shareSlug } = useParams();
  const nav = useNavigate();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api<JoinAlbumResponse>(`/albums/join/${shareSlug}`, {
        method: 'POST', body: JSON.stringify({ passphrase }),
      });
      localStorage.setItem(SESSION_KEY + r.album.id, r.sessionToken);
      nav(`/albums/${r.album.id}`);
    } catch (err) { setError(err instanceof Error ? err.message : 'join failed'); }
  }
  return (
    <form onSubmit={onSubmit}>
      <h1>Join album</h1>
      <p>Slug: {shareSlug}</p>
      {error && <p>{error}</p>}
      <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="passphrase" />
      <button type="submit">Join</button>
    </form>
  );
}
```

```tsx
// apps/web/src/pages/AlbumDetailPage.tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { AlbumDto, PhotoDto } from '@album/shared';
import { getToken } from '../api/client';
import { PhotoGrid } from '../components/PhotoGrid';
const SESSION_KEY = 'album_session_';
export function AlbumDetailPage() {
  const { id } = useParams();
  const [album, setAlbum] = useState<AlbumDto | null>(null);
  const [items, setItems] = useState<PhotoDto[]>([]);
  const [busy, setBusy] = useState(false);
  function sessionHeaders(): HeadersInit {
    const h: Record<string, string> = {};
    const token = getToken();
    if (token) h.Authorization = `Bearer ${token}`;
    const session = id ? localStorage.getItem(SESSION_KEY + id) : null;
    if (session) h['x-album-session'] = session;
    return h;
  }
  async function refresh() {
    if (!id) return;
    const meta = await fetch(`/albums/${id}`, { headers: sessionHeaders() }).then((r) => r.json());
    setAlbum(meta.album);
    const photos = await fetch(`/albums/${id}/photos`, { headers: sessionHeaders() }).then((r) => r.json());
    setItems(photos.items);
  }
  useEffect(() => { void refresh(); }, [id]);
  return (
    <div>
      <h1>{album?.title ?? 'Album'}</h1>
      <label>
        {busy ? 'Uploading…' : 'Upload to album'}
        <input type="file" accept="image/*" hidden disabled={busy} onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file || !id) return;
          setBusy(true);
          try {
            const fd = new FormData();
            fd.append('file', file);
            await fetch(`/albums/${id}/photos`, { method: 'POST', headers: sessionHeaders(), body: fd });
            await refresh();
          } finally { setBusy(false); e.target.value = ''; }
        }} />
      </label>
      <PhotoGrid items={items} />
    </div>
  );
}
```

- [ ] **Step 3: Build web**

Run: `npm run build -w @album/web`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages
git commit -m "feat(web): search and shared album join/upload UI"
```

---

### Task 14: MVP acceptance test + Agent API docs

**Files:**
- Create: `apps/api/test/mvpAcceptance.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: all prior API routes
- Produces: automated coverage of MVP acceptance 1–4 at API level

- [ ] **Step 1: Write the failing acceptance test**

```typescript
// apps/api/test/mvpAcceptance.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { withTestApp, type TestContext } from './helpers.js';
import sharp from 'sharp';
import FormData from 'form-data';
import { processNextJob } from '../src/pipeline/worker.js';

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 48, height: 48, channels: 3, background: { r: 120, g: 40, b: 200 } } }).jpeg().toBuffer();
}

describe('MVP acceptance (API)', () => {
  let ctx: TestContext;
  afterEach(async () => { await ctx.app.close(); await ctx.pool.end(); });

  it('covers register/upload/process/search/api-key/shared-album', async () => {
    ctx = await withTestApp();
    const reg = await ctx.app.inject({
      method: 'POST', url: '/auth/register',
      payload: { email: 'mvp@example.com', password: 'password123' },
    });
    expect(reg.statusCode).toBe(201);
    const token = reg.json().token;

    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'm.jpg', contentType: 'image/jpeg' });
    const up = await ctx.app.inject({
      method: 'POST', url: '/photos',
      headers: { authorization: `Bearer ${token}`, ...form.getHeaders() },
      payload: form,
    });
    expect(up.statusCode).toBe(201);

    await processNextJob({
      pool: ctx.pool, storage: (ctx.app as any).storage,
      vision: (ctx.app as any).vision, embed: (ctx.app as any).embed,
    });

    const listed = await ctx.app.inject({
      method: 'GET', url: '/photos', headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.json().items[0].thumbUrl).toBeTruthy();

    const search = await ctx.app.inject({
      method: 'POST', url: '/photos/search',
      headers: { authorization: `Bearer ${token}` },
      payload: { query: 'mock photo', mode: 'hybrid' },
    });
    expect(search.json().items.length).toBeGreaterThan(0);

    const key = await ctx.app.inject({
      method: 'POST', url: '/api-keys',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'agent' },
    });
    const apiToken = key.json().token;
    const agentSearch = await ctx.app.inject({
      method: 'POST', url: '/photos/search',
      headers: { authorization: `Bearer ${apiToken}` },
      payload: { query: 'everyday', mode: 'semantic' },
    });
    expect(agentSearch.statusCode).toBe(200);

    const album = await ctx.app.inject({
      method: 'POST', url: '/albums',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Party', passphrase: 'pass-word', defaultRole: 'uploader' },
    });
    expect(album.statusCode).toBe(201);

    const guestReg = await ctx.app.inject({
      method: 'POST', url: '/auth/register',
      payload: { email: 'guestmvp@example.com', password: 'password123' },
    });
    const join = await ctx.app.inject({
      method: 'POST', url: `/albums/join/${album.json().shareSlug}`,
      headers: { authorization: `Bearer ${guestReg.json().token}` },
      payload: { passphrase: 'pass-word' },
    });
    expect(join.statusCode).toBe(200);

    const form2 = new FormData();
    form2.append('file', await jpeg(), { filename: 'g.jpg', contentType: 'image/jpeg' });
    const guestUp = await ctx.app.inject({
      method: 'POST', url: `/albums/${album.json().id}/photos`,
      headers: {
        authorization: `Bearer ${guestReg.json().token}`,
        'x-album-session': join.json().sessionToken,
        ...form2.getHeaders(),
      },
      payload: form2,
    });
    expect(guestUp.statusCode).toBe(201);
  });
});
```

- [ ] **Step 2: Run test to verify it fails if earlier tasks incomplete, else passes**

Run: `npm run test -w @album/api -- test/mvpAcceptance.test.ts`
Expected: PASS once Tasks 1–11 are complete

- [ ] **Step 3: Append Agent API docs to README**

Append to `README.md`:

```markdown
## Agent API quickstart

```bash
# create a key in the web UI, then:
curl -H "Authorization: Bearer alk_..." -F file=@photo.jpg http://localhost:3000/photos
curl -H "Authorization: Bearer alk_..." -H 'Content-Type: application/json' \
  -d '{"query":"beach sunset","mode":"semantic"}' \
  http://localhost:3000/photos/search
curl -H "Authorization: Bearer alk_..." -H 'Content-Type: application/json' \
  -d '{"description":"override caption","tags":["trip"],"reembed":true}' \
  -X PATCH http://localhost:3000/photos/<id>
```
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/mvpAcceptance.test.ts README.md
git commit -m "test(api): MVP acceptance coverage and agent API docs"
```

---

### Task 15: Deploy notes for Singapore Tencent CVM (Nginx + HTTPS)

**Files:**
- Create: `deploy/nginx.conf.example`, `deploy/CVM.md`, `deploy/album-api.service`
- Modify: `.env.example` (already has prod vars; confirm S3/HTTP providers documented)

**Interfaces:**
- Consumes: built `apps/api` + `apps/web` dist
- Produces: operator runbook for MVP acceptance #5

- [ ] **Step 1: Write systemd unit**

```ini
# deploy/album-api.service
[Unit]
Description=AI Native Photo Album API
After=network.target postgresql.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/album
EnvironmentFile=/opt/album/.env
ExecStart=/usr/bin/node apps/api/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write Nginx example**

```nginx
# deploy/nginx.conf.example
server {
    listen 80;
    server_name album.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name album.example.com;

    ssl_certificate     /etc/letsencrypt/live/album.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/album.example.com/privkey.pem;

    client_max_body_size 30m;

    root /opt/album/apps/web/dist;
    index index.html;

    location /assets/ {
        try_files $uri =404;
    }

    location / {
        try_files $uri /index.html;
    }

    location ~ ^/(auth|photos|api-keys|albums|health|files)(/|$) {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

- [ ] **Step 3: Write CVM runbook**

```markdown
# deploy/CVM.md

# Singapore Tencent CVM deploy

## Prerequisites (operator provides)

- Ubuntu 22.04+ CVM in Singapore with public IP / firewall 80+443
- Domain A record → CVM
- Object storage credentials (S3-compatible / COS)
- Vision + embedding HTTP API keys
- SSH access

## One-time server setup

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx postgresql postgresql-contrib build-essential git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo apt install -y postgresql-16-pgvector || sudo apt install -y postgresql-15-pgvector

sudo -u postgres psql -c "CREATE USER album WITH PASSWORD 'CHANGE_ME';"
sudo -u postgres psql -c "CREATE DATABASE album OWNER album;"
sudo -u postgres psql -d album -c "CREATE EXTENSION IF NOT EXISTS vector;"
sudo -u postgres psql -d album -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

## App deploy

```bash
sudo mkdir -p /opt/album
sudo chown ubuntu:ubuntu /opt/album
cd /opt/album
git clone <YOUR_REPO_URL> .
cp .env.example .env
# edit .env:
# DATABASE_URL=postgres://album:CHANGE_ME@127.0.0.1:5432/album
# JWT_SECRET=<long random>
# STORAGE_DRIVER=s3
# S3_* for COS (endpoint + keys + bucket)
# VISION_PROVIDER=http EMBED_PROVIDER=http + URLs/keys
# CORS_ORIGIN=https://album.example.com

npm install
npm run build
npm run migrate -w @album/api

sudo cp deploy/album-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now album-api

sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/album
# edit server_name + certificate paths
sudo ln -sf /etc/nginx/sites-available/album /etc/nginx/sites-enabled/album
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d album.example.com
```

## Verify MVP #5

```bash
curl -fsS https://album.example.com/health
# expect {"ok":true,"service":"album-api"}
```

Open the site, register, upload one photo, create an API key, create a shared album.
```

- [ ] **Step 4: Commit**

```bash
git add deploy .env.example
git commit -m "docs(deploy): Nginx HTTPS and CVM runbook for Singapore host"
```

---

## Self-Review (spec coverage)

| Spec requirement | Task(s) |
|---|---|
| Email/password web auth | Task 5, 12 |
| API Key Bearer for Agents; hashed; name/revoke/lastUsed | Task 6, 12 |
| Personal library upload/browse/delete | Task 7, 12 |
| Shared album link + passphrase; roles; expire/lock | Task 11, 13 |
| Photo metadata + status processing/ready/failed | Task 7–9 |
| Auto EXIF + vision + embed pipeline; retry; keep original on fail | Task 8–9 |
| Agent override metadata + re-embed | Task 9 |
| Semantic + keyword search | Task 10, 13 |
| REST photos/albums/search | Tasks 7–11 |
| Node + React + Postgres/pgvector on CVM | Tasks 1–2, 12, 15 |
| Object storage adapter (local test + S3/COS prod) | Task 3 |
| External vision/embed providers | Task 4 |
| Nginx + HTTPS deploy | Task 15 |
| MVP acceptance 1–5 | Tasks 12–15 (Task 14 automates 1–4) |
| Non-goals respected | Global Constraints; no tasks add social feed/App/billing/on-box LLM |

**Placeholder scan:** no TBD/TODO/"implement later"/"similar to Task N" left as unfinished work. Task 12 stubs are explicitly replaced by Task 13 with full code.

**Type consistency:**
- Auth header: `Authorization: Bearer …` (JWT or `alk_…` API key)
- Album guest session: `x-album-session` + `JoinAlbumResponse.sessionToken` (`als_…`)
- Photo statuses: `processing | ready | failed`
- Album roles: `owner | uploader | viewer`
- Embedding: `vector(1536)` aligns with default `EMBED_DIMENSIONS=1536`

## Open decisions for the implementer (operator inputs; not design blockers)

1. Exact vision/embed HTTP vendor URLs and model names (code defaults assume OpenAI-compatible shapes).
2. Production domain name and certbot contact email.
3. COS/S3 bucket, endpoint, and whether objects are private (signed URL) or CDN-public (`publicBaseUrl` on S3 adapter).
4. If embedding model dimensions ≠ 1536, change both `EMBED_DIMENSIONS` and migration `vector(N)` together.
5. Git remote URL for the CVM clone step in `deploy/CVM.md`.
6. Resumable/chunked upload (design mentions 中断续传) is intentionally deferred past MVP acceptance; MVP uses single-request multipart ≤25MB. Add a follow-up plan if large-file resume is required.

Tasks 1–14 can proceed fully with mocks + local storage + docker-compose Postgres.
