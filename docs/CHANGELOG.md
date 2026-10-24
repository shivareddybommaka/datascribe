# Changelog

## M10 part 8 — Close-out: CI staging deploy workflow, e2e noise explained, demo (2026-10-25, branch `sentinel/m10`)

Design notes: D-130, D-131. **Nothing was deployed, planned or applied; no AWS account was used.**

- **Staging deploy workflow** `.github/workflows/deploy-staging.yml` (§12 M10 DoD, D-131): manual
  `workflow_dispatch` on `main` only, never on push / PR / schedule. Assumes an AWS role through
  GitHub OIDC from the `staging` environment (no secrets), builds and pushes the four images
  (`linux/amd64`, tag = commit SHA, deployed by digest) and runs `terraform plan`; with `apply` on it
  also runs the migration task, applies and waits for the services. Written, never run: the role and
  variables don't exist yet (`docs/INFRA.md` → "CI staging deploy" lists what to create).
- `apps/api/test/infra-deploy-workflow.test.ts` (5 tests): triggers, apply gating, OIDC-only
  credentials, SHA-pinned actions, images by digest.
- **Terraform validated**: `terraform init -backend=false`, `validate` and `fmt -check` pass
  (Terraform 1.17.0, AWS provider 5.100.0); `.terraform.lock.hcl` committed.
- **e2e `prisma:error document.findMany`** (D-130): the worker's dispatcher polling while global
  setup drops and re-creates the e2e schema. Harmless, nothing silenced.
- **Demo** `docs/demos/M10.md` for parts 1–8.

## M6 part 2a — Staff workspace read side (2026-10-25, master)

Design notes: D-084.

- **`GET /cases/:id/workspace`**: case, documents, latest deliverables (decrypted content) and
  clinical events with citations, in one call. Staff only, audited `case.workspace_view`.
- **`GET /documents/:id/pages/:n`**: decrypted text, OCR confidence and record type of one page.
  Staff only, audited `document.page_view`, 410 after retention.
- **Console `/console/cases/[id]`**: source records (document picker, page list, page text) beside
  Chronology / Index / Summary tabs; clicking an entry or index row jumps to its source page. Queue
  case numbers link here. Page images come in part 2b.
- Tests: `apps/api/test/workspace.test.ts` (6); the M5 DoD e2e now opens the workspace as ops and
  follows a chronology citation to its page.

## M6 part 1 — Staff case queue and assignment API (2026-10-25, master)

Design notes: D-083.

- **Queue filters** on `GET /cases` for staff: client firm, assignee (`me`), unassigned slot, SLA
  flag, due-before date, sort by priority. Staff rows include the firm and assignees.
- **SLA flags** (`sla`: `red` overdue, `amber` due in < 24 h) on case rows and detail.
- **`POST /cases/:id/assign`**: case managers set the summarizer and QA reviewer on their cases (or
  claim an unmanaged one); ops managers reassign anything. Eligibility by permission, four-eyes
  rule, compare-and-set, `case.assign` audit rows, `assigned_to_you` notifications (M9 event now
  live). `GET /cases/assignable-staff?role=` for the picker.
- **Console `/console/cases`** (new Cases section): queue table with search, status, assignee
  (me / no case manager / no summarizer / no QA), SLA, priority filters and sort; Overdue / Due soon
  badges; Assign dialog with the three pickers and each person's open-case count.
- Tests: `apps/api/test/case-queue.test.ts` (11), e2e `apps/web/e2e/cases.spec.ts`.

## M10 part 7 — QA reviewers may use the medical lookups (2026-10-25, branch `sentinel/m10`)

Approved by Shiva on 2026-10-24 (item 5). Design notes: D-129.

- **New permission** `medical_lookups:view` (internal-only module), granted by default to
  super_admin, ops_manager, case_manager, summarizer and now **qa_reviewer**. It shows in the admin
  role editor as "Medical code lookups (view)".
- `/medical/*` accepts `medical_lookups:view` or, as before, `cases:edit` (custom roles keep their
  access). Sales, finance and client users still get 403.
- **Migration** `medical_lookups_permission`: adds the catalogue rows and grants the defaults to the
  built-in roles of existing databases; idempotent, custom roles untouched.
- Tests: medical API tests for QA access, attribution / de-identification for QA, and custom roles
  (new permission, legacy `cases:edit`, neither → 403); matrix rows in `permissions.test.ts`.

## M10 part 6 — Retention / hard-delete job (2026-10-25, branch `sentinel/m10`)

Approved by Shiva on 2026-10-24 (item 4). Design notes: D-128.

- **Worker job** `retention-delete` (queue `retention`, daily 03:00 UTC) calling `runRetention` from
  `@datascribe/db/retention`: for orgs with a valid `retentionDays`, deletes the S3 object and the
  encrypted page text of documents on cases closed longer ago than that. Cases, clinical events and
  deliverables are kept. Orgs with no or an invalid setting are skipped.
- **Audited**: one `document.retention_delete` row per file (system actor, ids only, no file names).
  Idempotent, batch-limited (`RETENTION_BATCH_SIZE`, default 500), one failed file doesn't stop the
  run and is retried next time; `RETENTION_DRY_RUN=true` counts only.
