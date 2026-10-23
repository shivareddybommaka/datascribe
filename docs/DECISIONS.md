# Decisions

Spec ambiguities and deviations, per REQUIREMENTS.md §0 rule 9. Newest last.

## D-001 — Dependency versions (2026-10-23)

Pinned to majors with known-good APIs: Next 15, React 19, Express 5, Prisma 6, Zod 3, Vitest 3,
ESLint 9, Tailwind 4, BullMQ 5, CASL 6. Newer majors exist (Prisma 8 RC, Vitest 5, ESLint 10,
TypeScript 7). An upgrade pass is scheduled for M10 so that milestones aren't blocked by migration
churn. Prisma 6 warns that `package.json#prisma` is deprecated; move to `prisma.config.ts` during the upgrade.

## D-002 — Packages consumed as TypeScript source

Workspace packages (`shared`, `db`, `medical-data`, `ui`) export `src/*.ts` directly. The API and
worker are bundled by tsup, the web app via `transpilePackages`. This avoids a build step per package.

## D-003 — Payload CMS deferred to M3

`apps/cms` is a README placeholder in M0. Payload 3 runs inside a Next.js app, so it will be a separate
small Next app using the Postgres adapter (its own `payload` schema in the same DB).

## D-004 — "invoices and payments" split into two modules

§4.3 has one row for both, with client_admin = "V + pay" and finance = F (plus refunds). The fixed action
list has no `pay`, so the row became `invoices` and `payments`:

- client_admin: `invoices:view:firm`, `payments:view|create:firm` (create = pay).
- finance: full on both, plus `payments:approve` (= refund).
- ops_manager / sales: view on both.

## D-005 — "reports and dashboards" split per dashboard

The cells (team / own / pipeline / revenue / Firm) describe _which_ dashboard, not just scope. They became
four modules, `dashboard_ops`, `dashboard_sales`, `dashboard_finance` and `dashboard_client`, so custom roles
can grant them individually. case_manager "team" = `dashboard_ops:view:assigned` (cases they manage);
summarizer/qa_reviewer "own" = `dashboard_ops:view:own`.

## D-006 — Scope `own` includes shared records

client_user is "own + shared", but the fixed scope list has no `shared`. `own` is evaluated as
`ownerId = me OR sharedWithIds contains me`. Sharing only exists for cases (CaseShare); child documents
and deliverables inherit the case's sharing.

## D-007 — `manage` and other non-CRUD actions

- `manage` is an ordinary action, not CASL's wildcard (CASL is configured with `anyAction: '*'`).
- `cases:manage` = reassign anything (ops_manager). `subscriptions:manage` = change plan (client_admin,
  finance). `deliverables:approve` = QA approval.
- super_admin gets every module × action at `all`.
- "ops_manager cannot touch super_admin" and "client_admin manages client roles only" are rules in the
  users service (M1/M2), not matrix entries. Both get tests.

## D-008 — AuditLog has no `updatedAt`

It's append-only, so an update timestamp would be meaningless. All other models carry `createdAt`/`updatedAt`.
A DB trigger that rejects UPDATE/DELETE on `AuditLog` will be added with the first migration in M1.

## D-009 — Sequential numbers via a `Counter` table

Case numbers and invoice numbers (§5.6, "sequential") come from a `Counter` row incremented inside the
same transaction (`UPDATE ... RETURNING`). Postgres sequences can leave gaps, which is not acceptable for invoices.

## D-010 — Seed cases are Synthea-style fixtures in M0

Generating real Synthea records needs Java and the Synthea jar. M0 seeds 3 hand-written synthetic cases
using Synthea's name format (e.g. `Ramiro608 Jacobs452`). M5 adds a script that generates records with
Synthea locally and renders them to PDF for the pipeline tests.

## D-011 — Local Postgres on host port 5433

