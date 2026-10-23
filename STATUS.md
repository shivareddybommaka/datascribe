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
- **M3 Marketing website + CMS: built on branch `storefront/m3`** (worktree `.worktrees/storefront`),
  waiting on Nova to merge. Demo: `docs/demos/M3.md`; design notes D-030. Lighthouse ≥ 90 on Home not
  yet measured (Lighthouse not installed).
- Agent exec works again (pnpm runs); earlier `operator.approvals` block cleared on 2026-10-24.

## Autopilot (from 2026-10-24)

- Shiva authorised self-managed building. Rules: `docs/AUTOPILOT.md`. OpenClaw automation
  "Datascribe autopilot" (id `a0d9299e-b264-4e09-8e61-60682d25c151`) resumes work on a paced loop
  (1–6 h). Stop it by telling Datascribe Dev "stop autopilot".
- **Current milestone: M2 Admin console** (spec order: M2 → M3 → M4 → M5 → M6 → M8 → M9 → M10).

## Waiting on Shiva

- CI result on GitHub Actions for the latest push (agent can't read Actions with the deploy key).
  CI runs lint/typecheck/unit+API tests/build; e2e is local only until M10.
- M3: approve installing Lighthouse (e.g. `lighthouse` as a dev dependency) to measure the
  performance/SEO ≥ 90 AC on Home, and decide on an email adapter for CMS editor password resets.

## Known follow-ups

- Upgrade pass (D-001): Prisma 6→newer, Vitest, ESLint, TypeScript, otplib (deprecated sub-packages).
- TOTP replay within one 30 s step not yet blocked (D-017), M10.
- Rate limits are in-memory; move to Redis for multi-instance (M10).
- CRM notifications (lead assigned, task due) arrive with M9.
- Ask Datascribe for an SVG logo.