- **Tombstone**: migration `document_retention` adds `Document.purgedAt`. The API reports
  `state: 'purged'`, download answers 410; the portal shows "Deleted by retention".
- Tests: 8 API/DB tests (`apps/api/test/retention.test.ts`, one against the local S3), 4 worker tests.

## M10 part 5 — Lighthouse on the public pages (2026-10-24, branch `sentinel/m10`)

Approved by Shiva on 2026-10-24 (item 6). Design notes: D-127.

- **Lighthouse** 13.5 (dev, `apps/web`) and `pnpm --filter @datascribe/web lighthouse`: production
  build on :3800, mobile preset, performance + SEO, median of 3 runs per page, results in
  `docs/LIGHTHOUSE.md`; exits 1 below 90. Uses the installed Google Chrome.
- **Scores** (7 public pages): performance 99–100, SEO 100.
- **Fix: `/contact` layout shift** (performance 80 → 99, CLS 0.40 → 0). The contact form is now in
  the static HTML instead of rendering only on the client; `?kind=demo` is applied after hydration
  and Send stays disabled until then.

## M10 part 4b — Sentry with PHI scrubbing (2026-10-24, branch `sentinel/m10`)

Approved by Shiva on 2026-10-24 (item 3). Design notes: D-119.

- **Sentry SDKs**: `@sentry/node` in the API and worker, `@sentry/nextjs` in the web app
  (`instrumentation.ts`, `instrumentation-client.ts`, no `next.config` wrapping). Off unless
  `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` is set; no default PII, no local variables, tracing sample
  rate configurable (default 0). New env: `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_ENVIRONMENT`,
  `SENTRY_RELEASE` and their `NEXT_PUBLIC_` twins; the API and worker refuse malformed values.
- **Scrubber** `@datascribe/shared/sentry` on `beforeSend`, `beforeSendTransaction` and
  `beforeBreadcrumb`: drops request bodies, cookies, auth and other headers, query strings, client
  IP, user details, local variables and PHI-named fields; redacts emails, dates, long numbers,
  tokens and quoted values in messages; drops console breadcrumbs and SQL/Redis span text. 37 unit
  tests with synthetic PHI.
- Reported: API unhandled 500s, worker jobs failing their last attempt (queue tag only), Next
  request errors, browser errors, uncaught exceptions.

## M10 part 4a — KMS-only production storage, WCAG check (2026-10-24, branch `sentinel/m10`)

Both approved by Shiva on 2026-10-24. Design notes: D-117, D-118.

- **Production refuses to start unless `S3_SSE=aws:kms`** (D-117): the rule sits in the shared
  deploy profile (`productionViolations`), so the API's env schema and the worker's new
  `assertWorkerEnv` (`apps/worker/src/env.ts`) both apply it. Unset (= AES256), `AES256` and `none`
  are refused; `S3_SSE_KMS_KEY_ID` stays optional. Staging (SeaweedFS, `S3_SSE=none`) and local
  development are unchanged. Unit tests in `packages/shared`, `apps/api`, `apps/worker`.
- **WCAG 2.1 AA check in e2e** (D-118): `@axe-core/playwright` (dev) and `apps/web/e2e/a11y.spec.ts`
  run axe (wcag2a/aa, wcag21a/aa) on the 7 public pages, the home page at 375 px, staff and client
  sign-in, the portal dashboard and the ops console dashboard. Serious/critical violations fail the
  test. Found none; the hero band's contrast (axe can't measure text on a gradient) was checked by
  hand: ≥ 5:1. A self-test proves the check fails on a missing `alt`.

## Local staging behind a Cloudflare tunnel (2026-10-24, branch `launchpad/staging`)

Staging copy on the Mac Studio at `https://datascribe.stayspot.app` (Shiva's own tunnel to
`http://localhost:3020`), synthetic data only. Design notes: D-120 and up.

- **Deploy profile** `DEPLOY_ENV = local | staging | production` (D-120): production refusals
  unchanged; staging (a `NODE_ENV=production` build) may use local SeaweedFS without SSE, the fake
  gateway and the mock scanner, and refuses a real LLM, Textract, live Stripe keys, non-Mailpit SMTP,
  Postgres 5432, databases not named `staging` and an http `APP_URL`. The worker checks the same.
  `API_HOST` lets staging bind the API to 127.0.0.1.
- **Behind the tunnel** (D-121): tests for Secure cookies, the https CSRF origin, CORS, security
  headers and per-IP limits keyed on the last `X-Forwarded-For` entry; optional
  `TRUST_CF_CONNECTING_IP` (only from a hop `TRUST_PROXY` trusts; refused in production).
- **Storage relay** (D-122): `S3_BROWSER_ACCESS=relay` makes upload-part and download URLs
  same-origin (`/api/v1/storage-relay/<sealed token>`), so uploads work through the tunnel while S3
  stays on localhost. Refused in production.
- **Web guard rails** (D-123): fixed staging banner on every page, `X-Robots-Tag: noindex`,
  noindex metadata and a disallow-all `robots.txt`, no GA/GTM in staging; `ENV_FILE` for
  `next.config.ts`.