Confirmed by Shiva 2026-10-23 (option A). The dev machine's Postgres on 5432 serves the existing CRM and
must never be touched or shared by Datascribe. Compose maps its port from `POSTGRES_PORT`
(default 5432, as in the spec's `.env.example`); the local `.env` uses 5433.

## D-012 — pnpm installed per-user

pnpm 9 is installed to `~/.local` for the `nova` account (Homebrew's global prefix belongs to `admin`).
`packageManager` in `package.json` pins the version for CI.

## D-014 — SeaweedFS replaces MinIO for local S3 (2026-10-23)

`minio/minio` is no longer on Docker Hub ("pull access denied"), and `quay.io/minio/minio` returns 401.
Following §8.1's rule for discontinued providers, local S3 now uses SeaweedFS's S3 gateway
(`chrislusf/seaweedfs`, Apache-2.0) on host port 9000, so `S3_ENDPOINT` is unchanged. Production still
targets AWS S3. Code only talks to the S3 API through the AWS SDK, so the backend is swappable. There's no
web console. Buckets are created by the API at startup (M4).

## D-015 — Colima as the local Docker runtime

OrbStack and Docker Desktop are tied to a GUI login session, and the agent runs headless as `nova`.
Colima (`brew install colima docker docker-compose`, run from `admin`) runs per user with no GUI.
Scripts use the standalone `docker-compose` binary, which avoids editing `~/.docker/config.json`.

## D-016 — Build order M0 → M1 → M7 (CRM first)

Shiva's decision on 2026-10-23, departing from §0 rule 2. M7 runs before M2–M6, so:

- "Lead from website form" (M7 DoD) uses a public `POST /api/v1/public/leads` endpoint (honeypot + rate limit)
  built in M7. The CMS-driven contact page in M3 will post to that same endpoint.
- "Convert lead → invite client_admin" sends the invite email directly via Nodemailer → Mailpit.
  M9 moves email onto the notification/worker pipeline.
- Admin UI for users/roles (M2) isn't needed for M7. Seeded roles cover CRM use.

## D-017 — M1 auth design choices (2026-10-23)

- **Tokens.** The access JWT (HS256, 15 min) carries `sub` + `sid`. The refresh token is an opaque random value.
  Only its SHA-256 is stored, and it lives in the `ds_refresh` cookie (httpOnly, SameSite=Strict,
  `Path=/api/v1/auth`, Secure in production, 7 days sliding). MFA step tokens (5 min) are signed with
  `JWT_REFRESH_SECRET`, so an MFA token can never pass as an access token.
- **Rotation.** Every refresh revokes the old row and creates the next one in the same `familyId`.
  Presenting an already-rotated token revokes the whole family and writes `auth.refresh.reuse_detected`.
  Known trade-off: two tabs refreshing at the same instant can trigger this and sign the user out. A
  short grace window can be added if it happens in practice.
- **Session check on every request.** The access token's session row is looked up per request, so logout,
  revoke-all, password reset and idle timeouts take effect immediately. `lastUsedAt` is touched at most
  once a minute. Idle limits: console 15 min, portal 30 min, chosen by org type (internal → console).
- **CSRF.** Cookie routes (`/auth/refresh`, `/auth/logout`) need the `X-Datascribe-CSRF: 1` header (forces a
  CORS preflight). If an Origin is sent, it must equal `APP_URL`. All other routes use bearer tokens.
- **MFA.** Required when the user's org is internal, they hold an internal role, the org sets
  `settings.enforceMfa`, or they enrolled voluntarily. The TOTP secret is AES-GCM encrypted (`v1:` envelope).
  Wrong codes count toward the 5-attempt lockout. Open item: TOTP replay inside the same 30 s step is not
  blocked yet (needs a `mfaLastStep` column). Planned for M10 hardening.
- **Lockout.** 5 failures → `lockedUntil = now + 15 min` (HTTP 423, `account_locked`). This does reveal that
  the account exists, but only after the attacker has already burned 5 attempts. The UX benefit wins.
  Unknown emails run a dummy argon2 verify to keep timing uniform.
- **Rate limits** (per IP, in-memory, `express-rate-limit`): auth 30 / 15 min, public 10 / 15 min. Move to a
  Redis store when the API runs more than one instance (M10).
- **Enumeration.** register / forgot always return 202. A duplicate registration emails the existing owner.
- **Hard org isolation.** Users in client orgs have any `all`-scope grant narrowed to `firm` when their
  permissions are loaded. Every case query for them also gets an extra `organizationId` filter. A
  misconfigured custom role therefore still can't cross firms (tested).
- **Scope union.** List queries OR together every scope the user holds for module:action, rather than
  using only the broadest one.
- **Audit.** An app-level middleware gives every request `req.audit()`, bound to actor, impersonator, IP
  and UA. Metadata holds ids, counts and reasons only.
- **Not-visible = 404** on id routes, so the existence of other firms' cases isn't leaked. Missing module
  permission = 403.
- **Test DB.** API integration tests use `datascribe_test` on the Docker Postgres (5433), created/reset by
  `apps/api/test/global-setup.ts`. That script refuses any DB whose name doesn't end in `_test`. CI runs a
  Postgres service container.

## D-018 — M7 CRM design choices (2026-10-24)

- **Internal-only.** CRM records (leads, contacts, activities, account views) belong to Datascribe and have
  no firm scope. Every CRM route needs `crm:<action>` and a user in the internal org. A client-org custom role
  with crm grants still gets 403 (tested).
- **Won = converted.** A lead reaches `won` only through `POST /leads/:id/convert`, since every win becomes
  a client account here. After conversion the stage is final, and the lead can't be deleted (it's the
  account's history). `lost` needs a `lostReason` (§5.5), which is cleared when the lead is reopened.
- **History.** Stage changes and conversion are written as `note` activities by the acting user. At
  conversion, the lead's contacts and activities are also linked to the new account (`organizationId`), so
  history shows up on both. Without a contact, one is created from the lead plus the admin email.
- **Conversion permission.** Conversion needs `crm:edit`, not `users:create`: sales can't manage users, but
  inviting the new firm's first client_admin is part of conversion. `issueInvite()` holds the shared invite
  logic. `createInvite()` adds the admin-side permission rules. If the invite fails after the org is
  created, the response is still 201 with `inviteError`, and the admin can be invited again later (M2).
- **CSV.** A hand-written RFC 4180 parser and writer in `apps/api/src/lib/csv.ts` (no dependency). Imports are
  all-or-nothing: any invalid row gives 422 with row numbers and nothing is written, because a partial
  import is harder to fix. Max 5,000 rows and 5 MB. Export neutralises formula injection by prefixing `'`
  to cells starting with `= + - @ tab CR` (OWASP), so a phone like `+61…` exports as `'+61…`. No
  de-duplication on import yet.
- **Public lead form.** `POST /public/leads` (the M3 website forms will post here): per-IP rate limit,
  hidden `website` honeypot (silently accepted, nothing stored), emails `SALES_INBOX` (Mailpit locally).
- **My tasks today.** The client sends `dueBefore` = the end of the user's local day, which avoids
  server-side timezone guessing. Overdue tasks are included and flagged.
- **Notifications** for "lead assigned" / "task due" arrive with M9.

## D-019 — M7b console UI choices (2026-10-24)

- **Same-origin API via Next rewrites.** `/api/v1/*` on the web origin is proxied to `API_URL`. The
  refresh cookie (`Path=/api/v1/auth`, SameSite=Strict) and the CSRF Origin check (`APP_URL`) then work
  unchanged. `API_URL` is read when `next build` / `next dev` starts.
- **Access token in memory only** (never localStorage). A reload calls `/auth/refresh`. A 401 refreshes
  once and retries. UI permission checks (`useCan`) only hide buttons; the API enforces everything.
- **shadcn/ui-style primitives without the CLI.** `apps/web/components/ui.tsx` uses the same building
  blocks as shadcn (class-variance-authority + clsx + tailwind-merge) with the brand tokens, plus the
  native `<dialog>` for modals (focus trap, Esc and backdrop come from the browser). This avoids pulling
  in Radix for four components. Moves to `packages/ui` when a second app needs them.
- **Kanban with native HTML5 drag-and-drop** (no dnd library). Dropping on Lost asks for the required
  reason; dropping on Won opens the conversion dialog. Keyboard users change stage from the lead page.
  Board and table load up to 500 matching leads and say so when there are more.
- **Browser-safe shared entry.** `@datascribe/shared/constants` holds enums only. The package root also
  exports the Node crypto helpers, so browser code must not import it.
- **Interim `/contact` and `/invite/accept` pages** let the M7 journey run end to end before M3/M4.
  The portal sign-in itself is M4.
- **Playwright now, not in M10.** §13 asks for a lead-capture → convert journey, so it was added here,
  using the installed Google Chrome (`channel: 'chrome'`) so no browser download is needed. It runs locally
  against `datascribe_e2e` (5433) + Mailpit. CI e2e (browser + Mailpit services) is planned for M10.

## D-050 — NLM Clinical Table Search Service: ICD-10-CM and HCPCS (checked 2026-10-24)

Docs: https://clinicaltables.nlm.nih.gov/apidoc/icd10cm/v3/doc.html,
https://clinicaltables.nlm.nih.gov/apidoc/hcpcs/v3/doc.html, terms/FAQ https://clinicaltables.nlm.nih.gov/faq.html.

- Endpoints unchanged from §8.2: `/api/icd10cm/v3/search` and `/api/hcpcs/v3/search` (`terms`, `sf`, `df`,
  `maxList` ≤ 500). Output `[total, codes, extra, display[][]]`. No key, no registration.
- Limits: advised max 25 req/s (soft), may answer 503 under load; tell NLM above 50,000 calls/day.
- Terms: free, "as is", no SLA. NLM/LHNCBC/NIH names may not be used to endorse the product. The FAQ says
  request URLs are logged and asks that no PHI/PII be sent, which `deidentifyTerm()` (D-054) enforces.
- `ProcedureCoder` uses the HCPCS Level II table. CTSS has no CPT (AMA-licensed) or ICD-10-PCS table, so
  HCPCS is the free procedure set available. HCPCS `display` is the 28-character short description, as
  recorded; switching to `long_desc` changes the request URL and needs one fixture re-record (open item).
- Default bucket 10 req/s, burst 10, shared by both tables (same host).

## D-051 — NLM RxNav / RxNorm API (checked 2026-10-24)

Docs: https://lhncbc.nlm.nih.gov/RxNav/APIs/api-RxNorm.getApproximateMatch.html, terms
https://lhncbc.nlm.nih.gov/RxNav/TermsofService.html.

- `MedicationNormalizer` uses `GET /REST/approximateTerm.json?term=&maxEntries=20&option=1` (active
  concepts; tolerates misspellings, strengths and extra words). Candidates are collapsed to one match per
  RxCUI, preferring the `RXNORM`-source name; candidates without a releasable name are dropped.
- Limit: 20 req/s per IP (100 with a UMLS UTS key in `Authorization: Bearer`); over-limit requests are not
  served. NLM recommends caching 12–24 h to cut load; we keep §8.4's 30 days, which cuts load further.
  RxNorm is released monthly, so a cached answer is at most about one release behind.
- Attribution required: the NLM statement ("This product uses publicly available data from the U.S.
  National Library of Medicine…") is in `ATTRIBUTION.rxnorm.statement`. The NLM name/logo may not be used
  with the app. Default bucket 8 req/s, burst 10.

## D-052 — openFDA Drug Label API (checked 2026-10-24) — changed

Docs: https://open.fda.gov/apis/drug/label/how-to-use-the-endpoint/, https://open.fda.gov/apis/authentication/,
terms https://open.fda.gov/terms/.

- Endpoint unchanged: `https://api.fda.gov/drug/label.json?search=…&limit=1`; 404 means no match.
- **Change:** the authentication page now opens with "An API key is required", while the endpoint page
  still says a key isn't needed, and both list no-key limits (240/min and 1,000/day per IP; with a key
  240/min and 120,000/day). The fixture was recorded without a key (HTTP 200). Decision: keep
  `OPENFDA_API_KEY` optional as §11 says, send it as `api_key` when set, and **register a free key before
  production** (1,000/day is too low for real volume). Listed under "Waiting on Shiva".
- Data is CC0; attribution is requested, not required: "Data provided by the U.S. Food and Drug
  Administration (https://open.fda.gov)". Default bucket 2 req/s, burst 10.
- Search: `openfda.rxcui:"<rxcui>"`, or `openfda.generic_name:"<name>" openfda.brand_name:"<name>"`
  (OR) after stripping strengths and dose forms. Sections are truncated to 1,500 characters; boxed
  warning > warnings and cautions > warnings.

## D-053 — MedlinePlus Connect (checked 2026-10-24)

Docs and acceptable use: https://medlineplus.gov/medlineplus-connect/web-service/.

- Endpoint unchanged: `https://connect.medlineplus.gov/service` (HTTPS only), JSON via
  `knowledgeResponseType=application/json`. Code systems: ICD-10-CM `2.16.840.1.113883.6.90`, SNOMED CT
  `…6.96`, RxCUI `…6.88`. HCPCS isn't accepted (procedures take CPT or SNOMED), so HCPCS definitions
  return null.
- Limit: 100 requests/min per IP; over-limit callers are blocked for 300 s. NLM recommends caching 12–24 h.
  Default bucket 1.2 req/s (72/min), burst 10.
- Terms: data may be displayed and linked but MedlinePlus pages may not be copied; show that the
  information is from MedlinePlus.gov; no logo or implied endorsement. Summaries are converted to plain
  text and capped at 1,200 characters, always with the topic URL.
- `ConsumerHealthInfo` sends codes only, never text, and codes are shape-checked first.

## D-054 — `deidentifyTerm()` design

- Rules strip, in order: emails, URLs, SSNs, labelled and unlabelled dates (numeric, month-name, month/year,
  bare years except before dose units), labelled record/case/claim/account numbers and court dockets,
  street addresses / PO boxes / units / state + ZIP, phone numbers (7+ digits, not when followed by a dose
  unit), ages, names (Synthea style `Ramiro608`, honorific + capitalised words, labelled names, possessive
  full names), then any run of 5+ digits. Callers can pass `knownIdentifiers` (patient name, case number),
  which the pipeline will do.
- **All ages are removed**, not only > 89 (HIPAA Safe Harbor's threshold): no age helps coding.
- Refusals: raw input over 200 characters, or a cleaned term over 100 characters or 10 words
  (`too_long`), or nothing with a letter left (`empty`). Adapters return "uncoded" for refused terms
  without calling; the API answers 422 `term_refused` with the reason and removed kinds, never the input.
- It errs towards removing too much (e.g. "Lou Gehrig's disease" loses "Lou Gehrig's"). Free-text names
  without a label or honorific can't be detected reliably by rules, so the pipeline must pass the case's
  known identifiers, and only extracted short terms ever reach it.
- Numeric RxCUIs bypass it in `getLabel()`/`/drug-label?rxcui=`: they're codes that came back from RxNorm.

## D-055 — Resilience wrapper (`ProviderClient`)

- Order per request: provider enabled? → cache → circuit breaker → token bucket → 10 s timeout per
  attempt → 3 retries (exponential backoff with jitter, 250 ms base, 4 s cap; only network errors,
  timeouts, 408, 429, 5xx) → on final failure the caller's "uncoded" fallback (`[]` or `null`), never a throw.
- Cache keys are SHA-256 of provider + normalised request (lower-case, trimmed, collapsed spaces), so the
  `MedicalApiCache` table never stores the term. Values are the mapped results, TTL 30 days.
  `PrismaCacheStore` takes `prisma.medicalApiCache` structurally, so `medical-data` has no DB dependency.
  A failing cache is ignored, not fatal. `purgeExpired()` is ready for a worker cron (M5b).
- Breaker: opens after 5 consecutive failed requests, half-opens after 60 s with one trial call.
- Buckets and breakers are per process. Several API/worker processes share one IP, so defaults sit at
  roughly half of each published limit. A Redis-backed bucket is a later option (M10, with the auth limits).
- Logs carry `provider`, `latencyMs`, `status` (plus error name / HTTP status on failure) only. URLs carry
  the term and openFDA key, so they're never logged.
- Usage stats (`MedicalData.usageStats()`): in-memory, per process, last 24 h calls / errors / error rate /
  cache hits / skipped per upstream. Good enough for the M2 admin page on one API instance; persisting
  counters (Redis or a table) is a follow-up if the page needs totals across processes.
- The admin enable/disable switch is the factory's `isEnabled(upstream)` callback, read per call, so M2 can
  back it with a `Setting` row and changes apply without restart.
- No new dependencies: Node 22 `fetch`, `node:crypto`. `tsx` and `@vitest/coverage-v8` were already in the
  lockfile and are now dev dependencies of `medical-data` too.

## D-056 — Medical API routes (§9)

- `GET /medical/icd10?q=&limit=`, `/medical/rxnorm?q=`, `/medical/drug-label?q=` or `?rxcui=`,
  `/medical/define?code=&system=ICD10CM|RXNORM|SNOMED`.
- Access: internal org **and** `cases:edit`. That admits super_admin, ops_manager, case_manager and
  summarizer; sales, finance, all client users and also **qa_reviewer** (cases view-only) get 403. If QA
  should look codes up while reviewing, grant it here (open question).
- Every term goes through `deidentifyTerm()` in the route and again in the adapter. Responses return the
  cleaned `query`, the removed identifier kinds, results and the provider's `attribution`
  (source, statement, URL). Query strings are already excluded from request logs (app.ts serializer).
- `Deps.medical` is optional and defaults to the mock providers, so tests and existing callers need no
  change. `server.ts` builds the real one from `MEDICAL_DATA_PROVIDER` with the Prisma cache.
- Recorded fixtures (`packages/medical-data/test/fixtures`, recorded 2026-10-23 UTC with "lumbar
  radiculopathy", "cervical collar", "gabapentin", code M54.16) are replayed by exact URL; any other URL
  throws, so tests can't reach a live API. Live smoke tests run only with `RUN_LIVE_API_TESTS=true`.

## D-040 — Usage and plan changes (M8, 2026-10-24)

- **A case's pages count once, on first delivery.** `UsageRecord` is unique per case, so a
  redelivery or a retried job never bills twice. Manual entries (`POST /usage`, finance only) cover
  corrections and work done outside the pipeline.
- Usage is filed under the billing period that contains the delivery (the subscription's current
  period, or the calendar month when the firm has no subscription).
- **No proration in v1.** A plan change takes effect at once. The period invoice uses the plan in force
  when the period ends: plan fee + overage pages × that plan's overage price. Changing plan also clears a
  pending cancel-at-period-end.

## D-041 — Billing money arithmetic

Extends D-013. `packages/billing/src/money.ts` works in bigint units of 1/10,000 of a currency unit,
so 4-decimal per-page prices multiply exactly. Line amounts, tax and totals are rounded half-up to
cents at the point they are produced. API responses carry amounts as decimal strings, never floats.

## D-042 — Payment gateways

- `PaymentGateway` interface (checkout session, webhook parse, refund) with three implementations:
  **Stripe** (test-mode keys only: `sk_test_` / `rk_test_`, anything else throws), **Fake** (signed
  webhooks, a simulated checkout page) and a **Razorpay** stub for later.
- `PAYMENT_GATEWAY=stripe` without `STRIPE_SECRET_KEY` falls back to Fake, so dev, CI and E2E never
  need Stripe. Production env validation refuses Fake.
- The webhook, not the pay call, marks an invoice paid. It is signature-checked and idempotent on the
  gateway event, so replays record nothing new.
- Refunds (finance, `payments:approve`) call the gateway first, then update the payment with a
  compare-and-set on `refundedAmount`, so two concurrent refunds can't both apply.

## D-043 — Billing schedule

The worker runs two BullMQ repeatable jobs (UTC): `monthly-invoicing` daily at 02:00 and `dunning`
daily at 09:00. Invoicing bills every subscription whose period has ended, so each firm is invoiced on
its own anniversary, a missed day catches up (one invoice per period) and a re-run never bills a period
twice. Dunning emails client admins on the due date, +7 and +14 days (Mailpit only) and marks
invoices overdue. Finance can trigger both runs from the console; `asOf` is refused in production.

## D-044 — M8 finance console UI

- `/console/finance`: overview, invoices (list + detail), subscriptions, plans. The console header
  gets a section switcher (CRM | Finance), shown by `crm:view` / `invoices:view`. As in D-019 this
  only hides links; the API enforces access.
- MRR on the overview is the sum of live subscriptions' plan prices, computed in the browser. It is
  shown **per currency** with no conversion. `/dashboards/finance` (revenue by client etc.) is M9.
- Forms use plain controlled state rather than React Hook Form: the API validates every field and
  returns the message, and the one-off invoice's variable line list is simpler this way.
- Invoice PDFs download through `downloadFile()` with the bearer token, because a plain link can't
  send it.
- Paying is for the firm (client_admin, §5.3 portal billing), so the console has no pay button. The
  portal billing screens are not built yet; checkout's return URLs already point at
  `/portal/billing/invoices/:id`.

## D-030 — M3 marketing website + CMS choices (2026-10-24)

- **Payload in its own Next app (`apps/cms`) with its own database** (`CMS_DATABASE_URL`, 5433), not a
  schema in the platform DB. CMS editors are Payload users, separate from platform users, and marketing
  content never sits next to PHI. Migrations only (`push: false`). GraphQL off; CORS/CSRF limited to
  `APP_URL`. Payload 3.92 needs Next 16, so `apps/cms` is on Next 16 while `apps/web` stays on 15.
- **The web app reads the CMS over REST, server-side, with ISR (60 s).** Browsers never call the CMS
  for content. If the CMS is down (or during `next build`), the page renders the default copy from
  `packages/site-content` and retries on the next revalidation, so the site never goes blank.
- **`packages/site-content`** holds the content types shared by both apps and the synthetic default copy.
  The CMS seed writes the same defaults, so seed and fallback can't drift.
- **Page model:** one `pages` collection with a fixed slug per route (7 slugs), a hero group, a blocks
  field for sections (feature grid, numbered steps, rich text, FAQ, call to action), Pricing card copy,
  Contact form copy and an SEO group (title, description, OG image). `posts` for Resources. A `site`
  global for nav, header CTA, footer and cookie banner text. Drafts are never served to anonymous reads.
- **Pricing from the DB.** `GET /api/v1/public/plans` returns active `SubscriptionPlan` rows (money as
  decimal strings). The CMS only holds card copy (taglines, labels, highlighted plan). If the API is
  down the page shows the CMS "unavailable" message instead of stale prices.
- **Analytics:** GA4/GTM only from the `(marketing)` layout, plus a path guard for `/console`, `/portal`,
  `/invite`, `/api`. No choice = declined; IDs must match `G-…` / `GTM-…`. No banner when no IDs are set.
- **Lighthouse** isn't installed (needs approval), so the ≥ 90 AC is not yet measured. Playwright checks
  the 7 pages at 375 / 768 / 1280 px (no horizontal scroll), per-page title/description/canonical,
  sitemap/robots and "no analytics requests before consent".
- **E2E ports/DB are overridable** (`E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_DATABASE_URL`, 5433 and
  `datascribe*_e2e` only) so parallel worktrees don't reset each other's E2E database.
- **`@datascribe/web#typecheck` runs after `@datascribe/web#build`** (turbo.json). Both use
  `.next/types`; in parallel, `next build` deleted files tsc had already globbed (TS6053).

## D-013 — Money and encrypted fields

Money is `Decimal(12,2)` (per-page prices `Decimal(12,4)`). Encrypted PHI fields (`Case.patientName`,
`DocumentPage.text`, `ClinicalEvent.description`, `Deliverable.content`, `User.mfaSecret`) are `String`
columns holding a versioned AES-256-GCM envelope `v1:iv:tag:ct`. `Deliverable.content` is encrypted JSON,
so it's stored as text rather than `Json`. `ClinicalEvent.description` is encrypted too; the spec doesn't
list it, but it is clinical narrative about the patient.
