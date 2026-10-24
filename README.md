# Datascribe LPO Platform

Medical record review for law firms: marketing site, client portal, staff console, CRM, billing,
API and processing pipeline. Spec: [REQUIREMENTS.md](REQUIREMENTS.md). Status: [STATUS.md](STATUS.md).

## Layout

```
apps/api           Express API (/api/v1)
apps/web           Next.js: marketing site, /portal, /console
apps/worker        BullMQ processing pipeline
apps/cms           Payload CMS (M3)
packages/db        Prisma schema, migrations, seed
packages/shared    Permissions, CASL abilities, PHI crypto, constants
packages/medical-data  Medical API adapters (M5)
packages/ui        Shared React components
docs/              DECISIONS.md, CHANGELOG.md, demos/
```

## Prerequisites

- Node 22+ and pnpm 9 (`packageManager` is pinned)
- Docker for Postgres, Redis, S3 (SeaweedFS) and Mailpit. On the Mac Studio this is Colima: `colima start`

## Run locally

```
pnpm install
cp .env.example .env
pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Fill in `.env` first: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PHI_ENCRYPTION_KEY` (32 bytes base64,
`openssl rand -base64 32`) and `SEED_USER_PASSWORD`. If something else already uses port 5432, set
`POSTGRES_PORT=5433` and change the port in `DATABASE_URL` to match.

## Checks

```
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

API tests use a throwaway `datascribe_test` database on the same Postgres and `ds-test-*` buckets on
the local S3 (`pnpm infra:up`). Local SeaweedFS has no server-side encryption, so set `S3_SSE=none`
in `.env`; production requires `AES256` or `aws:kms`. Uploads are virus-scanned by the worker
(`pnpm --filter @datascribe/worker dev`; documents stay "Scanning" without it), with a mock scanner
unless `CLAMAV_HOST` is set (`docker compose --profile scan up -d`). Browser E2E (needs
`pnpm infra:up` for Mailpit and Redis; starts its own API, web and worker; uses the installed Google
Chrome and a `datascribe_e2e` database):

```
pnpm --filter @datascribe/web e2e
```

## Where things are

- Staff console: http://localhost:3010/console (CRM at `/console/crm`, finance at
  `/console/finance`, admin at `/console/admin`: users, roles, organizations, settings, audit log)
- Client portal: http://localhost:3010/portal (cases, uploads, billing, firm)
- Staff console: http://localhost:3010/console (CRM at `/console/crm`)
- Website contact / demo form: http://localhost:3010/contact
- API: http://localhost:4000/api/v1 (also proxied at http://localhost:3010/api/v1)
- Mailpit (all dev email): http://localhost:8025

## Rules that matter

- Only synthetic data (Synthea-style) in dev, tests and seeds. Never log or send PHI anywhere.
- Every client-data query is scoped by `organizationId`; every route enforces permissions on the server.
- Secrets come from `.env` only (git-ignored). Keep `.env.example` current.
