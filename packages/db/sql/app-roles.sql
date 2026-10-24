-- Audit L11 (D-110): least-privilege database roles. NOT a Prisma migration and never run
-- automatically. An operator runs it once per environment as a superuser / RDS master user:
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v db=datascribe \
--     -v app_password="$APP_PW" -v migrator_password="$MIGRATOR_PW" -f packages/db/sql/app-roles.sql
--
-- Roles:
--   datascribe_owner     NOLOGIN. Owns the schema and every table. Nobody signs in as it.
--   datascribe_migrator  LOGIN, member of the owner role. Runs `prisma migrate deploy` (CI/CD only).
--   datascribe_app       LOGIN. What the API and worker use: read/write rows, no DDL, no TRUNCATE,
--                        and AuditLog is append-only (INSERT + SELECT).
-- Safe to re-run: CREATE ROLE is guarded, GRANT/REVOKE are idempotent, passwords are reset.

\set ON_ERROR_STOP on

SELECT 'CREATE ROLE datascribe_owner NOLOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'datascribe_owner') \gexec
SELECT 'CREATE ROLE datascribe_migrator LOGIN IN ROLE datascribe_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'datascribe_migrator') \gexec
SELECT 'CREATE ROLE datascribe_app LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'datascribe_app') \gexec

ALTER ROLE datascribe_migrator PASSWORD :'migrator_password';
-- every object a migration creates is owned by the owner role (and gets the default grants below)
ALTER ROLE datascribe_migrator SET role = 'datascribe_owner';
ALTER ROLE datascribe_app PASSWORD :'app_password';
-- the app role never creates databases or roles
ALTER ROLE datascribe_app NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- The database and schema belong to the owner; PUBLIC loses its default rights on both.
ALTER DATABASE :"db" OWNER TO datascribe_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db" TO datascribe_migrator, datascribe_app;

\connect :"db"

ALTER SCHEMA public OWNER TO datascribe_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO datascribe_app;

-- Existing objects (created by whoever ran the first migrations) move to the owner role.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO datascribe_owner', r.tablename);
  END LOOP;
  FOR r IN SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO datascribe_owner', r.sequence_name);
  END LOOP;
  FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'public' AND t.typtype = 'e' LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO datascribe_owner', r.typname);
  END LOOP;
END $$;

-- Row access for the app on every current table ...
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO datascribe_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO datascribe_app;
-- ... and on every table a future migration creates (migrations run as the owner role).
ALTER DEFAULT PRIVILEGES FOR ROLE datascribe_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO datascribe_app;
ALTER DEFAULT PRIVILEGES FOR ROLE datascribe_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO datascribe_app;

-- The audit trail is append-only for the application (§4.4): it can add and read entries only.
REVOKE UPDATE, DELETE, TRUNCATE ON public."AuditLog" FROM datascribe_app;
-- Prisma's own bookkeeping is for the migrator only.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON public."_prisma_migrations" FROM datascribe_app;
  END IF;
END $$;
