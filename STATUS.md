# Datascribe — STATUS

## Current state (2026-10-24)

- **Build order: M0 → M1 → M7 (CRM first)**, Shiva's decision (D-016).
- **M0 Foundation: done.** Remote: https://github.com/shivareddybommaka/datascribe (private, deploy key,
  host alias `github-datascribe`). Infra on Colima: Postgres 16 (:5433; :5432 is the existing CRM, never
  touch), Redis 7, SeaweedFS S3 (:9000), Mailpit (:8025).
- **M1 Auth + RBAC: done.** Commit `cafeed9`, pushed. 59/59 tests, typecheck and lint green (run by Nova).
  First CI run with the test Postgres is pending; Shiva to confirm.
- **M7a CRM API: written, checks pending.** Leads, pipeline summary, convert-to-client, contacts,
  activities + my-tasks, accounts, CSV import/export, public website lead endpoint. Tests in
  `apps/api/test/crm.test.ts` and `src/lib/csv.test.ts`. Uncommitted.
- **M7b CRM UI: not started.** Needs UI packages (TanStack Query, React Hook Form, Zod resolver, shadcn/ui
  deps); an install must be run for us.

## Blockers

- Agent exec can't run pnpm/node: `missing scope: operator.approvals`. Nova runs format, lint,
  typecheck, test and commit for us. Fixing the scope is OpenClaw config, so it needs Shiva's OK.

## Waiting on Shiva / Nova

- Nova: run gates for M7a (format → lint → typecheck → test), then commit.
- Shiva: CI result for `cafeed9`.

## Next steps

- M7b: console login (password + TOTP), CRM pipeline board and table, lead detail with activities,
  convert dialog, accounts, contacts, My tasks today widget, CSV import/export buttons.
