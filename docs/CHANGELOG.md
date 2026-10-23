# Changelog

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
