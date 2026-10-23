# Datascribe — STATUS

## Current state (2026-10-23)

- **M0 Foundation: code complete, not yet verified against live infrastructure.**
  - Monorepo, full Prisma schema, permission matrix + CASL, PHI crypto, seed script, API/worker/web
    skeletons, Docker Compose, CI workflow.
  - lint, typecheck, test (90 passing; coverage shared 90.8%, api 96.8%) and build all pass locally.
  - Not yet run: first migration, seed, `pnpm dev` with services, CI on GitHub.
- pnpm 9.15.9 installed at `~/.local/bin/pnpm` (account `nova`). Not on PATH by default.
- Local `.env` created (git-ignored) with generated dev secrets; DB points at Docker Postgres on 5433.

## Waiting on Shiva

- (2) Local infra: install OrbStack (or Docker Desktop) from the `admin` account.
- (3) Postgres: confirm the separate Docker Postgres on 5433 (current default) vs the existing 5432 server.
- (4) Build order: strict M0→M10, or M0→M1→M7 (CRM) first.
- (5) Private GitHub remote for CI: create now or later.

## Next steps

- Once Docker is available: `docker compose up -d`, first migration (+ AuditLog append-only trigger),
  seed, `pnpm dev` smoke test, then close M0.
- Then M1 Auth + RBAC (can start the non-DB parts in the meantime).
