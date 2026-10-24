# Datascribe — STATUS

## Current state (2026-10-24)

Remote: https://github.com/shivareddybommaka/datascribe (private, deploy key, host alias
`github-datascribe`). Infra on Colima, all bound to 127.0.0.1: Postgres 16 (:5433; :5432 is Shiva's
existing CRM, never touch), Redis 7, SeaweedFS S3 (:9000), Mailpit (:8025). CMS DB `datascribe_cms`.

| Milestone                     | State                              | Notes                                                                                          |
| ----------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| M0 Foundation                 | done                               |                                                                                                |
| M1 Auth + RBAC                | done                               | security fixes from the audit applied                                                          |
| M2 Admin console              | done (merged from `admin/m2`)      | custom role takes effect without restart; audit M2 + M4 fixed; D-060..D-064                    |
| M3 Website + CMS              | done (merged from `storefront/m3`) | Lighthouse ≥ 90 not measured yet (needs Lighthouse install)                                    |
| M4 Portal cases + uploads     | done (merged from `portal/m4`)     | DoD test green (300-page PDF, interrupted + resumed); D-070..D-077                             |
| M5 Pipeline                   | **M5b in progress (master)**       | DoD e2e green (upload → 7 stages → in_review, all cited); notify done. Left: OCR (step 7)      |
| M6 Workspace + QA + delivery  | not started                        |                                                                                                |
| M7 CRM                        | done                               |                                                                                                |
| M8 Billing                    | done (merged from `ledger/m8`)     | portal pay-by-card screen built in M4; Stripe test key needed for the manual test-card demo    |
| M9 Notifications + dashboards | in progress (`herald/m9`)          | part 1 + sales dashboard merged (`630c868`, D-090..D-092); ops dashboard running               |
| M10 Hardening                 | in progress (`sentinel/m10`)       | parts 1, 2a, 2b merged (D-100..D-114, `docs/SECURITY-CHECKLIST.md`); part 3a IaC files running |

Tests on `main` (2026-10-24 15:30, after the M9 part 1 + M10 part 2b merges and M5b step 5): lint,
typecheck, unit/API tests and build green (API 297, worker 53, scan 6); Playwright e2e 21/21
(new: notification bell, sales dashboard; the pipeline spec checks the review notification).

M4 merge notes: main's `.env` needs `S3_SSE=none` (local SeaweedFS has no SSE, D-070) or the API's
uploads fail; the API creates the buckets at startup and encrypts legacy case notes / messages
(L5 backfill). Real ClamAV: `docker compose --profile scan up -d` + `CLAMAV_HOST=localhost`.

M5b plan (in order): 1 stages 3–6 pure modules (classify, events, coding, index/chronology) ✅ ·
2 stage 2 text extraction with pdf.js + OCR hook ✅ · 3 stage runner: BullMQ processors per stage,
`ProcessingJob` rows, encrypted `DocumentPage` / `ClinicalEvent` / `Deliverable` writes, retries →
case `on_hold` ✅ (D-080) · 4 scan stage in the worker (`packages/scan`), DB-to-queue dispatcher for
completed uploads and submitted cases ✅ (D-081) · 5 stage 7 `in_review` ✅ + notify summarizer /
case manager on hold ✅ · 6 M5 DoD e2e (synthetic
six-record PDF → deliverables, every chronology entry cited, status timeline) ✅ · 7 tesseract OCR
provider + page renderer (or Waiting on Shiva if it needs a system install).

Running the app locally now needs the worker too (`pnpm --filter @datascribe/worker dev`): without
it uploads stay "Scanning" and submitted cases aren't processed. SeaweedFS volume limit raised to
200 (it ran out with parallel worktrees' test buckets; container recreated 2026-10-24 13:12).

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
- CI result on GitHub Actions (agent can't read Actions with the deploy key), now including the new
  e2e job.
- M10 (sentinel): should production refuse to start unless `S3_SSE=aws:kms`? May we add
  `@axe-core/playwright` (WCAG check) and the Sentry SDKs? Build the retention / hard-delete job next?
- Terraform CLI (Homebrew, admin) to `terraform validate` the M10 IaC files; nothing will be applied.
- Next's e2e run rewrites `apps/web/next-env.d.ts` / `tsconfig.json` with the port (herald): ignore
  them or fix on main? (Agents reset them before each commit for now.)

## Security review (datascribe-auditor)

No critical findings; §4.4 PHI rules verified. **All findings fixed**: H1, M1, M3, M7, M8, M9; M2 + M4
(with M2, D-064); L4 + L5 (with M4); M5, M6, L1, L2, L3, L6, L7, L8, L9, L10, L12 (M10 part 1,
`sentinel/m10` merged 2026-10-24, D-100..D-109). L11 (non-owner DB roles): SQL + runbook in
`docs/DB-ROLES.md` (D-110), not applied to any database; switching staging/production is part of the
IaC work and Shiva's call. New env with safe defaults: `RATE_LIMIT_ACCOUNT`, `TRUST_PROXY`,
`AUTH_RESPONSE_FLOOR_MS`, `STAFF_EMAIL_DOMAINS`.

## Known follow-ups

- Dependency advisories (pnpm audit --prod, 2026-10-24): 0 critical. Left: deepmerge-ts (high, via
  the Prisma 6 CLI config loader; fixed by the planned Prisma upgrade) and esbuild 0.18 (moderate, dev
  server CORS, via drizzle-kit migrations tooling; not served). CMS on next 16.4.3, sharp 0.35.5;
  overrides for dompurify/postcss/sharp in root package.json (D-020).

- Upgrade pass (D-001): Prisma, Vitest, ESLint, TypeScript, otplib.
- Rate limits and usage stats are in Redis now (D-111, D-112); the CI e2e job (D-113) hasn't run on
  GitHub yet (agent can't read Actions). Without Redis the limited auth routes answer 500 (fail closed).
- M6: `GET /cases/:id/deliverables` lists draft deliverables to anyone who may view the case; hide
  drafts from client users when the deliverable viewer is built.
- `apps/cms/scripts/tmp-edit-home.ts` (untracked, storefront's one-off check script) can be removed.
- Ask Datascribe for an SVG logo.
