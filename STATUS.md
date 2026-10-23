# Datascribe — STATUS

## Current state (2026-10-23)

- **Build order: M0 → M1 → M7 (CRM first)**, Shiva's decision (D-016).
- **M0 Foundation: done locally.** Remote: https://github.com/shivareddybommaka/datascribe (private,
  push via deploy key, host alias `github-datascribe`). First GitHub CI run still needs Shiva to confirm.
  - Infra on Colima: Postgres 16 (:5433, confirmed; :5432 is the existing CRM, never touch),
    Redis 7, SeaweedFS S3 (:9000), Mailpit (:8025).
- **M1 Auth + RBAC: code written, NOT yet verified or committed.**
  - Written: register/verify-email, login + lockout, TOTP MFA (mandatory internal), refresh rotation with
    reuse detection, logout / revoke-all, forgot/reset, idle timeouts, invites, permission + org-scoping
    middleware, audit middleware, read-only case/document/deliverable routes, GET /permissions.
  - Tests written: `apps/api/test/auth.test.ts`, `rbac.test.ts` (cross-org isolation over the route list,
    sales/finance PHI refusal, scopes, audit, invites), using a `datascribe_test` DB on 5433.
  - Migration `m1_auth` applied to the dev DB on 5433.
  - Blocked: the OpenClaw exec tool fails with `missing scope: operator.approvals`, so typecheck,
    tests, format and commit can't run yet.

## Waiting on Shiva

- Restore exec for the Datascribe agent (missing scope `operator.approvals`).
- Confirm the first CI run on GitHub Actions is green.

## Next steps

- When exec works: typecheck → fix → run tests (creates `datascribe_test`) → format → commit → push.
- Then M7 CRM: leads/pipeline/accounts/contacts/activities, convert-to-client (reuses `createInvite`),
  CSV import/export, public lead endpoint, console CRM UI with login.
