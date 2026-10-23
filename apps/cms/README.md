# apps/cms — Payload CMS

Placeholder until M3 (marketing website + CMS). See `docs/DECISIONS.md` D-003.

Payload 3 runs inside a Next.js app, so this will be its own small Next app using the Postgres adapter
(separate `payload` schema in the same database), serving the admin UI and a REST/GraphQL API that
`apps/web` reads at build/request time.