- **Runner, runbook, smoke** (D-124): `.env.staging.example` (web 3020 / API 4020,
  `datascribe_staging` + `_cms`, Redis /5, Mailpit), `pnpm staging:check | db:reset | db:migrate |
build | start | stop | smoke`, `docs/STAGING.md` (DB, tunnel and Access setup, running
  cloudflared with a token from an env var, stopping), launchd and cloudflared templates in
  `infra/staging/` (not installed). The smoke test passes against the production-built stack.
- **Open internet, no Access gate** (D-125): staging closes firm sign-up unless
  `STAGING_ALLOW_SIGNUP=true`, requires ClamAV unless `STAGING_ALLOW_MOCK_SCAN=true`, refuses a seed
  password under 20 characters or equal to dev's, and refuses auth limits looser than production's.
- **Tunnel** (D-126): optional `pnpm staging:tunnel` runs `cloudflared tunnel --config
infra/staging/cloudflared.yml run --token-file .env.tunnel-token` (token file git-ignored, never
  read or logged, no `TUNNEL_*` env passed on); `staging:stop` stops it too.

## M9 part 1 — Notifications (2026-10-24, branch `herald/m9`)

§5.8 notifications. Design notes: D-090. Migration `20261024160000_m9_notifications`
(notifications with email delivery columns, preferences).

- **Catalog and dispatcher** (`packages/shared`, `packages/db`): one typed event list with audience,
  default channels and templates; `emit` fans out to in-app rows and queues email per recipient,
  honouring the admin notification rules and each user's preferences.
- **Email outbox** on a BullMQ `notifications` queue in the worker, sent to Mailpit in dev, retried
  with backoff.
- **Events wired**: case submitted, upload scanned, invoice issued, payment recorded, lead assigned,
  invite accepted, password changed, tasks due (upload scanned is sent from `packages/scan` in the
  worker). Typed helpers ready for the stage runner and QA flow:
  case ready for review, processing failed, assigned, QA decision, delivered.
- **API**: list (cursor paged), unread count, mark read / mark all read, get and update preferences.
- **UI**: header bell in console and portal with an unread badge (polled every 30 s), the latest
  notifications and "mark all read"; a notification centre page at `/console/notifications` and
  `/portal/notifications` with preferences. Read-only while impersonating.
- **Tests**: API and unit tests for the catalog, dispatcher and routes; Playwright e2e for the bell.

## M9 part 2 — Dashboards (in progress, branch `herald/m9`)

§5.9. Design notes: D-092.

- **Sales dashboard** (`GET /dashboards/sales`, `/console/dashboards/sales`): pipeline value by
  stage (per currency), conversion and win rate for a 30 / 90 / 365-day window, leads by source.
  Sales and ops managers only.
- **Ops dashboard** (`GET /dashboards/ops`, `/console/dashboards/ops`): cases by status, open and
  overdue counts, average turnaround (submitted → in review, submitted → delivered) for a 7 / 30 /
  90-day window, workload per summarizer. Ops managers see all cases, case managers their team,
  summarizers and QA reviewers their own (D-093).
- **Finance dashboard** (`GET /dashboards/finance`, `/console/dashboards/finance`): MRR and
  subscriptions by status, invoices outstanding and overdue, revenue net of refunds for a 30 / 90 /
  365-day window with the top ten clients per currency (D-094). Finance and ops managers.
- **Client dashboard** (`GET /dashboards/client`, portal `/portal/reports`): cases by status, pages
  processed and spend per currency (paid invoices net of refunds) for a 30 / 90 / 365-day window,
  always for the caller's own firm. Client admins see the whole firm and its spend; client users
  only their own and shared cases, no spend (D-095). API tests include cross-firm isolation.

## M9 part 3 — DoD check, editable notification emails, M6 hand-over (2026-10-24, branch `herald/m9`)

Design notes: D-096, D-097. Demo: `docs/demos/M9.md`. No schema change.

- **DoD check**: 7 of the 11 §5.8 events send email + in-app today; the other 4 (assigned to you,
  QA changes requested, approved, delivered) need M6's assignment, QA and delivery code. Their emit
  helpers are ready and tested; the call sites are in their doc comments (`packages/db/src/notifications.ts`).
- **Editable notification emails** (§5.7 "email templates editable with variables", D-097): every
  notification type the outbox mails (all but the directly sent password-changed notice) has a
  template in Settings → Email templates ("Notification emails" group), with its own variables
  (`{{caseNumber}}`, `{{invoiceNumber}}`, `{{link}}` …), `{{link}}` required, preview with synthetic
  values. The worker's outbox uses the admin's version; the defaults read exactly like the bell. The
  "choose which emails you get" line under non-critical emails is always added and can't be removed.
  Templates, validation and rendering moved to `@datascribe/shared/email-templates` so API and
  worker share them.
- **Reports for client users** (D-096): stays visible with `cases:view`: counts and pages of their
  own and shared cases, spend `null`. Now covered by e2e.
- **Tests**: shared unit tests for the templates (defaults match the bell for every type, overrides,
  footer, injection), API tests for `notifyAssigned` / `notifyQaDecision` / `notifyDelivered` and for
  an edited notification email going through the outbox; e2e for the template editor and the client
  user's Reports page.

## M5b — Processing pipeline (2026-10-24, `main`) → M5 done

