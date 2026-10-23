# Changelog

## M0 — Foundation (2026-10-23, done locally; CI pending a GitHub remote)

Built:

- pnpm + Turborepo monorepo: `apps/{api,web,worker,cms}`, `packages/{db,shared,medical-data,ui}`.
- Prisma schema with every model in §6 (plus `Counter` for gap-free numbering), validated and generated.
- `packages/shared`: permission catalogue (16 modules × 7 actions × 4 scopes), default role matrix,
  CASL ability builder, AES-256-GCM PHI encryption helpers.
- Idempotent seed: roles, permissions, 3 plans, 1 internal + 2 client orgs, 1 user per role
  (+ second-firm admin), 3 synthetic cases with encrypted patient names.
- API skeleton (Express 5): helmet, strict CORS, request ids, pino JSON logs without bodies/queries,
  env validation including the production LLM/BAA guard (§8.3).
- Worker skeleton: BullMQ queues for the 7 pipeline stages (no-op processors until M5).
- Web skeleton (Next 15 App Router + Tailwind 4, placeholder brand tokens).
- Docker Compose: Postgres 16, Redis 7, SeaweedFS S3 (replaces MinIO, D-014), Mailpit, ClamAV (opt-in profile).
- First migration `init`, including a DB trigger that makes `AuditLog` append-only and RESTRICT FKs on it.
- GitHub Actions CI: format, lint, typecheck, test, build.

Tests: 90 passing (83 shared, 6 api, 1 worker). Coverage: shared 90.8% lines, api 96.8% lines.
Verified locally: migrate, seed (idempotent), `pnpm dev` (api/worker/web up, health 200).

Open:

- CI has not run on GitHub yet (no remote). "Seed users can log in" is satisfied once M1 adds login.
