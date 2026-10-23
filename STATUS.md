# Datascribe — STATUS

## Current state (2026-10-24)

- **Build order: M0 → M1 → M7 (CRM first)**, Shiva's decision (D-016).
- **M0 Foundation: done.** Remote: https://github.com/shivareddybommaka/datascribe (private, deploy key,
  host alias `github-datascribe`). Infra on Colima: Postgres 16 (:5433; :5432 is the existing CRM, never
  touch), Redis 7, SeaweedFS S3 (:9000), Mailpit (:8025).
- **M1 Auth + RBAC: done** (`cafeed9`).
- **M7 CRM: done.** API (`94eaf55`) + console UI + E2E (this commit).
  - Tests: api 95, shared 83, worker 1, Playwright e2e 3. Lint, typecheck, format and build green.
  - Demo: `docs/demos/M7.md`.
- Agent exec works again (pnpm runs); earlier `operator.approvals` block cleared on 2026-10-24.

## Waiting on Shiva

- CI result on GitHub Actions for the latest push. CI runs lint/typecheck/unit+API tests/build;
  e2e is local only until M10.
- Next milestone choice: M2 admin console (next in spec order) or M3 website + CMS (the contact form
  already feeds the CRM).

## Known follow-ups

- Upgrade pass (D-001): Prisma 6→newer, Vitest, ESLint, TypeScript, otplib (deprecated sub-packages).
- TOTP replay within one 30 s step not yet blocked (D-017), M10.
- Rate limits are in-memory; move to Redis for multi-instance (M10).
- CRM notifications (lead assigned, task due) arrive with M9.
- Ask Datascribe for an SVG logo.
