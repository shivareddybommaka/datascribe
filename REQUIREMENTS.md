# Datascribe LPO Platform - Build Specification for OpenClaw

Version 1.0 - 23 Oct 2026
Owner: Datascribe (product owner)
Audience: OpenClaw (AI coding agent) and any human developer joining the project

---

## 0. Read this first - instructions to the agent

You are building a complete web platform for Datascribe, a legal process outsourcing (LPO) company that reviews medical records for law firms and delivers medical indexes, chronologies (timelines) and summaries.

There is NO existing backend or API. Build everything in this spec: website, client portal, staff console, CRM, admin, backend API, database and processing pipeline. Where medical reference data is needed, integrate the free public APIs listed in Section 8 behind an adapter layer.

Working rules:

1. Follow the tech stack in Section 2 exactly. Do not swap frameworks or add a major dependency without writing the reason in `docs/DECISIONS.md`.
2. Build in the milestone order of Section 12. Finish each milestone's Definition of Done before starting the next.
3. Every API route must enforce permissions on the server (Section 4). Hiding a button in the UI is never enough.
4. Every row owned by a client firm carries `organizationId`. Every query for client data is scoped by it.
5. Treat all uploaded medical records as protected health information (PHI):
   - Never log document text, patient names or file contents.
   - Never send real PHI to any public or test API (Section 8.4).
   - Use only synthetic data (Synthea) in development, tests and seeds.
6. All secrets come from environment variables (Section 11). Never commit secrets. Keep `.env.example` up to date.
7. Write tests as you go (Section 13). A milestone is not done if its tests fail.
8. After each milestone, update `README.md` (how to run) and `docs/CHANGELOG.md` (what was built).
9. If something in this spec is ambiguous, choose the simplest option that satisfies it, record it in `docs/DECISIONS.md`, and continue. Stop and ask only if the choice would affect security, PHI handling, money, or the data model in a way that is hard to undo.

---

## 1. Product summary

One platform, three surfaces:

| Surface | Users | Purpose |
| --- | --- | --- |
| Marketing website | Public | Explain services, pricing, capture leads |
| Client portal | Law-firm users | Create cases, upload records, track status, download reports, pay invoices, manage subscription |
| Staff console | Datascribe staff | Process cases, review AI output, QA, CRM, finance, admin |

Core lifecycle (the spine of the system):

```
Lead captured -> Client firm onboarded -> Case created -> Records uploaded
-> Processing pipeline (extract, code, summarise) -> Staff review -> QA approval
-> Report delivered -> Usage recorded -> Invoice issued -> Payment received
```

---

## 2. Tech stack (fixed)

| Layer | Choice |
| --- | --- |
| Language | TypeScript everywhere (strict mode) |
| Monorepo | pnpm workspaces + Turborepo |
| Frontend | Next.js (App Router), Tailwind CSS, shadcn/ui, React Hook Form + Zod, TanStack Query |
| Backend API | Node.js + Express, Zod validation, OpenAPI spec generated from Zod schemas |
| Authorisation | Role/permission tables in DB + CASL for policy checks |
| Authentication | Email + password (argon2), JWT access token (15 min) + rotating refresh token (httpOnly cookie, 7 days), TOTP MFA |
| Database | PostgreSQL 16 + Prisma ORM |
| Background jobs | BullMQ on Redis |
| File storage | AWS S3 (MinIO locally), private buckets, server-side encryption, signed URLs (5 min) |
| CMS | Payload CMS (Postgres adapter) for marketing pages and blog |
| OCR | Tesseract (via `tesseract.js` or `node-tesseract-ocr`) behind an `OcrProvider` interface; AWS Textract as optional second implementation |
| PDF handling | `pdf-parse` / `pdfjs-dist` for text layer, `pdf-lib` for page splitting |
| Report generation | HTML templates -> PDF via Playwright; DOCX via `docx` package |
| Email | Nodemailer; Mailpit locally, AWS SES in production |
| Payments | Stripe (test mode) behind a `PaymentGateway` interface; leave a stub `RazorpayGateway` |
| Analytics | GA4 + GTM on marketing pages ONLY, never inside portal or console |
| Monitoring | Sentry (frontend + API), structured JSON logs with pino |
| Testing | Vitest (unit), Supertest (API), Playwright (end-to-end) |
| CI | GitHub Actions: lint, typecheck, test, build on every pull request |
| Local dev | Docker Compose: postgres, redis, minio, mailpit |
| Hosting (target) | Marketing site on Vercel; portal, console, API, workers, DB on AWS |

