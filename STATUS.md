# Datascribe — STATUS

## Current state (2026-10-24)

Remote: https://github.com/shivareddybommaka/datascribe (private, deploy key, host alias
`github-datascribe`). Infra on Colima, all bound to 127.0.0.1: Postgres 16 (:5433; :5432 is Shiva's
existing CRM, never touch), Redis 7, SeaweedFS S3 (:9000), Mailpit (:8025). CMS DB `datascribe_cms`.

| Milestone                     | State                              | Notes                                                                                       |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| M0 Foundation                 | done                               |                                                                                             |
| M1 Auth + RBAC                | done                               | security fixes from the audit applied                                                       |
| M2 Admin console              | done (merged from `admin/m2`)      | custom role takes effect without restart; audit M2 + M4 fixed; D-060..D-064                 |
| M3 Website + CMS              | done (merged from `storefront/m3`) | Lighthouse ≥ 90 not measured yet (needs Lighthouse install)                                 |
| M4 Portal cases + uploads     | done (merged from `portal/m4`)     | DoD test green (300-page PDF, interrupted + resumed); D-070..D-077                          |
| M5 Pipeline                   | **M5b in progress (master)**       | M5a adapters done. M5b stages 2–6 built as modules (D-078, D-079); next: DB/queue runner    |
| M6 Workspace + QA + delivery  | not started                        |                                                                                             |
| M7 CRM                        | done                               |                                                                                             |
| M8 Billing                    | done (merged from `ledger/m8`)     | portal pay-by-card screen built in M4; Stripe test key needed for the manual test-card demo |
| M9 Notifications + dashboards | in progress (`herald/m9`)          |                                                                                             |
| M10 Hardening                 | in progress (`sentinel/m10`)       |                                                                                             |

Tests on `main` (2026-10-24, after the M2 + M4 merges and M5b steps 1–2): lint, typecheck,
unit/API tests and build green (33/33 turbo tasks; worker 34 tests); Playwright e2e 18/18.

M4 merge notes: main's `.env` needs `S3_SSE=none` (local SeaweedFS has no SSE, D-070) or the API's
uploads fail; the API creates the buckets at startup and encrypts legacy case notes / messages
(L5 backfill). Real ClamAV: `docker compose --profile scan up -d` + `CLAMAV_HOST=localhost`.

M5b plan (in order): 1 stages 3–6 pure modules (classify, events, coding, index/chronology) ✅ ·
2 stage 2 text extraction with pdf.js + OCR hook ✅ · 3 stage runner: BullMQ processors per stage,
`ProcessingJob` rows, encrypted `DocumentPage` / `ClinicalEvent` / `Deliverable` writes, retries →
case `on_hold` · 4 scan stage moves from the API to the worker (D-072), submit enqueues the pipeline ·
5 stage 7 `in_review` + notify summarizer · 6 pipeline test (Synthea-style PDF → deliverables, every
chronology entry cited) = M5 DoD · 7 tesseract OCR provider + page renderer (or Waiting on Shiva if it
needs a system install).

## Autopilot

Rules: `docs/AUTOPILOT.md`. OpenClaw automation "Datascribe autopilot" (id
`4c01861d-9cfe-4682-a644-4e1e1754408d`) resumes work on a paced loop (1–6 h). "stop autopilot" removes it.
Master on main: M5b → M6. In parallel (Shiva, 2026-10-24): M9 on `herald/m9`, M10 on `sentinel/m10`;
the autopilot merges finished parts and re-spawns the next part.

## Agent team

Master **datascribe-dev** (`agent:datascribe:main`) merges into `main`; subagents work in git worktrees
under `.worktrees/` (own `.env`, ports, `datascribe_<name>_*` DBs on 5433) and report to the master.
Named agents: datascribe-storefront (web/CMS), datascribe-ledger (billing), datascribe-pipeline
(processing pipeline), datascribe-auditor (read-only security/PHI review) — all merged, worktrees
removed 2026-10-24. Active: **datascribe-herald** (M9, `.worktrees/herald`, ports 3700/4700, DB
`datascribe_herald_dev`, Redis /2) and **datascribe-sentinel** (M10, `.worktrees/sentinel`, ports
3800/4800, DB `datascribe_sentinel_dev`, Redis /3). DECISIONS numbering per agent: storefront D-030+,
ledger D-040+, pipeline D-050+, herald D-090+, sentinel D-100+.

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
