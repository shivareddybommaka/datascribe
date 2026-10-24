# Changelog

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
  Sales and ops managers only. Ops, finance and client dashboards are next.

## M5b — Processing pipeline (in progress, `main`)

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
