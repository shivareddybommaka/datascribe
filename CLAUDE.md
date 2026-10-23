# CLAUDE.md — Datascribe

Stable context for agents. Spec: `REQUIREMENTS.md`. Current state: `STATUS.md`. Autopilot rules:
`docs/AUTOPILOT.md`. Design decisions: `docs/DECISIONS.md` (read the relevant D-entry before changing
that area).

## Commands (account `nova`, repo root, one command per call, no pipes or &&)

- pnpm: `/Users/nova/.local/bin/pnpm`
- Infra: `colima start`, `pnpm infra:up` (Postgres :5433, Redis, SeaweedFS S3 :9000, Mailpit :8025)
- Gates: `pnpm format`, `pnpm turbo run lint typecheck test build --output-logs=errors-only`
- API tests only: `pnpm --filter @datascribe/api exec vitest run --reporter=dot`
- E2E: `pnpm --filter @datascribe/web e2e` (system Chrome, `datascribe_e2e` DB, needs Mailpit)
- DB: `pnpm db:migrate` (dev), `pnpm db:seed`, `pnpm --filter @datascribe/db generate`

## Layout

- `apps/api` Express 5: `src/routes/*` (CRM under `routes/crm`), auth in `src/auth`, tests in `test/`
  (`helpers.ts`: `buildApp`, `login`, `SEED`). Deps are injected via `createApp(deps)`.
- `apps/web` Next 15: console under `app/console`, UI primitives in `components/ui.tsx`, API client
  `lib/api.ts` (same-origin via rewrites). Import enums from `@datascribe/shared/constants` in browser
  code, never the package root (it exports Node crypto).
- `apps/web/app/(marketing)` public site, CMS reads in `lib/cms.ts`; `apps/cms` Payload (own DB,
  `CMS_DATABASE_URL`, D-030); shared content types/defaults in `packages/site-content`.
- Parallel E2E: set `E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_DATABASE_URL` (5433, `datascribe_<tree>_e2e`).
- `packages/db` Prisma schema, migrations, `prisma/seed-lib.ts`. `packages/shared` permissions, CASL, crypto.

## Rules that always apply

- Never touch Postgres on **5432** (Shiva's existing CRM). Datascribe uses 5433; tests use `_test` / `_e2e`.
- Synthetic data only. Never log PHI, request bodies or document text. Mailpit only, no real email.
- Every route: Zod validation, permission check on the server, org scoping; audit document/deliverable access.
- Client-org users never get `all` scope; CRM routes are internal-only.
- Keep `.env` out of git; update `.env.example` when adding variables.
- Commit small steps with clear messages after gates pass; update `STATUS.md`, CHANGELOG and demos per milestone.
- Report to Shiva on Telegram (channel telegram, target 1394929787): answer first, then detail.
