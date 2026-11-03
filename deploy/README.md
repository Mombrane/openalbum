# Deploy — OpenAlbum

Build, local run, and Singapore CVM deploy outlines. **No real credentials belong in this folder** — copy `env.example` to a private `.env` (or systemd `EnvironmentFile`) outside git.

## Layout

| Path | Purpose |
|------|---------|
| `env.example` | All required env vars with placeholders |
| `db/schema.sql` | Evolving DDL sketch (source of truth for ops sketch; app migrations must stay aligned) |
| `db/CONNECTION.md` | How to connect to Postgres (placeholders) |
| `nginx.example.conf` | Reverse proxy TLS termination sketch |
| `systemd/photo-api.service.example` | API process unit sketch |

## Local development

1. Copy `deploy/env.example` → repo-root `.env` and fill placeholders (local DB password, mock AI keys OK).
2. Start DB: `docker compose up -d` (pgvector-enabled Postgres).
3. Apply schema: see `db/CONNECTION.md` (`psql` against local URL).
4. Run API / Web per root README scripts (`dev:api`, `dev:web`) once Phase 0 lands.
5. Object storage: use MinIO locally or a side bucket; keep keys in `.env` only.

## Build (outline)

```bash
# after Phase 0 scaffold exists
npm ci
npm run build -w apps/api
npm run build -w apps/web
```

Artifacts: API `dist/`; Web static files under `apps/web/dist` (served by Nginx or API static hook).

## Singapore CVM deploy (outline)

1. Provision Ubuntu (or similar) on Tencent Singapore; open 80/443; SSH key auth.
2. Install Node 20+, Docker (optional for DB) or native Postgres 16 + `pgvector`.
3. Create DB role/database; apply `db/schema.sql` (and later app migrations).
4. Place private env file e.g. `/etc/photo-album/api.env` from `env.example`.
5. Configure S3-compatible (COS) bucket; put keys only in the env file.
6. Install systemd unit from `systemd/photo-api.service.example`; `daemon-reload && enable --now`.
7. Point domain A/AAAA to the CVM; install certbot; use `nginx.example.conf` as base.
8. Smoke: `GET /health`, register user, upload one photo.

## Secrets checklist

- [ ] DB password
- [ ] JWT signing secret
- [ ] S3/COS access key + secret
- [ ] Vision API key
- [ ] Embed API key
- [ ] Album passphrase hashing pepper (if separate)

Never commit filled values. Rotate if leaked.
