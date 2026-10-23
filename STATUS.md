# Datascribe — STATUS

## Current state (2026-10-24)

Remote: https://github.com/shivareddybommaka/datascribe (private, deploy key, host alias
`github-datascribe`). Infra on Colima, all bound to 127.0.0.1: Postgres 16 (:5433; :5432 is Shiva's
existing CRM, never touch), Redis 7, SeaweedFS S3 (:9000), Mailpit (:8025). CMS DB `datascribe_cms`.

| Milestone                     | State                              | Notes                                                                                         |
| ----------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| M0 Foundation                 | done                               |                                                                                               |
| M1 Auth + RBAC                | done                               | security fixes from the audit applied                                                         |
| M2 Admin console              | **next (master)**                  | users, roles matrix, orgs, settings, audit viewer, impersonation                              |
| M3 Website + CMS              | done (merged from `storefront/m3`) | Lighthouse ≥ 90 not measured yet (needs Lighthouse install)                                   |
| M4 Portal cases + uploads     | not started                        |                                                                                               |
| M5 Pipeline                   | M5a adapters done (merged)         | M5b pipeline stages need M4 uploads                                                           |
| M6 Workspace + QA + delivery  | not started                        |                                                                                               |
| M7 CRM                        | done                               |                                                                                               |
| M8 Billing                    | done (merged from `ledger/m8`)     | portal pay-by-card screen comes with M4; Stripe test key needed for the manual test-card demo |
| M9 Notifications + dashboards | not started                        |                                                                                               |
| M10 Hardening                 | not started                        |                                                                                               |

Tests on `main` after merging: lint, typecheck, unit/API tests and build green (33/33 turbo tasks);
Playwright e2e 12/12 (CRM 3, finance 3, marketing 6).

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
- nodemailer 6 → 10 upgrade (audit M7): yes / later.
- Lighthouse install (M3 performance/SEO check): yes / later.
- Free openFDA API key before production (D-052). Should QA reviewers use medical lookups (D-056)?
- Stripe test key for the manual M8 test-card demo. CMS email adapter choice (editor password reset).
- CI result on GitHub Actions (agent can't read Actions with the deploy key).

## Security review (datascribe-auditor)

No critical findings; §4.4 PHI rules verified. Fixed: H1, M1, M3, M8, M9. Open:

- M2 lockout bypass with concurrent guesses (with M2). M4 invites ≤ inviter's permissions (with M2).
- M5 absolute session lifetime + re-check MFA policy on refresh. M6 trust-proxy, per-account limits.
- Low: L1 revoke reason vs reuse alerts, L2 kill other reset tokens, L3 unverified-account squatting,
  L4 audit case list, L5 encrypt Case.notes / Message.body, L6 PHI notice on lead form, L7 Prisma error
  logging, L8 single-use MFA token, L9 timing, L10 conversion email domain, L11 non-owner DB role,
  L12 pin images/actions.

## Known follow-ups

- Upgrade pass (D-001): Prisma, Vitest, ESLint, TypeScript, otplib.
- Usage stats and rate limits are in-memory; move to Redis (M10). E2E in CI (M10).
- `apps/cms/scripts/tmp-edit-home.ts` (untracked, storefront's one-off check script) can be removed.
- Ask Datascribe for an SVG logo.