---

## 3. Repository structure

```
datascribe/
  apps/
    web/            # Next.js: marketing site, client portal (/portal), staff console (/console)
    api/            # Express API
    worker/         # BullMQ workers (processing pipeline, emails, billing jobs)
    cms/            # Payload CMS
  packages/
    db/             # Prisma schema, migrations, seed scripts
    shared/         # Zod schemas, types, permission definitions, constants
    medical-data/   # Adapters for external medical APIs (Section 8)
    ui/             # Shared React components
  docs/
    DECISIONS.md
    CHANGELOG.md
    API.md          # generated from OpenAPI
  docker-compose.yml
  .env.example
  README.md
```

---

## 4. Roles and permissions

### 4.1 Roles

| Key | Role | Group | Description |
| --- | --- | --- | --- |
| `super_admin` | Super Admin | Internal | Full access including roles, system settings, audit log |
| `ops_manager` | Operations Manager | Internal | Users, clients, case assignment, SLAs |
| `case_manager` | Case Manager | Internal | Owns cases end to end, assigns work, client contact |
| `summarizer` | Medical Summarizer | Internal | Works assigned cases, edits AI output |
| `qa_reviewer` | QA Reviewer | Internal | Approves or rejects deliverables |
| `sales` | Sales / CRM User | Internal | Leads, accounts, pipeline. NO medical records |
| `finance` | Finance | Internal | Invoices, payments, subscriptions. NO medical records |
| `client_admin` | Client Admin | Client | Manages own firm's users, billing, subscription; sees all firm cases |
| `client_user` | Client User | Client | Creates cases, uploads, downloads for own or shared cases |

Roles are rows in the `Role` table, seeded on first run. `super_admin` can create custom roles from the admin console by combining permissions.

### 4.2 Permission model

A permission = `module` + `action` + `scope`.

