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

## D-013 — Money and encrypted fields

Money is `Decimal(12,2)` (per-page prices `Decimal(12,4)`). Encrypted PHI fields (`Case.patientName`,
`DocumentPage.text`, `ClinicalEvent.description`, `Deliverable.content`, `User.mfaSecret`) are `String`
columns holding a versioned AES-256-GCM envelope `v1:iv:tag:ct`. `Deliverable.content` is encrypted JSON,
so it's stored as text rather than `Json`. `ClinicalEvent.description` is encrypted too; the spec doesn't
list it, but it is clinical narrative about the patient.
