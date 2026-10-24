# Database roles (audit L11, D-110)

Today the API, worker and migrations all connect as `datascribe`, which owns the schema. A bug or
an injection in the app could then drop tables or rewrite the audit trail. The fix is three roles,
created by [`packages/db/sql/app-roles.sql`](../packages/db/sql/app-roles.sql).

| Role                  | Login | Used by                               | Can                                                                      |
| --------------------- | ----- | ------------------------------------- | ------------------------------------------------------------------------ |
| `datascribe_owner`    | no    | nobody (owns schema, tables, enums)   | everything on its objects                                                |
| `datascribe_migrator` | yes   | `prisma migrate deploy` in CI/CD only | DDL; logs in as owner (`SET role`), so new tables get the default grants |
| `datascribe_app`      | yes   | API and worker (`DATABASE_URL`)       | `SELECT/INSERT/UPDATE/DELETE` on tables; `AuditLog` is INSERT + SELECT   |

The app role cannot `CREATE`, `ALTER`, `DROP` or `TRUNCATE`, cannot update or delete audit
entries, and cannot read `_prisma_migrations`. Tables added by later migrations get the same grants
automatically (`ALTER DEFAULT PRIVILEGES FOR ROLE datascribe_owner`).

## Applying it (staging / production)

The script is not a Prisma migration and does not run by itself. It needs a superuser or the RDS
master user. On RDS, first make the master a member of the owner role
(`GRANT datascribe_owner TO <master>`) after the first run creates it, or the ownership changes
fail; then run the script again.

1. Generate two passwords and store them in the secrets manager (never in git or chat).
2. Before switching, start the API once with the current owner connection, so the L5 backfill's
   `ALTER TABLE … VALIDATE CONSTRAINT` (an owner-only statement) has run. Check:
   `SELECT conname FROM pg_constraint WHERE contype = 'c' AND NOT convalidated;` returns no rows.
3. Run the script as the admin user:

   ```
   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v db=datascribe -v app_password="$APP_PW" -v migrator_password="$MIGRATOR_PW" -f packages/db/sql/app-roles.sql
   ```

4. Point the services at the new roles: `DATABASE_URL` for API and worker → `datascribe_app`;
   the deploy job's `prisma migrate deploy` → `datascribe_migrator`.
5. Smoke test: sign in, open a case, check a new audit entry appears.

Re-running the script is safe (it resets the two passwords to the values given).

## Local development and tests

Not switched. The dev stack and the `_test` / `_e2e` databases keep the single owner role,
because the test setup drops and recreates the schema. This change is for staging and production
(M10 part 3, IaC). Do not run the script against the shared Docker Postgres on 5433: roles are
cluster-wide and would affect every worktree.

## The CMS database

Payload (`CMS_DATABASE_URL`, D-030) has its own database. Give it its own owner/app pair the same
way when the CMS is deployed; not covered by this script.

## How the script was checked (2026-10-24)

In a throwaway `postgres:16-alpine` container (not the shared one): all migrations applied as an
admin, script applied, then as `datascribe_app`: select/insert/update on business tables and
insert/select on `AuditLog` allowed; update/delete on `AuditLog`, `TRUNCATE`, `CREATE TABLE`,
`ALTER TABLE` and `DROP TABLE` denied (42501). A table created by `datascribe_migrator` was owned by
`datascribe_owner` and usable by the app. A second run of the script succeeded.
