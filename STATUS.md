# Datascribe — STATUS

## Current state (2026-10-23)

- **M0 Foundation: done locally.** Only GitHub CI is outstanding (no remote yet).
  - lint, typecheck, test (90 passing; coverage shared 90.8%, api 96.8%) and build pass.
  - Infra on Colima: Postgres 16 (:5433, confirmed; :5432 is the existing CRM, never touch), Redis 7, SeaweedFS S3 (:9000), Mailpit (:8025).
  - Migration `init` applied (AuditLog append-only trigger verified). Seed is idempotent.
  - `pnpm dev`: api :4000, worker, web :3000 all start; health check returns 200.
- Tooling (account `nova`): pnpm at `~/.local/bin/pnpm`; `colima start` after a reboot.
- MinIO images were withdrawn upstream, so local S3 uses SeaweedFS (D-014).

## Waiting on Shiva

- (4) Build order: strict M0→M10, or M0→M1→M7 (CRM) first.
- (5) Private GitHub remote for CI: create now or later.

## Next steps

- M1 Auth + RBAC: register/login/refresh rotation/MFA, lockout, permission + org-scoping middleware,
  audit middleware, cross-org and sales/finance PHI API tests.
