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

The dev machine already runs an unrelated Postgres on 5432. Compose maps its port from `POSTGRES_PORT`
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

## D-013 — Money and encrypted fields

Money is `Decimal(12,2)` (per-page prices `Decimal(12,4)`). Encrypted PHI fields (`Case.patientName`,
`DocumentPage.text`, `ClinicalEvent.description`, `Deliverable.content`, `User.mfaSecret`) are `String`
columns holding a versioned AES-256-GCM envelope `v1:iv:tag:ct`. `Deliverable.content` is encrypted JSON,
so it's stored as text rather than `Json`. `ClinicalEvent.description` is encrypted too; the spec doesn't
list it, but it is clinical narrative about the patient.
