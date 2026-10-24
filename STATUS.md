# Datascribe — STATUS

## Current state (2026-10-24)

Remote: https://github.com/shivareddybommaka/datascribe (private, deploy key, host alias
`github-datascribe`). Infra on Colima, all bound to 127.0.0.1: Postgres 16 (:5433; :5432 is Shiva's
existing CRM, never touch), Redis 7, SeaweedFS S3 (:9000), Mailpit (:8025). CMS DB `datascribe_cms`.

| Milestone                     | State                              | Notes                                                                                                                                                                    |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0 Foundation                 | done                               |                                                                                                                                                                          |
| M1 Auth + RBAC                | done                               | security fixes from the audit applied                                                                                                                                    |
| M2 Admin console              | done (merged from `admin/m2`)      | custom role takes effect without restart; audit M2 + M4 fixed; D-060..D-064                                                                                              |
| M3 Website + CMS              | done (merged from `storefront/m3`) | Lighthouse (mobile) performance 99–100, SEO 100 on all 7 public pages (D-127, `docs/LIGHTHOUSE.md`)                                                                      |
| M4 Portal cases + uploads     | done (merged from `portal/m4`)     | DoD test green (300-page PDF, interrupted + resumed); D-070..D-077                                                                                                       |
| M5 Pipeline                   | done (master)                      | DoD e2e green (upload → 7 stages → in_review, all cited); notify; Tesseract OCR (D-082)                                                                                  |
| M6 Workspace + QA + delivery  | **next (master)**                  |                                                                                                                                                                          |
| M7 CRM                        | done                               |                                                                                                                                                                          |
| M8 Billing                    | done (merged from `ledger/m8`)     | portal pay-by-card screen built in M4; Stripe test key needed for the manual test-card demo                                                                              |
| M9 Notifications + dashboards | done except 4 events blocked on M6 | 7/11 §5.8 events + 4 dashboards; part 3 merged (editable notification emails, demo, D-096/D-097); assigned / QA / approved / delivered need M6 to call the ready helpers |
| M10 Hardening                 | in progress (`sentinel/m10`)       | parts 1–5 merged (D-100..D-127: Dockerfiles, KMS-only prod, axe WCAG, Sentry, Lighthouse); part 6 retention / hard-delete job done on the branch, to merge (D-128)       |

Tests on `main` (2026-10-25 01:05, after merging M10 part 5): format, lint, typecheck, unit/API tests
and build green, 36/36 turbo tasks; Playwright e2e 31/31 (run on `E2E_WEB_PORT=3150` /
`E2E_API_PORT=4150`: port 3100 was taken by another project's server). Staging (still running
`155a8e5` code) not restarted: Shiva was testing sign-in; restart with `pnpm staging:stop` /
`staging:build` / `staging:start` when convenient.

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
provider + page renderer ✅ (D-082: tesseract.js WASM, no system install; `OCR_PROVIDER=tesseract`).

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

## Approved by Shiva (2026-10-24, "approve all"), to build

1. Production refuses to start unless `S3_SSE=aws:kms` (sentinel). ✅ merged (D-117)
2. Add `@axe-core/playwright` (dev) and a WCAG check in the e2e suite (sentinel). ✅ merged (D-118):
   no violations found on the checked pages.
3. Add the Sentry SDKs (API, worker, web): off unless `SENTRY_DSN` is set; scrub PHI fields, request
   bodies, cookies and auth headers in `beforeSend` (sentinel). ✅ merged
   (D-119): scrubber in `@datascribe/shared/sentry`, unit-tested with synthetic PHI.
4. Retention / hard-delete job per §4.4, audited, synthetic data only locally (sentinel part 6).
   ✅ done on `sentinel/m10` (D-128), to merge: daily worker job `retention-delete`, S3 object +
   page text purged, `Document.purgedAt` tombstone, one `document.retention_delete` audit row per
   file, dry run + batch limit. Needs M6 to set `closedAt`; Shiva to decide the default for orgs
   with no saved `retentionDays` (see Waiting on Shiva).
5. QA reviewers may use the medical lookups (D-056): grant the lookup permission to `qa_reviewer`.
6. Add Lighthouse (dev) and measure the M3 pages (target ≥ 90 performance + SEO); fix if below.
   ✅ merged (D-127): 7 public pages at performance 99–100, SEO 100
   (`docs/LIGHTHOUSE.md`); `/contact` layout shift fixed (80 → 99).

