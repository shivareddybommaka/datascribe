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

## Rules that matter

- Only synthetic data (Synthea-style) in dev, tests and seeds. Never log or send PHI anywhere.
- Every client-data query is scoped by `organizationId`; every route enforces permissions on the server.
- Secrets come from `.env` only (git-ignored). Keep `.env.example` current.
