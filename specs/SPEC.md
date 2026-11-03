# OpenAlbum — Project Spec Entry

**Status:** active  
**Product design:** [`docs/superpowers/specs/2026-11-03-ai-native-photo-album-design.md`](../docs/superpowers/specs/2026-11-03-ai-native-photo-album-design.md)  
**Deploy:** [`deploy/README.md`](../deploy/README.md)  
**Domain overview:** [`domain/overview.md`](domain/overview.md)

This folder is the **authoritative source of truth** for implementation. Do not implement features that are not covered by a phase Spec marked `ready` or `in_progress`. The older monolithic plan under `docs/superpowers/plans/` is historical only.

## How to work a phase

1. Read this index and the phase file under `phases/`.
2. Confirm dependencies are `done`.
3. Set the phase status to `in_progress` in the table below (same PR/commit as starting work is fine).
4. Implement only **In scope**; refuse scope creep into later phases.
5. Meet **Acceptance criteria**; update status to `done`.
6. Keep `deploy/db/schema.sql` and env docs in sync when the phase changes persistence or ops.

## Definition of done (any phase)

- [ ] All acceptance criteria in the phase Spec are satisfied
- [ ] Automated tests required by the phase pass (or documented manual checks for deploy-only items)
- [ ] Layering respected: domain has no infra imports
- [ ] This index table status updated to `done`
- [ ] No secrets committed; only placeholders in `deploy/`

## Phase index

| Phase | Spec | Status | Summary |
|------:|------|--------|---------|
| 0 | [phases/00-scaffold.md](phases/00-scaffold.md) | planned | Monorepo, DDD empty packages, compose, deploy stubs |
| 1 | [phases/01-identity-auth.md](phases/01-identity-auth.md) | planned | Users, JWT session, API keys |
| 2 | [phases/02-personal-library.md](phases/02-personal-library.md) | planned | Personal photo CRUD + object storage |
| 3 | [phases/03-processing-pipeline.md](phases/03-processing-pipeline.md) | planned | EXIF, thumbs, vision, embed, jobs |
| 4 | [phases/04-search.md](phases/04-search.md) | planned | Keyword + vector search |
| 5 | [phases/05-shared-albums.md](phases/05-shared-albums.md) | planned | Shared albums, passphrase, roles |
| 6 | [phases/06-web-ui.md](phases/06-web-ui.md) | planned | React UI polish & E2E happy paths |

## How to add a phase

1. Create `specs/phases/NN-short-name.md` using the same sections as existing phases (Goal, In/Out of scope, Domain touches, Acceptance, Depends on).
2. Add a row to the table above with status `planned`.
3. Link any new domain notes under `specs/domain/` if a new bounded context appears.
4. Do not reorder completed phases; append or insert with a clear dependency note.

## Global constraints (all phases)

- Backend: Node + TypeScript; packages under `apps/api/src/{interfaces,adapters,domain,gateways,dao}`
- Frontend: React (Vite) in `apps/web`
- DB: PostgreSQL + pgvector on Singapore CVM (local compose for dev)
- Object storage: S3-compatible; credentials via env placeholders only
- Agents: `Authorization: Bearer <apiKey>`; keys stored hashed
- No LLM inference on the CVM; external vision/embed HTTP APIs only