- Stages 3–6 as pure modules (D-078) and stage 2 text extraction with pdf.js (D-079).
- **Stage runner** (D-080): BullMQ processors for extract → classify → extract-events → code →
  build-deliverables → ready-for-review, one job per case per stage; `ProcessingJob` rows per
  attempt; encrypted `DocumentPage` / `ClinicalEvent` / `Deliverable` writes; last failed attempt puts
  the case `on_hold`; re-runs replace rather than duplicate. The worker reads documents from S3
  (`@aws-sdk/client-s3`, same settings as the API).
- **Stage 1 scan in the worker** (D-081): scanner + `verifyDocument` moved to `packages/scan`; the
  worker scans uploads as they complete and, at submit, scans anything left and claims the case
  `submitted → processing`. A DB-to-queue dispatcher replaces the API's background scan and its
  startup resume. E2E now starts the worker. New env: `QUEUE_PREFIX`, `DISPATCH_INTERVAL_MS`,
  `PIPELINE_START_CASES`; the worker honours the DB index in `REDIS_URL`.
- **M5 DoD e2e** (`e2e/pipeline.spec.ts`): a synthetic six-record PDF goes upload → scan → all
  stages → `in_review`; index, chronology and summary are stored encrypted, chronology dated and in
  order, every entry citing a page of the upload. Pipeline status changes now appear on the case
  timeline (`case.status` audit rows).
- **Pipeline notifications** (step 5, uses M9): stage 7 notifies the summarizer (else the case
  managers) when it moves the case to `in_review`; a stage's last failed attempt that puts the case
  `on_hold` notifies the case manager and ops managers. Only the run that changes the status sends,
  and a failed notification is logged (ids and error name only) without failing the stage.
- **OCR** (step 7, D-082): `OCR_PROVIDER=tesseract` uses tesseract.js (WASM, English model bundled
  via `@tesseract.js-data/eng`, nothing downloaded at runtime); scanned PDF pages are rendered at
  200 dpi with pdf.js on `@napi-rs/canvas`. `OCR_PROVIDER=mock` (the default) keeps low-text pages
  counted in `needsOcr`. A test OCRs a synthetic scanned PDF page and an image upload for real.

## M10 part 3b — Container images (2026-10-24, branch `sentinel/m10`)

Design notes: D-116. **Built locally only: nothing pushed or deployed.**

- **Dockerfiles** for api, web and worker (`apps/*/Dockerfile`) and a root `.dockerignore`:
  multi-stage, Node 22 slim pinned by digest, production files only, non-root `node` user, no
  secrets; api on 4000 with a `HEALTHCHECK` on `/api/v1/health`, web on 3010 (Next standalone),
  worker with no port. A `migrate` target (Prisma CLI + migrations) for the one-off migration task.
- `pnpm build` for api and worker now makes a bundle that runs on plain Node (`tsup.node.ts`:
  workspace packages inlined, npm packages and the Prisma client external); before, `dist/` still
  imported TypeScript source. Web builds with `output: 'standalone'`.
- Terraform: migration task on its own `image_migrate` (ECR repo `migrate`) with
  `prisma migrate deploy`; the API task definition repeats the image's health check.
- `apps/api/test/infra-docker.test.ts`: non-root user, no secret-like `ENV`/`ARG`, no port 3000 /
  5432, `.dockerignore` entries, ports / commands / health path / migrate command match Terraform.

## M10 part 3a — Infrastructure as code (2026-10-24, branch `sentinel/m10`)

Design notes: D-115. **Written only: nothing planned, applied or deployed; no AWS account used.**

- **Terraform for AWS** (`infra/terraform/`, `docs/INFRA.md`): VPC with private app and isolated data
  subnets, RDS Postgres 16 (KMS, TLS forced, daily snapshots kept 30 days), ElastiCache Redis (TLS,
  KMS, `noeviction`), document and deliverable buckets (SSE-KMS, versioning, public access blocked,
  TLS only), ECS Fargate api / web / worker with a ClamAV sidecar and a migration task, ALB with TLS
  1.2+ and HTTP redirect, Secrets Manager entries (no values in Terraform), CloudWatch logs (KMS),
  ECR. Staging and production tfvars examples without real values.