- Actions: `view`, `create`, `edit`, `delete`, `approve`, `export`, `manage`
- Scopes: `all` (every org), `firm` (user's own organization), `assigned` (records assigned to the user), `own` (records the user created)

Define all permissions as constants in `packages/shared/permissions.ts`, seed them into the DB, and build CASL abilities from the user's roles at request time.

### 4.3 Permission matrix (seed defaults)

Legend: F = full (view/create/edit/delete), E = view/create/edit, V = view, A = assigned scope, Firm = own organization only, - = none.

| Module | super_admin | ops_manager | case_manager | summarizer | qa_reviewer | sales | finance | client_admin | client_user |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cms | F | E | - | - | - | E | - | - | - |
| crm (leads, accounts, contacts, activities) | F | F | V | - | - | F | V | - | - |
| cases | F | F | F | E (A) | V (A) | - | - | F (Firm) | E (own + shared) |
| documents (medical records) | F | V | F | E (A) | V (A) | - | - | F (Firm) | E (own + shared) |
| deliverables (index, chronology, summary) | F | V | E | E (A) | approve (A) | - | - | V (Firm) | V (own + shared) |
| qa_reviews | F | V | V | - | F | - | - | - | - |
| medical_lookups (§9 code / drug lookups, D-129) | F | V | V | V | V | - | - | - | - |
| invoices and payments | F | V | - | - | - | V | F | V + pay (Firm) | - |
| subscriptions | F | V | - | - | - | V | F | manage (Firm) | - |
| users and roles | F | E (cannot touch super_admin) | - | - | - | - | - | E (Firm, client roles only) | - |
| reports and dashboards | F | F | team | own | own | pipeline | revenue | Firm | - |
| audit_log | F | V | - | - | - | - | - | - | - |
| system_settings | F | - | - | - | - | - | - | - | - |

### 4.4 Rules that are always true

- A client user can never read data from another organization. Write an automated test that tries.
- `sales` and `finance` can never read document contents or deliverables. Test it.
- Every view, download, create, edit and delete of a document or deliverable writes an `AuditLog` row.
- Super admin can impersonate a client user in read-only mode; impersonation start and end are audited and a banner is shown.

---

## 5. Modules and features

Each feature lists acceptance criteria (AC). Build to the AC.

### 5.1 Marketing website (`apps/web`, public routes)

Pages: Home, About Us, Services, AI Medical Summary, Pricing, Resources (blog), Contact.

- AC: All page content editable in Payload CMS (hero, sections, CTAs, pricing cards, blog posts).
- AC: Responsive at 375 px, 768 px, 1280 px. Lighthouse performance and SEO >= 90 on Home.
- AC: Per-page SEO fields (title, description, OG image), sitemap.xml, robots.txt.
- AC: Contact form and "Book a demo" form create a `Lead` in the CRM and email the sales inbox. Include honeypot + rate limit.
- AC: Pricing page reads plans from `SubscriptionPlan` table so prices are never duplicated.
- AC: GA4/GTM loaded only on public routes, with a cookie consent banner (decline by default for non-essential).

### 5.2 Authentication and accounts

- AC: Sign up (client firm self-registration creates `Organization` + first `client_admin`), email verification required.
- AC: Invite flow: staff or client_admin invites by email; invite link expires in 72 hours.
- AC: Login, logout, forgot/reset password, refresh-token rotation, revoke all sessions.
- AC: TOTP MFA mandatory for all internal roles, optional for client roles (org setting can enforce).
- AC: Lockout after 5 failed logins for 15 minutes. Login rate limit per IP.
- AC: Idle timeout 15 minutes in staff console, 30 minutes in client portal.

### 5.3 Client portal (`/portal`)

- AC: Dashboard: open cases by status, recent deliverables, usage this period vs plan limit, outstanding invoices.
- AC: Create case: matter name, case reference, patient/plaintiff name, date of incident, case type (personal injury, med-mal, workers comp, other), requested deliverables (index, chronology, summary), priority, due date, notes.
- AC: Upload records: drag and drop, multiple PDFs/images/TIFF, max 500 MB per file, resumable (S3 multipart), progress bar, virus scan (ClamAV container) before processing.
- AC: Case detail: status timeline, documents list, deliverables with preview and download (PDF and DOCX), message thread with Datascribe staff.
- AC: Share a case with other users in the same firm.
- AC: Billing: invoices list, invoice detail, pay by card (Stripe Checkout), receipts, billing history.
- AC: Subscription: current plan, usage meter (pages processed), upgrade, downgrade, cancel at period end.
- AC: client_admin: manage firm users and their roles, firm profile, MFA policy.

### 5.4 Case processing (staff console `/console/cases`)

Statuses: `draft -> submitted -> processing -> in_review -> qa -> changes_requested -> approved -> delivered -> closed` (plus `on_hold`, `cancelled`).

- AC: Case queue with filters (status, client, assignee, due date, priority) and SLA flags (due in < 24 h amber, overdue red).
- AC: case_manager assigns summarizer and qa_reviewer; ops_manager can reassign anything.
- AC: Workspace view: document viewer (PDF with page thumbnails) on the left, extracted data and draft deliverable on the right; clicking a chronology entry jumps to the source page.
- AC: Summarizer can edit every chronology entry, index row and summary paragraph. Each edit is versioned.
- AC: Every chronology entry keeps a source citation: document id + page number. Entries without a citation cannot be approved.
- AC: Submit for QA -> qa_reviewer approves or requests changes with comments. Approval locks the version.
- AC: On approval, generate the final report (PDF + DOCX) from templates, store in S3, notify client, set status `delivered`, record usage.

### 5.5 CRM (`/console/crm`)

- AC: Leads: create (manual or from website form), source, owner, stage (`new -> contacted -> qualified -> proposal -> won / lost`), estimated value, next follow-up date.
- AC: Kanban pipeline view and table view with filters.
- AC: Accounts (= client organizations) and Contacts linked to them.
- AC: Activities: call, email, meeting, note, task with due date; "My tasks today" widget.
- AC: Convert lead to client: creates `Organization` + invites first `client_admin`, keeps history.
- AC: Lost reason required when a lead is marked lost.
- AC: CSV import and export of leads and contacts.

### 5.6 Billing and subscriptions

- AC: Plans managed by finance/super_admin: name, monthly price, currency, included pages per month, overage price per page, features.
- AC: Usage recorded per case on delivery (pages processed). Monthly job creates invoices: plan fee + overage.
- AC: One-off invoices can be created manually by finance.
- AC: Stripe integration via `PaymentGateway` interface: checkout session, webhook handling (idempotent), refunds by finance.
- AC: Invoice PDF with company details, tax line (GST/sales tax configurable), sequential invoice numbers.
- AC: Dunning: reminder emails at due date, +7 days, +14 days.

### 5.7 Admin console (`/console/admin`)

- AC: Users: list, create, invite, suspend, reactivate, reset MFA, force password reset.
- AC: Roles: list, create custom role, edit permissions with a checkbox matrix (module x action x scope). System roles cannot be deleted.
- AC: Organizations: list, view, edit plan, set custom pricing, suspend.
- AC: Settings: company details, invoice settings, SLA defaults, email templates (editable with variables), notification rules, medical data provider config (Section 8).
- AC: Audit log viewer: filter by user, action, entity, date; export CSV.
- AC: Impersonation (Section 4.4).

### 5.8 Notifications

Email + in-app bell. Events: case submitted, processing complete, assigned to you, QA changes requested, approved, delivered, invoice issued, payment received, payment failed, lead assigned, task due.

- AC: Users can mute non-critical email notifications. Security emails cannot be muted.

### 5.9 Dashboards and reports

- Ops: cases by status, average turnaround, overdue cases, workload per summarizer.
- Sales: pipeline value by stage, conversion rate, leads by source.
- Finance: MRR, invoices outstanding, revenue by client.
- Client: cases, pages processed, spend.

---

## 6. Data model (Prisma)

Create these models. Field lists are minimums; add `createdAt`, `updatedAt` to all, and `organizationId` where noted.

| Model | Key fields | Notes |
| --- | --- | --- |
| Organization | id, name, type (`client` / `internal`), status, planId, settings JSON | |
| User | id, organizationId, name, email (unique), passwordHash, mfaSecret, mfaEnabled, status, lastLoginAt | |
| Role | id, key, name, description, isSystem | |
| Permission | id, module, action, scope | |
| RolePermission | roleId, permissionId | |
| UserRole | userId, roleId | |
| Session | id, userId, refreshTokenHash, expiresAt, revokedAt, ip, userAgent | |
| Invite | id, organizationId, email, roleId, tokenHash, expiresAt, acceptedAt | |
| Lead | id, source, companyName, contactName, email, phone, stage, ownerId, value, nextFollowUpAt, lostReason, convertedOrgId | |
| Contact | id, organizationId?, leadId?, name, title, email, phone | |
| Activity | id, type, subject, body, dueAt, doneAt, userId, leadId?, organizationId? | |
| Case | id, organizationId, number, matterName, reference, patientName (encrypted), incidentDate, caseType, requested JSON, priority, dueAt, status, createdById, caseManagerId, summarizerId, qaReviewerId | |
| CaseShare | caseId, userId | |
| Document | id, organizationId, caseId, fileName, s3Key, mimeType, sizeBytes, pageCount, sha256, scanStatus, uploadedById | |
| DocumentPage | id, documentId, pageNumber, text (encrypted), ocrConfidence | |
| ProcessingJob | id, caseId, stage, status, attempts, error, startedAt, finishedAt | |
| ClinicalEvent | id, caseId, documentId, pageNumber, eventDate, provider, facility, eventType, description, codes JSON, editedById | one row per chronology entry |
| Deliverable | id, caseId, type (`index` / `chronology` / `summary` / `report`), version, status, content JSON, pdfS3Key, docxS3Key | |
| QaReview | id, deliverableId, reviewerId, result, comments | |
| Message | id, caseId, authorId, body, internalOnly | |
| SubscriptionPlan | id, name, priceMonthly, currency, includedPages, overagePerPage, features JSON, active | |
| Subscription | id, organizationId, planId, status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, gatewayRef | |
| UsageRecord | id, organizationId, caseId, metric, quantity, periodStart | |
| Invoice | id, organizationId, number, status, subtotal, tax, total, currency, dueAt, paidAt, pdfS3Key | |
| InvoiceLine | id, invoiceId, description, quantity, unitPrice, amount | |
| Payment | id, invoiceId, gateway, gatewayRef, amount, status, receiptUrl | |
| Notification | id, userId, type, payload JSON, readAt | |
| AuditLog | id, actorId, impersonatorId?, organizationId?, action, entity, entityId, ip, userAgent, metadata JSON, createdAt | append-only; no update/delete in code |
| MedicalApiCache | id, provider, requestHash, response JSON, expiresAt | Section 8 |
| Setting | key, value JSON | |

Encrypt `patientName`, `DocumentPage.text` and deliverable content at the application level (AES-256-GCM, key from env / AWS KMS).

---

## 7. Processing pipeline (`apps/worker`)

Each stage is a BullMQ job. On success it enqueues the next. Retries: 3 with exponential backoff. Failures set the case to `on_hold` and notify the case manager.

1. **Scan** - ClamAV scan of the uploaded file. Infected -> quarantine, notify, stop.
2. **Split and extract text** - read text layer per page with pdf.js. If a page has < 20 characters of text, send it to OCR (`OcrProvider`). Store `DocumentPage` rows with confidence.
3. **Classify pages** - detect record type per page (office visit, ER, imaging, lab, operative report, therapy, pharmacy, billing, other) with keyword rules first; LLM classification optional (Section 8.3).
4. **Extract clinical events** - pull dates of service, provider, facility, diagnoses, procedures, medications, vitals. Rules + regex first, LLM optional. Each event keeps document id + page number.
5. **Normalise and code** - send extracted terms to the medical data adapters (Section 8): diagnoses -> ICD-10-CM, medications -> RxNorm, add drug label info from openFDA, add plain-language definitions from MedlinePlus. Store codes in `ClinicalEvent.codes`.
6. **Build deliverables**
   - Index: table of documents with page ranges, provider, date range, record type.
   - Chronology: events sorted by date, each with citation.
   - Summary: narrative by body system / injury, treatment course, gaps in treatment, pre-existing conditions. Generated by the `SummaryProvider` (Section 8.3).
7. **Ready for review** - set case `in_review`, notify assigned summarizer.

The pipeline must work end to end with the `mock` providers and no network access, so development and CI never depend on third parties.

---

## 8. Medical data integration (free public APIs)

### 8.1 Instruction

There is no existing medical API. Integrate free, publicly available medical reference APIs for coding, normalisation and definitions. Wrap each one in an adapter inside `packages/medical-data` so any provider can be swapped later for a paid or self-hosted one without touching business logic.

Before implementing each adapter:

- Confirm the current endpoint, rate limits, terms of use and attribution requirements on the provider's official documentation page. Record what you found (URL + date) in `docs/DECISIONS.md`.
- If a provider has been discontinued or changed, pick the closest free alternative and record why.

### 8.2 Providers to integrate

| Purpose | Provider | Base URL (verify) | Key needed | Adapter interface |
| --- | --- | --- | --- | --- |
| Diagnosis search and ICD-10-CM codes | NLM Clinical Table Search Service | `https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search` | No | `DiagnosisCoder` |
| Procedure / condition lookups | NLM Clinical Table Search Service (other tables, e.g. conditions, HCPCS) | `https://clinicaltables.nlm.nih.gov/api/` | No | `ProcedureCoder` |
| Medication normalisation (RxCUI, ingredients, brand/generic) | NLM RxNav / RxNorm API | `https://rxnav.nlm.nih.gov/REST/` | No | `MedicationNormalizer` |
| Drug label info (indications, warnings) | openFDA Drug Label API | `https://api.fda.gov/drug/label.json` | Optional (higher limits) | `DrugInfoProvider` |
| Plain-language definitions for summaries | MedlinePlus Connect | `https://connect.medlineplus.gov/service` | No | `ConsumerHealthInfo` |
| Synthetic test patients and records | Synthea (generate locally) | `github.com/synthetichealth/synthea` | No | used by seed scripts only |
| FHIR shape testing (optional) | HAPI FHIR public test server | `https://hapi.fhir.org/baseR4` | No | test-only, synthetic data only |

Optional later (needs free registration or license, do not block on these): UMLS / SNOMED CT via NLM UTS API key, LOINC for lab codes.

### 8.3 Interfaces

```ts
// packages/medical-data/src/types.ts
export interface CodeMatch { system: 'ICD10CM' | 'RXNORM' | 'HCPCS' | 'SNOMED'; code: string; display: string; score?: number; source: string }

export interface DiagnosisCoder { search(term: string, limit?: number): Promise<CodeMatch[]> }
export interface ProcedureCoder { search(term: string, limit?: number): Promise<CodeMatch[]> }
export interface MedicationNormalizer { normalize(name: string): Promise<CodeMatch[]> }
export interface DrugInfoProvider { getLabel(rxcuiOrName: string): Promise<{ indications?: string; warnings?: string; source: string } | null> }
export interface ConsumerHealthInfo { define(code: CodeMatch): Promise<{ title: string; summary: string; url: string } | null> }

export interface OcrProvider { recognize(image: Buffer): Promise<{ text: string; confidence: number }> }
export interface SummaryProvider { summarize(input: SummaryInput): Promise<SummaryOutput> }
```

Implementations per interface: `nlm`, `openfda`, `medlineplus` (real), plus `mock` (deterministic fixtures) for every interface. Select via env (`MEDICAL_DATA_PROVIDER=nlm|mock`, `SUMMARY_PROVIDER=mock|anthropic|openai`, `OCR_PROVIDER=tesseract|textract|mock`).

Summaries: the free APIs above provide codes and definitions, not narrative summaries. Implement `SummaryProvider` with `mock` as default and an LLM implementation behind config. The LLM provider must only be enabled in production after Datascribe confirms a signed business associate agreement (BAA) with that vendor; add a startup check that refuses to start with a real LLM provider in production unless `PHI_LLM_BAA_CONFIRMED=true`.

### 8.4 Rules for every adapter

- Send only short clinical terms (for example "lumbar radiculopathy", "gabapentin 300 mg") to public APIs. Never send patient names, dates of birth, case numbers, addresses or full document text.
- Strip identifiers with a `deidentifyTerm()` helper before any external call, and unit-test it.
- Cache responses in `MedicalApiCache` (default 30 days) keyed by provider + normalised request.
- Rate limit per provider (token bucket, configurable), timeout 10 s, 3 retries with backoff, circuit breaker that falls back to "uncoded" rather than failing the case.
- Log provider name, latency and status only, never the term itself in production logs.
- Show source attribution (for example "Source: NLM RxNorm") in the staff workspace and in report footers where required by terms.
- Admin settings page lets super_admin enable/disable each provider and see last-24h call counts and error rates.

---

## 9. API outline (`apps/api`, prefix `/api/v1`)

Group routes by module. Every route: Zod input validation, CASL check, org scoping, audit where Section 4.4 requires.

```
auth:          POST /auth/register | /auth/login | /auth/refresh | /auth/logout | /auth/forgot | /auth/reset | /auth/mfa/setup | /auth/mfa/verify | /invites/:token/accept
users:         GET/POST /users | GET/PATCH /users/:id | POST /users/:id/suspend | /users/:id/reset-mfa
roles:         GET/POST /roles | PATCH/DELETE /roles/:id | GET /permissions
orgs:          GET/POST /organizations | GET/PATCH /organizations/:id
crm:           /leads | /leads/:id/convert | /contacts | /activities | /pipeline/summary | /leads/import | /leads/export
cases:         GET/POST /cases | GET/PATCH /cases/:id | POST /cases/:id/submit | /cases/:id/assign | /cases/:id/status | /cases/:id/share | /cases/:id/messages
documents:     POST /cases/:id/uploads (presign multipart) | POST /uploads/:id/complete | GET /documents/:id/pages/:n | GET /documents/:id/download-url
deliverables:  GET /cases/:id/deliverables | PATCH /deliverables/:id | POST /deliverables/:id/submit-qa | POST /deliverables/:id/qa | GET /deliverables/:id/download-url
events:        GET/PATCH /cases/:id/clinical-events
medical:       GET /medical/icd10?q= | /medical/rxnorm?q= | /medical/drug-label?q= | /medical/define?code=   (staff only, used for manual coding)
billing:       /plans | /subscriptions/current | /subscriptions/change | /invoices | /invoices/:id/pay | /payments/webhook/stripe
notifications: GET /notifications | POST /notifications/:id/read
admin:         /settings | /audit-logs | /impersonate/:userId | /impersonate/stop | /email-templates
reports:       /dashboards/ops | /dashboards/sales | /dashboards/finance | /dashboards/client
```

---

## 10. Non-functional requirements

- Security: OWASP ASVS level 2 as the target; helmet, CSRF protection for cookie routes, strict CORS, parameterised queries only (Prisma), file type validation by magic bytes, upload size limits, rate limiting on auth and public forms.
- Encryption: TLS everywhere; S3 SSE-KMS; RDS encryption; app-level encryption for PHI fields (Section 6).
- Privacy: designed for HIPAA (US clients) and India's DPDP Act. Data retention setting per organization (default: delete source documents 180 days after case closed; deliverables kept). Hard deletes run as audited jobs.
- Performance: API p95 < 300 ms for non-processing routes; a 300-page PDF fully processed (with mock summary) in < 10 minutes on one worker.
- Accessibility: WCAG 2.1 AA for portal and website.
- Backups: daily DB snapshots, 30-day retention; S3 versioning on document buckets.
- Observability: request id on every log line; Sentry with PHI scrubbing (`beforeSend` strips request bodies).

---

## 11. Environment variables (`.env.example`)

```
NODE_ENV=development
APP_URL=http://localhost:3000
API_URL=http://localhost:4000
DATABASE_URL=postgresql://datascribe:datascribe@localhost:5432/datascribe
REDIS_URL=redis://localhost:6379
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=
PHI_ENCRYPTION_KEY=            # 32-byte base64, or use KMS in production
S3_ENDPOINT=http://localhost:9000
S3_REGION=ap-south-1
S3_BUCKET_DOCUMENTS=ds-documents
S3_BUCKET_DELIVERABLES=ds-deliverables
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
SMTP_HOST=localhost
SMTP_PORT=1025
MAIL_FROM=no-reply@datascribe.example
STRIPE_SECRET_KEY=             # test mode key only in dev
STRIPE_WEBHOOK_SECRET=
PAYMENT_GATEWAY=stripe
MEDICAL_DATA_PROVIDER=mock     # nlm | mock
OPENFDA_API_KEY=               # optional
NLM_UTS_API_KEY=               # optional, later
OCR_PROVIDER=tesseract         # tesseract | textract | mock
SUMMARY_PROVIDER=mock          # mock | anthropic | openai
LLM_API_KEY=
PHI_LLM_BAA_CONFIRMED=false
SENTRY_DSN=
GA4_MEASUREMENT_ID=
GTM_ID=
PAYLOAD_SECRET=
```

---

## 12. Build order (milestones)

Each milestone ends with: all tests green, README updated, demo script in `docs/demos/M<n>.md` describing how to see the feature working.

| # | Milestone | Scope | Definition of done |
| --- | --- | --- | --- |
| M0 | Foundation | Monorepo, Docker Compose, Prisma schema (all models), seed (roles, permissions, plans, 1 internal org, 2 client orgs, 1 user per role, 3 Synthea cases), CI pipeline, lint/format | `pnpm dev` starts everything; CI green; seed users can log in |
| M1 | Auth + RBAC | Section 5.2, permission engine, org scoping middleware, audit logging middleware | Cross-org access test and sales/finance PHI test pass |
| M2 | Admin console | Section 5.7 (users, roles matrix, orgs, settings, audit viewer, impersonation) | Super admin can create a custom role and it takes effect without restart |
| M3 | Marketing website + CMS | Section 5.1 | All 7 pages editable in CMS; contact form creates a lead |
| M4 | Client portal: cases and uploads | Section 5.3 (cases, uploads, sharing, messages) | Client uploads a 300-page synthetic PDF with resumable upload |
| M5 | Processing pipeline + medical data adapters | Sections 7 and 8 with `mock` providers, then `nlm`, `openfda`, `medlineplus` adapters | Synthetic case goes from upload to `in_review` with coded chronology entries and citations |
| M6 | Staff workspace + QA + delivery | Section 5.4 | Summarizer edits, QA approves, client downloads PDF + DOCX report |
| M7 | CRM | Section 5.5 | Lead from website form converted to a client org with invited admin |
| M8 | Billing + subscriptions | Section 5.6 with Stripe test mode | Monthly invoice with overage generated and paid via Stripe test card |
| M9 | Notifications + dashboards | Sections 5.8, 5.9 | All listed events send email + in-app notification |
| M10 | Hardening + launch prep | Section 10, Playwright suite, load test, security review checklist, deployment IaC (Terraform or AWS CDK) | Full E2E suite green; staging deploy from CI |

---

## 13. Testing requirements

- Unit tests for permission rules: for every role, a table-driven test of allowed and denied actions from Section 4.3.
- API tests for org isolation on every client-data route (generated from the route list).
- Adapter tests: recorded fixtures for each real provider (no live calls in CI); one optional live smoke test per provider behind `RUN_LIVE_API_TESTS=true`.
- `deidentifyTerm()` tests with names, dates, MRNs, phone numbers, addresses.
- Pipeline test: Synthea-generated PDF -> deliverables, asserting every chronology entry has a page citation.
- Playwright E2E journeys: sign up firm -> create case -> upload -> (worker) -> staff review -> QA approve -> client download -> invoice -> pay; lead capture -> convert.
- Coverage target: 80% lines on `apps/api` and `packages/shared`.

---

## 14. Defaults chosen for open decisions

Datascribe has not confirmed these yet. Build with these defaults and keep them configurable.

| Decision | Default |
| --- | --- |
| Client market | Both US and India; currency per organization (USD default) |
| Payment gateway | Stripe; Razorpay stub behind the same interface |
| Client onboarding | Both self-registration and staff invite |
| CRM | Built in (no HubSpot/Zoho sync in v1) |
| LLM for summaries | `mock` until a BAA-covered vendor is chosen |
| Hosting region | AWS ap-south-1, configurable |
| Branding | Placeholder logo and neutral palette as Tailwind theme tokens, easy to replace |

## 15. Out of scope for v1

- Mobile apps
- Email inbox sync in CRM
- E-signature
- Direct EHR integrations (Epic, Cerner) or HIE connections
- Multi-language UI