Terraform 1.17.0 (`/opt/homebrew/bin/terraform`, works as nova) installed by Shiva: run
`terraform init -backend=false` + `terraform validate` on `infra/terraform`; never plan against AWS,
never apply. Native `tesseract` 5.5.3 is also installed (optional; OCR uses tesseract.js, D-082).

## Local staging (Shiva, 2026-10-24)

**Live since 2026-10-24 18:50** at https://datascribe.stayspot.app (merged `launchpad/staging`,
`.env.staging` generated, `datascribe_staging` seeded, ClamAV `clamav-debian` running, tunnel
`datascribe-staging` → `http://localhost:3020`, route + DNS added in Cloudflare). Runs as background
processes started by the master (`pnpm staging:start`, tunnel via `--config infra/staging/cloudflared.yml
run --token-file .env.tunnel-token`); they stop if the Mac or the OpenClaw gateway restarts.

Staging from the Mac Studio at `https://datascribe.stayspot.app` (stayspot.app is on Shiva's
Cloudflare) via a NEW token-based tunnel Shiva creates, pointing to `http://localhost:3020`. Never
touch StaySpot's tunnel or `~/.cloudflared`. Synthetic data only until AWS production.
**datascribe-launchpad** (`.worktrees/launchpad`, branch `launchpad/staging`, ports 3900/4900, DB
`datascribe_launchpad_dev`, Redis /4, D-120+) builds the staging profile, banner, noindex, scripts
and `docs/STAGING.md`. Autopilot merges it when green like herald/sentinel. Going live needs Shiva's
tunnel token (masked secret entry, never chat). Shiva chose **no Cloudflare Access gate** (option B):
staging must disable self sign-up, use real ClamAV, use its own seed password, and keep the production
rate limits, lockout and MFA. Run mode: on demand.

## Waiting on Shiva

- Telegram control: create a Telegram group with the bot (bot as admin or privacy off), send a
  message, send the group id (forward to @RawDataBot). Then the binding is proposed via OpenClaw.
- Free openFDA API key before production (D-052).
- Stripe test key for the manual M8 test-card demo. CMS email adapter choice (editor password reset).
- CI result on GitHub Actions after the format fix (agent can't read Actions with the deploy key).
- IaC (`infra/terraform`, `docs/INFRA.md`, D-115) is written, never applied. Going further needs AWS
  accounts (staging, production) with a BAA, a state bucket, domain + ACM certificate, SES and secret
  values; a CI staging deploy also needs a GitHub OIDC role per account (Dockerfiles done, D-116).
- M10 (sentinel) part 4b Sentry (D-119): a Sentry account/DSN when wanted; Sentry's BAA before
  real PHI; should staging (which refuses real third parties, D-120) be allowed to send scrubbed
  events, or should `SENTRY_DSN` be refused there too? Source-map upload (`withSentryConfig`,
  needs an auth token at build) now or later?
- M10 (sentinel) part 3b: OK to build images in CI for X86_64 (the Terraform default) or switch
  Fargate to ARM64 to match the build Mac? Shrink images (drop the auto-installed Prisma CLI peer,
  ~150 MB) now or later?
- M10 (sentinel) part 6 retention (D-128): orgs with no saved `retentionDays` are never purged
  (the console shows 180 for them). Backfill 180 into every client org, let the job treat unset as
  180, or keep it opt-in? Should clinical events (encrypted descriptions extracted from the source,
  kept now because deliverables cite them) also be purged? Enable on staging with
  `RETENTION_DRY_RUN=true` first?
- M9 finance dashboard (D-094): should MRR count trialing / past-due subscriptions (matches the
  existing finance overview now)? OK to show client firm names in "revenue by client"?
- Next's e2e run rewrites `apps/web/next-env.d.ts` / `tsconfig.json` with the port: master fixes this
  on main (no Shiva decision needed).

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
- App gaps found by the IaC work (D-115): mailer has no SMTP login (SES), invoice PDFs are written to
  local disk (lost on Fargate), API still requires `CLAMAV_HOST` in production though the worker scans,
  API and Terraform describe bucket encryption differently (production now needs `aws:kms`, D-117).
- WCAG: axe covers the public pages, sign-in and one portal + one console page (D-118); extend it to
  the other app pages and do a manual AA review (keyboard, focus order, screen reader).
