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

## D-020 — Security patching of dependencies (2026-10-24, approved by Shiva)

- nodemailer 6 → 10 in api and worker (audit finding M7). The mailer API we use (createTransport and
  sendMail) is unchanged. Verified with a real send to Mailpit.
- The CMS moves from next 16.3.3 to 16.4.3 (Payload 3.92 allows `>=16.3.3 <17`) and from sharp
  0.35.4 to 0.35.5. Root `pnpm.overrides` force dompurify ≥3.4.17 (inside Payload's Monaco editor),
  postcss ≥8.5.23 (inside next 15 for apps/web) and sharp ≥0.35.5. Result: 23 advisories (4 critical)
  down to 2 (0 critical).
- Remaining: deepmerge-ts in the Prisma 6 CLI (goes away with the Prisma upgrade in D-001) and
  esbuild 0.18 in drizzle-kit (dev-server CORS only, a server we never run). Remove the overrides once
  upstream versions include the fixes.

## D-021 — Web dev port 3010, never 3000 (2026-10-24)

`~/.cloudflared/config.yml` (Shiva's StaySpot setup) tunnels crm.stayspot.app to `http://localhost:3000`.
Datascribe's web dev server also used 3000, which blocked StaySpot's app. If the tunnel had been up, it
would also have published the Datascribe dev site on that hostname. Web dev now runs on 3010, bound to
127.0.0.1. Port 3000 is reserved for StaySpot (CLAUDE.md, AUTOPILOT.md).

## D-022 — M2 admin users API (2026-10-24)

- **Create = invite.** §5.7 lists "create" and "invite"; admins never set another person's password,
  so "create user" sends an invite (`POST /invites`) and the account exists once accepted.
- **Scoping.** `users:<action>` at `all` (internal) sees every org; at `firm` only the caller's org
  (client_admin). Other orgs' users are 404, not 403. Nobody can suspend/reset themselves; only
  super_admin can change a super_admin; client admins can only change holders of client roles.
- **Suspend** revokes every session at once (the access-token check reads the session row). **Reset MFA**
  clears the secret, revokes sessions and emails the user; internal users must enrol again at next
  sign-in. **Force password reset** sets `mustResetPassword`, revokes sessions, voids older reset
  links and emails a new one; `/auth/login` refuses sign-in with `password_reset_required` until it
  is used (or "Forgot password"). Each action writes an `admin.user.*` audit row.

## D-060 — M2 roles, role assignment and audit finding M4 (2026-10-24)

- **Routes.** `GET/POST /roles`, `GET/PATCH/DELETE /roles/:id` (§9), `GET /permissions`,
  `POST /admin/users` (create = invite, D-022) and `PUT /admin/users/:id/roles` (replace roles).
- **Who.** Reading roles needs `users:view`; client admins only see client roles. Changing roles needs
  the internal org and `users:create|edit|delete` at `all` (super_admin, ops_manager; delete is
  super_admin only by the seed matrix). Roles are global rows shared by every firm, so client admins
  never edit them.
- **Built-in roles.** Never deleted. `super_admin` is locked (always every permission, so nobody can
  lock the platform out). Other built-in roles are editable by super_admin only.
- **Custom roles.** `group` internal or client, fixed at creation. Key is `custom_<slug>` unless given;
  built-in keys are refused. A role in use (users or unexpired invites) can't be deleted; deleting
  removes its accepted/expired invite rows (the audit log keeps their history).
- **Client roles** never hold `all` scope and only use client modules (`CLIENT_MODULES`: cases,
  documents, deliverables, invoices, payments, subscriptions, users, dashboard_client). The request is
  rejected (400) rather than silently narrowed. Load-time narrowing (D-017) still applies as a backstop.
- **`system_settings`** is reserved for the built-in super_admin role (`RESERVED_MODULES`): custom roles
  can't hold it, so "settings are super-admin only" needs no special case in the routes.
- **Audit M4: grant only what you hold.** A role create/edit, invite or role assignment may only hand
  out permissions the actor holds: same module and action at the same or a broader scope
  (`holdsPermission`). super_admin is exempt. A non-super admin can only edit roles that sit entirely
  within their own grants. Consequence: ops_manager can no longer invite or assign roles with
  permissions it lacks (e.g. client_admin, case_manager: `documents:edit`); super_admin does those. CRM
  lead conversion still invites a firm's first client_admin through `issueInvite()` (D-018).
- **Assignment rules.** Roles must match the org type; client admins assign client roles in their own
  firm; only super_admin grants super_admin; at least one active super_admin must remain. Audit row
  `admin.user.roles_changed` with before/after keys.
- **Takes effect without restart (M2 DoD).** Permissions are read from the DB on every request (D-017),
  so a matrix edit or role change applies on the holder's next request. Sessions are not revoked.

## D-061 — Read-only impersonation (§4.4, 2026-10-24)

- `POST /admin/impersonate/:userId`: super_admin (internal org) only, target must be an active user in
  an active **client** org. It creates a `Session` with `impersonatorId` (new column, migration
  `20261024120000_admin_impersonation`) and returns an access token with `imp`. No refresh cookie is
  set, so the super admin's own refresh cookie is untouched and the impersonation ends when the
  15-minute access token expires (or on stop, or reload: the web client keeps it in memory only).
- **Binding.** The token's `imp` must equal the session's `impersonatorId` (both ways), so `imp` can't
  be forged onto a normal session or dropped from an impersonation one. Each request also re-checks that
  the impersonator is still an active super_admin.
- **Read-only.** While impersonating, every method other than GET/HEAD/OPTIONS gets 403
  `impersonation_read_only` in `resolveAuth`, except `POST /admin/impersonate/stop`. This covers every
  authenticated route, including ones added later.
- **Audit.** Start and stop are rows with `actorId` = the client user and `impersonatorId` = the super
  admin (`admin.impersonation.started|stopped`); every other audit row written during the session
  carries `impersonatorId` automatically.
- **UI.** The console accepts a client user only while impersonating, and shows an amber banner on every
  screen (who, which firm, read-only, end time) with a Stop button. The client portal (M4) will reuse
  the same banner.

## D-062 — Organizations admin (2026-10-24)

- `GET /admin/organizations`, `GET/PATCH /admin/organizations/:id`, `POST …/suspend|reactivate`.
  Internal staff with `users:<action>` at `all` (super_admin, ops_manager): organisations are part of
  "users and clients" (§4.1). There's no separate module in the fixed list.
- PATCH: name, status, plan, currency, `enforceMfa`, `retentionDays` (30–3650, default 180, §10) and
  `customPricing { priceMonthly, includedPages, overagePerPage }` (or null), the last three in
  `Organization.settings`.
- **Custom pricing** replaces the plan's fee, included pages and overage price in the monthly invoicing
  run (`effectivePlanPricing` in `packages/billing`); the invoice line reads "<plan> (custom pricing)".
- **Suspend** revokes every session in the firm at once; logins were already refused for suspended
  orgs (D-017). The Datascribe org can't be suspended. Rows: `admin.org.updated|suspended|reactivated`.
- Creating organisations stays with self-registration and CRM conversion (§9 lists `POST
/organizations`; not needed for the M2 AC).

## D-063 — Settings and email templates (2026-10-24)

- `GET /admin/settings`, `PUT /admin/settings/company|sla|notifications|medical`, all needing
  `system_settings` (super_admin only, D-060) and the internal org. Each section is a `Setting` row;
  reads merge over defaults and fall back to them if a stored row no longer validates.
  - `company`: company details plus invoice settings (tax label/rate, per-currency tax, invoice
    prefix, payment terms); billing reads it (`getBillingSettings`).
  - `sla`: due-in days per priority and the amber "due soon" window, for the M6 case queue.
  - `notifications`: email / in-app switch per §5.8 event, for M9. Security emails are not listed.
  - `medical`: on/off per upstream (§8.4) plus the provider mode, whether an openFDA key is set, and
    last-24h usage from `deps.medical.usageStats()`. The API reads the switches through
    `MedicalSwitches`, updated at once on save and reloaded every 30 s, so other processes follow
    without a restart. The worker doesn't use medical adapters yet (M5b); it should use the same class.
- **Email templates** (`/admin/email-templates`, list / PUT / DELETE = restore default / POST preview):
  `invite`, `password_reset`, `mfa_reset`, now used by those emails. Plain text only (mail is sent as
  `text`), so no HTML injection is possible. Each template declares its variables; saving fails on
  unknown `{{names}}`, stray braces, or a missing required variable (e.g. the accept link). Rendering is
  one pass: values are inserted literally (a value containing `{{x}}` isn't expanded) and line breaks
  are removed from subjects (no header injection). Stored as one `email_templates` setting.

## D-064 — Audit log viewer and lockout race (audit M2) (2026-10-24)

- `GET /admin/audit-logs`: internal staff with `audit_log:view` (super_admin, ops_manager). Filters:
  `user` (actor or impersonator name/email), `actorId`, `action` (prefix, e.g. `admin.role`), `entity`,
  `entityId`, `organizationId`, `impersonatedOnly`, `from`/`to` (a plain date `to` is inclusive).
  Newest first, `limit`/`offset`. No write routes exist (D-008).
- `GET /admin/audit-logs/export`: CSV via `lib/csv.ts` (formula-injection safe), needs
  `audit_log:export` (super_admin), max 10,000 rows per export (narrow the filters), and is itself
  audited (`admin.audit.export`).
- **Lockout race (audit M2).** Before a password or TOTP code is checked, the login reserves one of the
  5 attempts with a single conditional `UPDATE … RETURNING`: it only succeeds while the account isn't
  locked and fewer than 5 attempts are used, and the attempt that reaches 5 sets `lockedUntil` in the
  same statement. A correct secret gives its attempt back; an expired lock starts a fresh count. Tested
  with 20 parallel wrong passwords (at most 5 are checked, the rest get 423) and 12 parallel wrong MFA
  codes.

## D-013 — Money and encrypted fields

Money is `Decimal(12,2)` (per-page prices `Decimal(12,4)`). Encrypted PHI fields (`Case.patientName`,
`DocumentPage.text`, `ClinicalEvent.description`, `Deliverable.content`, `User.mfaSecret`) are `String`
columns holding a versioned AES-256-GCM envelope `v1:iv:tag:ct`. `Deliverable.content` is encrypted JSON,
so it's stored as text rather than `Json`. `ClinicalEvent.description` is encrypted too; the spec doesn't
list it, but it is clinical narrative about the patient. Since M4 `Case.notes` and `Message.body` are
encrypted as well (audit L5, D-075).

## D-070 — Document storage on S3 / SeaweedFS (M4, 2026-10-24)

- **AWS SDK v3** (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) behind `DocumentStorage`
  (`apps/api/src/lib/storage.ts`). Path-style addressing when `S3_ENDPOINT` is set (SeaweedFS), AWS
  defaults otherwise; no credentials in env = the AWS default chain (instance role).
- **Checksums `WHEN_REQUIRED`.** Recent SDKs add CRC32 checksum parameters to presigned part URLs,
  which a browser PUT can't satisfy (SeaweedFS answers 400). Turned off; S3 still checks each part's
  MD5/ETag, and we check part sizes and the file's SHA-256 ourselves.
- **Server-side encryption** is `S3_SSE=AES256 | aws:kms | none`, default AES256, sent on every write
  and set as the bucket default. Local SeaweedFS has no SSE without a KMS (any SSE request returns
  InternalError), so local `.env` files and tests use `none`. Production env validation refuses `none`.
- **Buckets** (documents, deliverables) are created at API startup if missing, with public access
  blocked (AWS; SeaweedFS buckets are private anyway) and CORS on the documents bucket allowing only
  `PUT` from `APP_URL` (+ `EXTRA_TRUSTED_ORIGINS`). Startup work never stops the API: bucket setup
  retries every 30 s and is logged.
- **Object keys hold ids only** (`org/<org>/cases/<case>/<uuid>`), because file names can contain
  patient names. File names are never logged or put in audit metadata.

## D-071 — Resumable uploads (M4)

- The `Document` row is the upload: `POST /cases/:id/uploads` creates it with the S3 `uploadId`;
  `uploadedAt` is set on completion. Part size `UPLOAD_PART_SIZE_MB` (default 8 MiB, S3 minimum 5),
  doubled when needed to stay within S3's 10,000 parts (a 500 MB file = 63 parts).
- Part URLs are presigned **just in time, one part per call** (`POST /uploads/:id/parts`, 30 min), so
  a slow upload never holds an expired URL. `GET /uploads/:id` lists the parts S3 already has
  (ListParts): that is what resuming uses, after a reload or on another day.
- `/complete` takes no ETags from the client: the API reads them with ListParts, checks every part
  is present (409 `upload_incomplete` + `missingParts`) and that the sizes add up to the declared size
  exactly (422 `size_mismatch`), so the browser never needs to read the ETag header. Completing twice
  is harmless.
- **Magic bytes** (§10): after completion the first 16 bytes decide the type (PDF, PNG, JPEG, TIFF).
  Anything else is deleted with its row (422 `file_type_not_allowed`, audited `document.rejected`). A
  real allowed type that differs from what the browser declared (e.g. a PDF named `.png`) is accepted
  under its real type.
- Browser: one file at a time, 3 parts in parallel, 3 attempts per part with backoff, then the file
  shows "Interrupted" with **Resume**. The browser remembers only SHA-256(case, name, size, mtime) →
  upload id in localStorage, so choosing the same file again resumes it. Pause aborts the in-flight
  requests. An unfinished upload is listed on the case and can be cancelled (`DELETE /uploads/:id`).
- Records can be added or removed while the case is `draft`, `submitted` or `on_hold` (409
  `case_locked` once processing starts).

## D-072 — Verification, virus scanning and downloads (M4)

- `VirusScanner` interface: `MockVirusScanner` (only the EICAR test string is "infected") by default,
  `ClamdScanner` when `CLAMAV_HOST` is set. The clamd client is ~60 lines of the `zINSTREAM` TCP
  protocol, so no package was added. Production refuses to start without `CLAMAV_HOST`. The compose
  `scan` profile runs `clamav/clamav` on 127.0.0.1:3310.
- After `/complete` one pass over the object computes SHA-256, feeds the scanner and (files ≤ 150 MB)
  counts pages: pdf-lib for PDFs, the IFD chain for TIFF, 1 for PNG/JPEG. Larger files keep
  `pageCount` null for the pipeline (M5).
- `scanStatus`: `pending` → `clean`, or `infected` (object moved under `quarantine/`, never
  downloadable), or `error` when the scanner fails (fails closed: not downloadable, shown as "Scan
  failed"). Each result is a system `document.scan` audit row with the scanner and signature names.
- Until the M5b worker takes this over as pipeline stage 1, the API runs it in the background after
  `/complete` (inline in tests, `Deps.verifyUploads`) and re-runs anything left `pending` at startup.
- `GET /documents/:id/download-url`: presigned GET, **5 minutes**, `Content-Disposition: attachment`
  (RFC 6266, non-ASCII safe), `Cache-Control: private, no-store`, clean documents only (409
  `scan_pending` / `quarantined` / `scan_failed`), audited `document.download`.
- §4.4 audit rows: `document.create`, `.upload_complete`, `.scan`, `.view`, `.list`, `.download`,
  `.edit` (rename), `.delete`, `.rejected`. Deleting needs `documents:delete` (client_admin, staff),
  so client users can't delete records; they can cancel their own unfinished uploads.

## D-073 — Case rules in the portal (M4)

- Numbers `DS-<year>-<000001>` from the `Counter` table per year (D-009), in the creating transaction.
- Editing is allowed only in `draft` (compare-and-set on status, so a concurrent submit wins).
  Submitting (`draft → submitted`) needs at least one completed, non-infected record.
- **Status timeline** = the case's `case.create` / `case.submit` / `case.status` audit rows (their
  `metadata.to`). M6 status changes must write `case.status` with `{ from, to }` to appear.
- Staff (internal, `cases:create` at `all`) can create a case on a firm's behalf with
  `organizationId`; client users always create in their own firm.
- `GET /cases` filters by status (comma list), open, type, priority and text (matter, reference,
  number; patient names are encrypted so not searchable) with pagination, and is audited as
  `case.list` (audit L4).

## D-074 — Sharing and messages (M4)

- Shares are managed by the case's creator or by holders of `cases:edit` at `firm`/`all` (client_admin,
  staff). Someone the case is only shared with can't re-share. Targets must be active users of the
  case's firm; other ids, including other firms' users, get the same 400 `unknown_user`.
- Messages: reading and posting need `cases:view` on the case (so sales/finance are refused).
  `internalOnly` notes can only be written by staff and are never returned to client users.

## D-075 — Audit L5: encrypted case notes and messages (M4)

`Case.notes` and `Message.body` are now AES-256-GCM envelopes like `patientName`. Migration
`20261024090000_portal_phi_checks` adds CHECK constraints on all three columns (`^v[0-9]+:`), `NOT
VALID` so they apply to new writes without failing on old rows. At startup the API encrypts any legacy
plaintext rows and runs `VALIDATE CONSTRAINT` (idempotent; skipped under `NODE_ENV=test`, whose
databases are fresh). Until then legacy plaintext is still readable (`decryptOptional`).

## D-076 — Client portal UI (M4)

- `/portal/login` is outside the `(app)` route group; everything else is behind `RequireClient`
  (restores the session, staff are sent to `/console`). Besides the API's 30-minute idle limit, the
  portal signs out after 30 minutes without input so PHI isn't left on screen.
- Pages: dashboard (`GET /portal/dashboard`: open cases by status, recent deliverables, usage vs plan,
  outstanding invoices; fields the caller may not see are `null`), cases list/new/detail (details,
  timeline, records + uploader, deliverables, sharing, messages), billing (subscription + usage
  meter, change plan / cancel at period end, invoices, detail with receipts and pay by card) and firm
  (profile, MFA policy, users with suspend/reactivate, invites).
- Firm management reuses the firm-scoped `/admin/users` and `POST /invites`; new client-only
  `GET/PATCH /firm` (name, `settings.enforceMfa`) and `GET /firm/invites`. Staff organisation admin
  stays in M2. Same UI approach as the console (D-019, D-044): plain controlled forms, the API
  validates and enforces everything.

## D-077 — Test infrastructure for uploads (M4)

- API tests use the real local S3 (SeaweedFS) with per-checkout buckets (`ds-<tree>-test-*`) and
  presigned PUTs over HTTP, so multipart uploads, ListParts and downloads are exercised for real.
  CI starts a SeaweedFS container for them.
- The S3 test settings live in `apps/api/test/s3.ts`, apart from `constants.ts`: importing the latter
  from `playwright.config.ts` would fix `TEST_DATABASE_URL` before the config points it at `*_e2e`.
- `RATE_LIMIT_AUTH` / `RATE_LIMIT_PUBLIC` (defaults 30 / 10 per 15 min, as before) are now env
  settings; the E2E API uses 300 because every spec signs in from the same IP. The E2E API's stdout
  (warn level) is shown in test output.

## D-078 — Pipeline stages 3–6 as pure modules (M5b, 2026-10-24)

- `apps/worker/src/pipeline/`: `classify.ts` (stage 3), `extract-events.ts` (4), `code-events.ts`
  (5), `deliverables.ts` (6). Stages 3, 4 and 6 are pure functions; the DB/queue runner wraps them,
  so the rules are unit-tested without Postgres or Redis.
- **Classification** is weighted keyword rules per record type (header phrases 3, body words 1);
  below a score of 2 a page is `other`. Ties go to the more specific type (rule order).
- **Events**: at most one event per page (the page is the citation unit, §5.4). Service date =
  a labelled date first ("Date of service", "DOS", "Collected"…), else the first non-birth-date on
  the page; US `MM/DD/YYYY`, ISO and long-form dates. Billing pages and pages with neither a date nor
  a clinical term give no event (they still appear in the index). Undated events sort last.
- **Coding** (`CaseCoder`): every term is de-identified with the case's known identifiers (patient
  name, case number, matter, reference) before the adapters, which de-identify again. Lookups are
  memoised per case run. A failed or empty lookup leaves that term uncoded instead of failing the
  case, so one provider outage doesn't put every case on hold; the summarizer codes it by hand in M6.
  Counts (coded / uncoded / refused / failed) go on the job record, never the terms.
  `ClinicalEvent.codes` holds the CodeMatch + optional MedlinePlus definition / openFDA label, never
  the raw term (that column isn't encrypted).
- **Index** rows are runs of consecutive pages of one record type per document, with the providers
  and date range of their events. Chronology entries carry `{ documentId, fileName, pageNumber }`.

## D-079 — Text extraction with pdf.js (M5b, 2026-10-24)

- `pdfjs-dist` 5 (named in §7) via its Node `legacy` build, fonts not loaded (text only). A page
  with < 20 visible characters goes to the `OcrProvider`.
- OCR needs a page image, and rendering a PDF page in Node needs a canvas package. Rendering is an
  injected `renderPage` hook, added together with the tesseract/textract provider. Until then a
  low-text page keeps its text layer, `ocrConfidence` null, and is counted in `needsOcr` on the job,
  so scanned pages are visible rather than silently empty. Mock pipeline tests inject a renderer.
- PNG / JPEG / TIFF uploads are one page, OCR'd from the file bytes (Textract accepts multi-page
  TIFF as one file).

## D-100 — Absolute session lifetime and MFA re-check on refresh (audit M5, M10, 2026-10-24)

- Replaces D-017's "7 days sliding". A rotated session copies its family's `expiresAt`, so a sign-in
  lasts at most 7 days (§2 refresh TTL) however often it refreshes. The cookie `Max-Age` is the time
  left. No schema change: the first link's `expiresAt` already is the family deadline.
- `/auth/refresh` reloads roles and org settings. If MFA is now required (internal role granted, org
  turned on `enforceMfa`) and the user has not enrolled, the whole family is revoked (401
  `mfa_required`, audit `auth.refresh.mfa_required`). The next sign-in goes through enrolment. A
  suspended org also ends the session at refresh, as it already did per request.

## D-101 — Trust-proxy setting and per-account auth limits (audit M6, M10, 2026-10-24)

- `TRUST_PROXY` replaces the hard-coded `trust proxy 1`, which let a client that reached the API
  directly send its own `X-Forwarded-For` and get a fresh per-IP bucket on every request. Default
  `loopback`: only the local Next.js proxy (dev, e2e) is trusted. Behind a load balancer set its hop
  count or CIDRs (M10 part 3 IaC). `true` is refused at startup.
- Per-account limiter (`RATE_LIMIT_ACCOUNT`, default 10 / 15 min) on login, MFA setup/verify,
  forgot and register, keyed by SHA-256 of the normalised email (or the MFA step's user id). It counts
  every request, so it also caps reset and "sign-up attempt" mails to one inbox. Lockout (5 wrong
  secrets) still applies on top. Keys never hold an email in clear, ready for the Redis store.

## D-102 — One-time reset links and MFA step tokens (audit L2, L8, M10, 2026-10-24)

- **L2.** A successful `/auth/reset` marks every other unused `password_reset` token of the user as
  used, so an older link still in an inbox can't undo the reset. (The admin "force reset" already did
  this when issuing. There is no signed-in "change password" route yet; when one is added it must do
  the same.)
- **L8.** The MFA step token carries `at` (issue time, ms). `/auth/mfa/verify` spends it with one
  conditional update, `lastLoginAt < at` → `lastLoginAt = now`, so a replayed or raced token gives
  at most one session. No schema change. Side effect: completing a sign-in on device B voids a
  password step pending on device A (it re-enters the password). TOTP code replay within the same
  30 s step is still open (D-017 item, needs a `mfaLastStep` column); not done here, to keep this
  run free of schema changes.

## D-103 — Revoke reasons: only rotated tokens raise reuse alerts (audit L1, M10, 2026-10-24)

- New nullable `Session.revokedReason` (migration `20261024150000_session_revoked_reason`). Every
  revocation goes through `revoked(reason)` in `auth/session.ts`: `rotated`, `reuse`, `logout`,
  `revoke_all`, `idle`, `expired`, `password_reset`, `mfa_required`, `admin_action`,
  `org_suspended`, `impersonation_ended`.
- Presenting a revoked refresh token is a reuse alert (family revoked, `auth.refresh.reuse_detected`)
  only for `rotated` / `reuse`. Any other reason gives `401 session_revoked`, no alert, and other
  devices keep their sessions. Before, a tab refreshing after logout or a password reset raised a
  false theft alert, which drowns the real ones.
- Rows without a reason (from before the migration) keep the old strict rule and count as reuse.

## D-104 — Unverified sign-ups don't own an address (audit L3, M10, 2026-10-24)

- Before, anyone could register someone else's email. The owner was then told "you already have an
  account" and could never sign up. Worse, if the owner verified that pending account later, it
  went live with the squatter's password (pre-hijack).
- Now `/auth/register` on an address whose account is unverified (a self-registered client org with
  this one user) replaces the pending sign-up: new password, name and org name, older verify links
  voided, a fresh link sent. The response stays the same 202, so nothing is revealed. Verified
  accounts, invited users and multi-user orgs keep the old "sign-up attempt" mail.
- Race: register (tokens, then user `where emailVerifiedAt is null`) and verify-email (token claim +
  `emailVerifiedAt` in one transaction) take locks in the same order, so a verification that wins
  makes the replacement a no-op, and a replacement that wins voids the link being verified.
- Residual: if the owner clicks a link from a later squatter registration, they verify the
  squatter's password. They can't sign in with their own password, so they use "Forgot password",
  which ends the squatter's sessions (reset revokes all).

## D-105 — Error logs carry no values (audit L7, M10, 2026-10-24)

- Prisma error messages quote the failed call with its arguments (names, notes, emails). The API
  logged `err.message` for unhandled errors, and the shared client's `log: ['error']` printed the
  same text to stdout.
- `errorInfo(err)` in `@datascribe/db` is now the only way the API logs an error. For Prisma errors
  it keeps the name, P-code, model and constraint column names (`meta.target`), never the message.
  Other errors keep name, code and message. The shared client logs Prisma errors by target only,
  and warnings in full (they carry no query values).
- The worker should use `errorInfo` too. Its pipeline code is being written on another branch, so
  this run didn't touch it (worker code outside the pipeline logs no error messages today).

## D-106 — Constant-time compares and uniform auth timing (audit L9, M10, 2026-10-24)

- TOTP: otplib compares codes with `===`. `verifyTotp` now generates the previous, current and
  next step's code and compares each with `timingSafeEqual` (`safeEqual` in `lib/timing.ts`)
  without stopping at the first match. Other secrets are already compared by SHA-256 lookup
  (tokens) or `timingSafeEqual` (fake gateway webhook).
- Login, register and forgot hold their response until `AUTH_RESPONSE_FLOOR_MS` (default 400 ms)
  after the request started, for success and error alike (`withTimingFloor`). Existing accounts
  cost more work: the attempt reservation, a reset token, an email. Register also runs argon2 on
  every path now. The floor is the simple fix; it costs every sign-in up to 400 ms. API tests set
  it to 0 except the test that checks it. If SMTP ever takes longer than the floor, forgot would
  leak again; moving its email to the worker queue (M9) removes that.

## D-107 — Who may become a converted firm's first admin (audit L10, M10, 2026-10-24)

- Converting a lead (`crm:edit`, so sales) invites a `client_admin` (D-018). Any address was
  accepted. Now:
  - A domain used by internal-org users (Datascribe staff) is refused (400 `admin_email_domain`).
    Such a client account would look like staff in emails and the console.
  - An `adminEmail` on another domain than the lead's own email (or a lead without an email) needs
    `users:create` (ops manager, super admin). Sales gets 403 and nothing changes.
  - The `crm.lead.convert` audit entry records `adminEmailOffDomain`.
- Known limit: sales can still edit the lead's email first (the audit log records
  `crm.lead.update` with `fields: ['email']`).
  The rule stops an unnoticed one-step hand-over, not a determined insider.
