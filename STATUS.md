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
- **M8 Billing + subscriptions: done on branch `ledger/m8`** (worktree `.worktrees/ledger`, not yet
  merged). Billing package, API, worker jobs, finance console. Tests: api 130, billing 36, shared 83,
  worker 5, e2e 6. Demo: `docs/demos/M8.md`. Portal billing screens (firm pays by card) still to build.
- Agent exec works again (pnpm runs); earlier `operator.approvals` block cleared on 2026-10-24.

## Autopilot (from 2026-10-24)

- Shiva authorised self-managed building. Rules: `docs/AUTOPILOT.md`. OpenClaw automation
  "Datascribe autopilot" (id `a0d9299e-b264-4e09-8e61-60682d25c151`) resumes work on a paced loop
  (1–6 h). Stop it by telling Datascribe Dev "stop autopilot".
- **Current milestone: M2 Admin console** (spec order: M2 → M3 → M4 → M5 → M6 → M8 → M9 → M10).

## Agent team (from 2026-10-24 01:15)

Master: **datascribe-dev** (this agent, session `agent:datascribe:main`) works on M2 and merges
everyone's branches into `main`. Subagents work in git worktrees under `.worktrees/` (git-ignored),
each with its own `.env`, ports and databases on 5433 (`datascribe_<name>_dev` / `_test`):

| Subagent              | Branch                 | Scope                                                               | Ports                        |
| --------------------- | ---------------------- | ------------------------------------------------------------------- | ---------------------------- |
| datascribe-storefront | `storefront/m3`        | M3 website + Payload CMS, public plans endpoint                     | web 3200, api 4200, cms 3201 |
| datascribe-ledger     | `ledger/m8`            | M8 billing, Stripe test mode behind PaymentGateway, finance console | web 3300, api 4300           |
| datascribe-pipeline   | `pipeline/m5-adapters` | M5 medical-data adapters, deidentifyTerm, /medical routes           | api 4400                     |
| datascribe-auditor    | `auditor/review-m1-m7` | read-only security + PHI review of M0/M1/M7                         | —                            |

DECISIONS numbering per agent to avoid clashes: storefront D-030+, ledger D-040+, pipeline D-050+.
Only the master runs e2e and pushes.

## Waiting on Shiva

- Telegram control: create a Telegram group with the existing bot (bot as admin or privacy off), send
  a message, send the group id (forward a message to @RawDataBot). Then the binding to the
  `datascribe` agent is proposed via OpenClaw for approval.

- CI result on GitHub Actions for the latest push (agent can't read Actions with the deploy key).
  CI runs lint/typecheck/unit+API tests/build; e2e is local only until M10.

## Security review (datascribe-auditor, 2026-10-24)

No critical findings; §4.4 PHI rules verified. Fixed on main: H1, M1, M3, M8, M9 (compose binding
applies after the next `docker-compose up -d`, once subagents finish). Open:

- M2 lockout bypass with concurrent guesses: atomic attempt reservation (with M2 milestone).
- M4 invites must not grant more than the inviter holds (with M2 custom roles).
- M5 absolute session lifetime; re-check MFA policy and status on refresh.
- M6 trust-proxy and per-account limits; M7 nodemailer 6 → 10 major upgrade (needs Shiva's OK).
- Low: L1 revoke reason vs reuse alerts, L2 kill other reset tokens, L3 unverified-account
  squatting, L4 audit case list, L5 encrypt Case.notes / Message.body, L6 PHI notice on lead form,
  L7 Prisma error logging, L8 single-use MFA token, L9 timing, L10 conversion email domain,
  L11 non-owner DB role, L12 pin images/actions.

## Known follow-ups

- Upgrade pass (D-001): Prisma 6→newer, Vitest, ESLint, TypeScript, otplib (deprecated sub-packages).
- TOTP replay within one 30 s step not yet blocked (D-017), M10.
- Rate limits are in-memory; move to Redis for multi-instance (M10).
- CRM notifications (lead assigned, task due) arrive with M9.
- Ask Datascribe for an SVG logo.