- `apps/api/test/infra-terraform.test.ts` checks the files as text (Terraform isn't installed):
  encryption, versioning, TLS, backups, private tasks, no secrets, no port 3000, tfvars complete,
  every container env var one the apps read.
- The worker's BullMQ connection keeps TLS and credentials from a `rediss://` `REDIS_URL` (it
  dropped them before, so it couldn't reach ElastiCache with TLS).

## M10 part 2b — Load test and security checklist (2026-10-24, branch `sentinel/m10`)

Design notes: D-114.

- **Load test** (`pnpm load`, D-114, `docs/LOAD-TEST.md`): autocannon against a running local API
  (health, `/auth/me`, case list, case detail, document list at 1/10/50 connections), plus
  sequential probes showing login, refresh and forgot answer 429 at their limits. Prints
  p50/p95/p99, throughput and error counts only. Local laptop result: every route's p95 under
  75 ms at 50 connections, no errors. Manual only, not in tests or CI.
- **§10 security checklist** (`docs/SECURITY-CHECKLIST.md`): every §10 item mapped to the code,
  test or D-entry that enforces it, or marked open (TLS, KMS by default, RDS encryption, backups,
  S3 versioning, retention job, 300-page timing, WCAG audit, Sentry, formal ASVS pass), plus the
  audit findings: all fixed, L11 roles written but not applied. A test keeps the checklist's
  sections and file references in step with REQUIREMENTS.md and the tree.

## M10 part 2a — Shared state in Redis, e2e in CI (2026-10-24, branch `sentinel/m10`)

Design notes: D-111 to D-113.

- **Rate limits in Redis** (D-111): the per-IP and per-account auth/form limiters count in Redis,
  so every API process shares one count and a restart no longer resets it. Same limits, same 429
  body. Fails closed: with Redis down, limited routes answer 500 instead of skipping the limit.
- **Medical usage stats in Redis** (D-112): per-minute counters per upstream, written by the API
  and the worker, so the admin settings page shows every process's last-24 h calls. The page still
  loads if Redis is down.
- **CI e2e job** (D-113): Postgres 16, Redis and Mailpit service containers (pinned by digest),
  SeaweedFS, the runner's installed Chrome, own `datascribe_e2e` DB, failure traces kept 7 days.
  Not run on GitHub yet (the agent can't trigger Actions). The check job also gets Redis.
- The portal e2e spec takes the S3 port from `S3_ENDPOINT` (was hard-coded to 9000).
- New env: `REDIS_KEY_PREFIX` (API and worker; the API now reads `REDIS_URL`); tests:
  `TEST_REDIS_URL`; e2e: `E2E_REDIS_URL`. `ioredis` is now a direct dependency of the API and
  `@datascribe/medical-data` (already in the lockfile via BullMQ).

## M10 part 1 — Open security findings (2026-10-24, branch `sentinel/m10`)

Fixes for the datascribe-auditor's open M and L findings, one commit each with a regression test.
Design notes: D-100 to D-110.

- **M5**: a sign-in lasts at most 7 days however often it refreshes (rotation keeps the family's
  expiry); refresh re-checks the MFA policy and ends sessions of users who must now enrol.
- **M6**: `TRUST_PROXY` (default `loopback`, `true` refused) replaces the hard-coded trust of one
  proxy hop; per-account limit `RATE_LIMIT_ACCOUNT` (10 / 15 min) on login, MFA, forgot, register.
- **L1**: `Session.revokedReason` (migration `20261024150000_session_revoked_reason`). Only a
  rotated token raises a reuse alert; a token ended by logout, idle, reset etc. is a plain 401.
- **L2**: a password reset voids every other reset link. **L8**: MFA step tokens are single-use.
- **L3**: registering an unverified address again replaces the pending sign-up instead of being
  blocked; verify-email is transactional.
- **L6**: fixed "no health information" notice on the website contact form.
- **L7**: `errorInfo()` logs Prisma errors without values; the shared client logs errors by target.
- **L9**: constant-time TOTP compare; `AUTH_RESPONSE_FLOOR_MS` (400 ms) on login/register/forgot.
- **L10**: a converted firm's admin must be on the lead's domain (else an admin converts), never a
  Datascribe staff domain.
- **L11**: SQL and runbook for owner / migrator / app database roles (`docs/DB-ROLES.md`); not
  applied to any running database.
- **L12**: compose and CI images pinned by digest, Actions by commit SHA, with a test.
- New env: `RATE_LIMIT_ACCOUNT`, `TRUST_PROXY`, `AUTH_RESPONSE_FLOOR_MS`, `STAFF_EMAIL_DOMAINS`
  (`.env.example`).

## M2 — Admin console (2026-10-24, branch `admin/m2`)

§5.7 admin console on top of the users API from `719552e`. Design notes: D-060 to D-064.
Definition of done met: a custom role built in the matrix takes effect on its holder's next request,
without a restart (API test and Playwright e2e).

- **Users**: create (= invite, reusing `createInvite`), replace roles, plus the existing suspend /
  reactivate / reset MFA / force password reset. ops_manager can't touch super_admin; client admins stay
  in their firm and client roles.
- **Roles**: list, create custom roles, edit with a module × action × scope checkbox matrix, delete
  unused custom roles. Built-in roles can't be deleted; Super Admin is locked. Client roles never get
  `all` scope or internal modules; `system_settings` stays with Super Admin.
- **Audit finding M4 fixed**: roles, invites and role assignments can only grant permissions the actor
  holds (super_admin exempt).
- **Organizations**: list, view, edit name / status / plan / currency / MFA policy / retention days /
  custom pricing; suspend (signs everyone out) and reactivate. Custom pricing is applied by the monthly
  invoicing run.
- **Settings** (super admin only): company and invoice settings (feed invoice PDFs and tax), SLA
  defaults, notification rules per event, medical data sources on/off with last-24h usage, and editable
  plain-text email templates with validated `{{variables}}` (invite, password reset, MFA reset now use
  them).
- **Audit log viewer**: filter by user, action, entity, date range; paginate; CSV export (audited).
- **Impersonation** (§4.4): super admin views as a client user, read-only (every non-GET refused),
  start/stop audited with `impersonatorId`, amber banner with Stop. Migration
  `20261024120000_admin_impersonation` adds `Session.impersonatorId`.
- **Audit finding M2 fixed**: login and MFA attempts are reserved atomically before the secret is
  checked, so concurrent guesses can't get past the 5-attempt lockout.
- **Console**: Admin section (`/console/admin`: users, roles, organizations, settings, audit log)
  shown to holders of users / system_settings / audit_log view. The console no longer rotates the
  refresh token on every section change when it already has an access token.
- Tests: API +36 (198 total), shared +3, billing +3, Playwright +2 (`e2e/admin.spec.ts`; 15/15).

## M4 — Client portal: cases and uploads (2026-10-24, branch `portal/m4`)

DoD: a client uploads a 300-page synthetic PDF with a resumable upload (API test and Playwright).
Design notes: D-070 to D-077.

- **Portal** `/portal`: sign-in at `/portal/login` (same `/auth` endpoints, MFA when enrolled or
  enforced by the firm, staff sent to `/console`), 30-minute idle sign-out, portal shell.
- **Dashboard**: open cases by status, recent deliverables, usage this period vs plan limit,
  outstanding invoices (billing parts for client_admin only).
- **Cases**: create (matter, reference, patient/plaintiff name, incident date, type, requested
  deliverables, priority, due date, notes), list with filters, search and pages, detail with a status
  timeline, edit while draft, submit, sharing with colleagues in the same firm, message thread with
  Datascribe staff (staff-only internal notes are never shown to clients). Sequential numbers
  `DS-YYYY-NNNNNN`.
- **Uploads**: drag and drop or pick several PDF/PNG/JPEG/TIFF files up to 500 MB, per-file progress
  bar, pause/resume, S3 multipart straight from the browser with presigned part URLs, resume after an
  interruption or reload (only missing parts are sent). After upload: magic-byte type check, exact size
  check, SHA-256, page count, virus scan (ClamAV via clamd, or the mock scanner in dev/CI). Infected
  files are quarantined; downloads are 5-minute signed URLs for clean files only.
- **Storage**: private document/deliverable buckets created at startup, CORS limited to the app
  origin, SSE (AES256 or KMS; required in production), object keys without file names.
- **Audit (§4.4)**: document create, upload complete, scan, view, list, download, rename, delete and
  rejection; case create/view/edit/submit/list/share/unshare; messages.
- **Encryption (audit L5)**: case notes and message bodies are now encrypted; DB CHECK constraints
  refuse plaintext in `Case.patientName`, `Case.notes` and `Message.body`; legacy rows are encrypted at
  API startup.
- **Billing in the portal** (client_admin): subscription with usage meter, change plan, cancel /
  resume at period end, invoices, invoice detail with receipts, PDF and pay by card (existing
  `/invoices/:id/pay`; Fake gateway in dev).
- **Firm** (client_admin): firm profile, require-MFA policy, users (suspend / reactivate), invites
  and pending invites.
- New env: `S3_SSE`, `S3_SSE_KMS_KEY_ID`, `UPLOAD_PART_SIZE_MB`, `CLAMAV_HOST`, `CLAMAV_PORT`,
  `RATE_LIMIT_AUTH`, `RATE_LIMIT_PUBLIC`. Packages: `@aws-sdk/client-s3`,
  `@aws-sdk/s3-request-presigner`, `pdf-lib` in the API.
- Tests: api 211 (was 162; new `uploads.test.ts`, `portal-cases.test.ts`, scanner/file-type unit
  tests, document routes in `rbac.test.ts` isolation lists), Playwright 16 (new `portal.spec.ts` ×3).

## M5a medical data adapters (2026-10-24, branch `pipeline/m5-adapters`)

Adapter layer of M5 (§8). The processing pipeline (M5b) waits for M4 uploads.

- `packages/medical-data`: real adapters for NLM Clinical Tables ICD-10-CM (`DiagnosisCoder`) and HCPCS
  (`ProcedureCoder`), RxNav approximate match (`MedicationNormalizer`), openFDA drug labels
  (`DrugInfoProvider`) and MedlinePlus Connect (`ConsumerHealthInfo`); deterministic mocks for every
  interface including `OcrProvider` and `SummaryProvider`. `createMedicalData()` picks providers from
  `MEDICAL_DATA_PROVIDER=nlm|mock` (default mock). Each provider was checked against its official docs
  (D-050..D-053); openFDA now says a key is required (D-052).
- `deidentifyTerm()`: strips names, dates/DOB, MRNs and case/claim/account numbers, SSNs, phones,
  emails, URLs, addresses and ages, and refuses free text (D-054). Applied in routes and adapters.
- `ProviderClient` resilience wrapper: cache (Prisma `MedicalApiCache` or in-memory, hashed keys, 30-day
  TTL), per-provider token bucket, 10 s timeout, 3 retries with backoff, circuit breaker falling back to
  "uncoded", provider-enable switch, logs with provider/latency/status only (D-055).
- Usage stats: `usageStats()` gives last-24h calls, errors, error rate, cache hits per upstream for the M2
  admin settings page.
- API: `GET /api/v1/medical/icd10 | rxnorm | drug-label | define`, staff only (internal + `cases:edit`),
  Zod validation, de-identification, attribution in every response (D-056).
- Recorded fixtures for every real provider (synthetic terms, replayed by exact URL), optional live smoke
  tests behind `RUN_LIVE_API_TESTS=true`.
- Tests: medical-data 146 (+5 live, skipped), api +12 (medical routes, 403 for sales/finance/QA/client
  users, PrismaCacheStore on the test DB).

## M8 — Billing + subscriptions (2026-10-24, branch `ledger/m8`)

Built in four commits: M8a `8f461ea` (billing package + migration), M8b `29079a3` (API),
M8c `d8f36a3` (worker jobs), M8d (finance console, this commit). Design notes: D-040 to D-044.

- **Plans** (§5.6): name, monthly price, currency, included pages, overage price per page, features.
  Finance / super_admin create and edit them. Plans are deactivated, never deleted.
- **Usage**: pages are recorded per case on first delivery (idempotent per case). Finance can add
  manual entries. Usage this period vs the plan limit is shown on every subscription.
- **Subscriptions**: current plan + usage, change plan (no proration in v1), cancel / resume at
  period end. client_admin acts on their own firm; finance on any firm.
- **Invoices**: the monthly run bills plan fee + overage + tax (label and rate from the company
  setting) on each firm's own anniversary. It catches up missed periods one invoice each and never bills
  a period twice. One-off invoices by finance. Gap-free sequential numbers (`INV-YYYY-NNNNN`), safe
  under concurrency. Void with a reason. Invoice PDF with company details and tax line, cached in the
  object store.
- **Payments** via the `PaymentGateway` interface: Stripe (test keys only), a Fake gateway with a
  simulated checkout page for dev / CI (also used when no Stripe key is set), and a Razorpay stub.
  Checkout → signed, idempotent webhook marks the invoice paid exactly once. Finance refunds part or
  all of a payment; a fully refunded invoice ends `refunded`.
- **Dunning**: reminders on the due date, +7 and +14 days to the firm's client admins (Mailpit only).
  Unpaid invoices are marked overdue.
- **Worker**: BullMQ repeatable jobs `monthly-invoicing` (02:00 UTC) and `dunning` (09:00 UTC).
- **Finance console** `/console/finance` (new section next to CRM, switcher in the header):
  - overview: MRR and outstanding per currency, overdue count, recent invoices, firms near or over
    their page limit, "Run monthly invoicing" / "Run dunning" (with a dev-only "as of" date);
  - invoices: filters (number, status, kind), pagination, outstanding totals, new one-off invoice;
  - invoice detail: lines, tax, totals, payments with receipts, PDF download, void, refund;
  - subscriptions: plan, status, period, usage meter, change plan, cancel / resume, add usage;
  - plans: list incl. inactive, create / edit.
- Access (§4.3): finance full; ops and sales view; client_admin their own firm (view, pay, manage
  subscription); everyone else refused. Other firms' invoices return 404.
- Tests: api 130 (incl. `test/billing.test.ts` "M8 DoD: monthly invoice with overage, paid through
  the gateway" and isolation tests in `rbac.test.ts`), billing 36, shared 83, worker 5, Playwright e2e 6
  (3 new: one-off invoice → PDF → void; usage over the limit → monthly run → plan fee + overage;
  new plan). Lint, typecheck, format and build green.

Not yet: portal billing screens for firms (§5.3: invoices, pay by card, subscription). The API is
ready; checkout returns to `/portal/billing/invoices/:id`. Finance dashboard (revenue by client) is M9.

## M3 — Marketing website + CMS (2026-10-24, branch `storefront/m3`)

- `apps/cms`: Payload 3 (own Next app, own DB on 5433, D-030). Collections `pages`, `posts`, `media`,
  `users`; `site` global; initial migration; idempotent seed (`-- --force` resets to defaults).
- `packages/site-content`: shared content types, synthetic default copy, Lexical helpers.
- `apps/web` `(marketing)` route group: Home, About Us, Services, AI Medical Summary, Pricing, Resources
  (blog list + post) and Contact, all CMS-driven (hero, sections, CTAs, pricing cards, posts, SEO) with
  fallback to the default copy. Shared header/nav/footer from the `site` global.
- Per-page SEO (title, description, canonical, OG image), `sitemap.xml`, `robots.txt` (apps and API
  disallowed).
- Pricing reads `GET /api/v1/public/plans` (active `SubscriptionPlan` rows, never duplicated).
- Cookie consent banner; GA4/GTM only on marketing routes and only after "Accept" (decline by default).
- Contact / Book a demo keep posting to `POST /public/leads` (lead + sales email, honeypot, rate limit).
- Tests: api 99 (+4 public plans), web 25 (analytics rules + boundary), cms 6, site-content 5, shared 83,
  worker 1; Playwright e2e 9 (+6 marketing: 3 viewports, SEO tags, sitemap/robots, no analytics
  before consent). Lint, typecheck, format and build green.
- Verified by hand: editing the Home hero in the CMS shows on the site after revalidation; Pricing
  shows the seeded plans from the DB.

## M7b — CRM console UI (2026-10-24) → M7 done

- Staff console sign-in: password → TOTP, or first-time MFA enrolment with a QR code. Session kept in
  memory and restored from the httpOnly refresh cookie. Client-org users are turned away.
- `/console/crm`: overview (open leads, pipeline value, win rate, pipeline by stage) + "My tasks today".
- `/console/crm/leads`: kanban board (drag between stages; Lost asks for a reason, Won opens
  conversion) and table view; filters (search, stage, owner = mine, source) kept in the URL;
  new lead; CSV import (row-level errors) and export.
- Lead detail: edit (React Hook Form + Zod), convert-to-client dialog (org name, admin email → invite),
  activity timeline with log call / email / meeting / note / task and done toggle, contacts.
- Accounts list + detail (portal users, originating lead, contacts, activity); contacts list with
  CSV import/export.
- Interim public `/contact` page (demo / contact form → `POST /public/leads`, honeypot) and
  `/invite/accept`. M3 makes the marketing copy CMS-driven.
- API: `GET /crm/staff` (owner / assignee picker). `@datascribe/shared/constants` entry keeps Node
  crypto out of browser bundles. Next.js rewrites `/api/v1/*` to the API (same-origin cookies).
- Playwright E2E (`apps/web/e2e`, system Chrome, `datascribe_e2e` DB, Mailpit): website demo form →
  sales login with TOTP → board drag → table → task → convert → invite email → admin accepts; lost needs
  a reason; client users can't use the console. 3/3 passing.
- Tests: api 95, shared 83, worker 1, e2e 3. Lint, typecheck, format and build green.

## M7a — CRM API (2026-10-24, commit `94eaf55`)

Built (build order M0 → M1 → M7, D-016; design notes D-018):

- Leads: list with filters (stage, owner incl. `me`, source, text, follow-up date) and pagination;
  create / view / edit / delete; stage rules (lost needs a reason, won only via conversion); stage
  history as note activities.
- `POST /leads/:id/convert`: creates the client Organization (optional plan), marks the lead won, links
  contacts and activities to the new account, invites the first client_admin (72 h link).
- `GET /pipeline/summary`: count and value per stage, open totals, win rate.
- Contacts CRUD (linked to client accounts and/or leads). Activities (call / email / meeting / note / task)
  with `GET /activities/my-tasks` for the "My tasks today" widget.
- Accounts (client orgs) list and detail: contacts, activities, users, originating lead.
- CSV import (all-or-nothing, row-numbered errors) and export (formula-injection safe) for leads and contacts.
- `POST /public/leads` for the website contact / demo forms: rate limit, honeypot, email to `SALES_INBOX`.
- Tests: `apps/api/test/crm.test.ts` (access control incl. client-org custom roles, the M7 DoD journey
  website form → lead → convert → invited admin signs in, stage rules, activities, contacts, CSV,
  accounts) and `src/lib/csv.test.ts`.

Next (M7b): CRM screens in the staff console (login + MFA, pipeline board/table, lead detail, accounts,
contacts, My tasks today, import/export).

## M1 — Auth + RBAC (2026-10-23, committed `cafeed9`)

- Register (firm + client_admin) with email verification; login with argon2, 5-strike / 15-min lockout,
  per-IP rate limits; TOTP MFA (mandatory for internal, optional / org-enforced for clients).
- Access JWT 15 min + rotating refresh cookie with family reuse detection; logout, revoke-all,
  forgot / reset; idle timeouts (console 15 min, portal 30 min) checked server-side.
- Invites (72 h). Permissions loaded from the DB per request (custom roles live without restart); client
  users can never hold `all` scope; org-scoped case queries; audit middleware.
- Read-only case / document / deliverable routes so isolation and PHI rules are tested from day one.
- Tests: 59 passing on `datascribe_test`, including cross-org isolation across the route list and
  sales/finance PHI refusal (§4.4). Gates run by Nova (agent shell blocked: `operator.approvals`).

## M0 — Foundation (2026-10-23, done locally; CI pending a GitHub remote)

Built:

- pnpm + Turborepo monorepo: `apps/{api,web,worker,cms}`, `packages/{db,shared,medical-data,ui}`.
- Prisma schema with every model in §6 (plus `Counter` for gap-free numbering), validated and generated.
- `packages/shared`: permission catalogue (16 modules × 7 actions × 4 scopes), default role matrix,
  CASL ability builder, AES-256-GCM PHI encryption helpers.
- Idempotent seed: roles, permissions, 3 plans, 1 internal + 2 client orgs, 1 user per role
  (+ second-firm admin), 3 synthetic cases with encrypted patient names.
- API skeleton (Express 5): helmet, strict CORS, request ids, pino JSON logs without bodies/queries,
  env validation including the production LLM/BAA guard (§8.3).
- Worker skeleton: BullMQ queues for the 7 pipeline stages (no-op processors until M5).
- Web skeleton (Next 15 App Router + Tailwind 4, placeholder brand tokens).
- Docker Compose: Postgres 16, Redis 7, SeaweedFS S3 (replaces MinIO, D-014), Mailpit, ClamAV (opt-in profile).
- First migration `init`, including a DB trigger that makes `AuditLog` append-only and RESTRICT FKs on it.
- GitHub Actions CI: format, lint, typecheck, test, build.

Tests: 90 passing (83 shared, 6 api, 1 worker). Coverage: shared 90.8% lines, api 96.8% lines.
Verified locally: migrate, seed (idempotent), `pnpm dev` (api/worker/web up, health 200).

Open:

- CI has not run on GitHub yet (no remote). "Seed users can log in" is satisfied once M1 adds login.
