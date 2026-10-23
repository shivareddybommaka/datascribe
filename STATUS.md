# Datascribe — STATUS

## Current state (2026-10-24)

Remote: https://github.com/shivareddybommaka/datascribe (private, deploy key, host alias
`github-datascribe`). Infra on Colima, all bound to 127.0.0.1: Postgres 16 (:5433; :5432 is Shiva's
existing CRM, never touch), Redis 7, SeaweedFS S3 (:9000), Mailpit (:8025). CMS DB `datascribe_cms`.

| Milestone                     | State                              | Notes                                                                                            |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| M0 Foundation                 | done                               |                                                                                                  |
| M1 Auth + RBAC                | done                               | security fixes from the audit applied                                                            |
| M2 Admin console              | **in progress (master)**           | done: users API (D-022). Next: roles matrix API, orgs, settings, audit viewer, impersonation, UI |
| M3 Website + CMS              | done (merged from `storefront/m3`) | Lighthouse ≥ 90 not measured yet (needs Lighthouse install)                                      |
| M4 Portal cases + uploads     | done on `portal/m4` (to merge)     | DoD test green (300-page PDF, interrupted + resumed); D-070..D-077                               |
| M5 Pipeline                   | M5a adapters done (merged)         | M5b: take over the scan stage from the API (`verifyDocument`, D-072)                             |
| M6 Workspace + QA + delivery  | not started                        |                                                                                                  |
| M7 CRM                        | done                               |                                                                                                  |
| M8 Billing                    | done (merged from `ledger/m8`)     | portal pay-by-card screen built in M4; Stripe test key needed for the manual test-card demo      |
| M9 Notifications + dashboards | not started                        |                                                                                                  |
| M10 Hardening                 | not started                        |                                                                                                  |

Tests on `main`: lint, typecheck, unit/API tests and build green (33/33 turbo tasks; API 162 tests
incl. 13 admin-users); Playwright e2e 12/12 (CRM 3, finance 3, marketing 6) as of the M8 merge.
On `portal/m4`: 33/33 turbo tasks, API 211 tests, Playwright 16/16 (+ portal 3).

M4 merge notes: main's `.env` needs `S3_SSE=none` (local SeaweedFS has no SSE, D-070) or the API's
uploads fail; the API creates the buckets at startup and encrypts legacy case notes / messages
(L5 backfill). Real ClamAV: `docker compose --profile scan up -d` + `CLAMAV_HOST=localhost`.

M2 plan (in order): 1 users API ✅ · 2 roles API (list/create custom/edit matrix, system roles
undeletable, user role assignment ≤ caller's grants = audit M4) · 3 orgs API (edit plan, custom pricing,
suspend) · 4 settings API · 5 audit viewer + CSV · 6 read-only impersonation + banner · 7 console UI +
e2e (custom role takes effect without restart) · 8 audit M2 lockout race.

## Autopilot

Rules: `docs/AUTOPILOT.md`. OpenClaw automation "Datascribe autopilot" (id
`a0d9299e-b264-4e09-8e61-60682d25c151`) resumes work on a paced loop (1–6 h). "stop autopilot" removes it.
Remaining order: M2 → M4 → M5b → M6 → M9 → M10.

## Agent team

Master **datascribe-dev** (`agent:datascribe:main`) merges into `main`; subagents work in git worktrees
under `.worktrees/` (own `.env`, ports, `datascribe_<name>_*` DBs on 5433) and report to the master.
Named agents: datascribe-storefront (web/CMS), datascribe-ledger (billing), datascribe-pipeline
(processing pipeline), datascribe-auditor (read-only security/PHI review). DECISIONS numbering per
agent: storefront D-030+, ledger D-040+, pipeline D-050+.

## Waiting on Shiva

- Telegram control: create a Telegram group with the bot (bot as admin or privacy off), send a
  message, send the group id (forward to @RawDataBot). Then the binding is proposed via OpenClaw.
- Lighthouse install (M3 performance/SEO check): yes / later.
- Free openFDA API key before production (D-052). Should QA reviewers use medical lookups (D-056)?
- Stripe test key for the manual M8 test-card demo. CMS email adapter choice (editor password reset).
- CI result on GitHub Actions (agent can't read Actions with the deploy key).

## Security review (datascribe-auditor)

No critical findings; §4.4 PHI rules verified. Fixed: H1, M1, M3, M7 (nodemailer 10, 2026-10-24),
M8, M9. Open:

- M2 lockout bypass with concurrent guesses (with M2). M4 invites ≤ inviter's permissions (with M2).
- M5 absolute session lifetime + re-check MFA policy on refresh. M6 trust-proxy, per-account limits.
- Low: L1 revoke reason vs reuse alerts, L2 kill other reset tokens, L3 unverified-account squatting,
  L6 PHI notice on lead form, L7 Prisma error logging, L8 single-use MFA token, L9 timing, L10
  conversion email domain, L11 non-owner DB role, L12 pin images/actions. (L4 audit case list and L5
  encrypt Case.notes / Message.body: fixed on `portal/m4`.)

## Known follow-ups

- Dependency advisories (pnpm audit --prod, 2026-10-24): 0 critical. Left: deepmerge-ts (high, via
  the Prisma 6 CLI config loader; fixed by the planned Prisma upgrade) and esbuild 0.18 (moderate, dev
  server CORS, via drizzle-kit migrations tooling; not served). CMS on next 16.4.3, sharp 0.35.5;
  overrides for dompurify/postcss/sharp in root package.json (D-020).

- Upgrade pass (D-001): Prisma, Vitest, ESLint, TypeScript, otplib.
- Usage stats and rate limits are in-memory; move to Redis (M10). E2E in CI (M10).
- `apps/cms/scripts/tmp-edit-home.ts` (untracked, storefront's one-off check script) can be removed.
- Ask Datascribe for an SVG logo.
