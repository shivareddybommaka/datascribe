# apps/cms — Payload CMS

Payload 3 in its own small Next.js app (D-030). Serves the admin UI at `/admin` and the REST API that
`apps/web` reads server-side (`apps/web/lib/cms.ts`). GraphQL is off.

- Database: its own Postgres database (`CMS_DATABASE_URL`, port **5433**), separate from the platform
  DB so CMS editors and content never sit next to PHI. Schema changes go through migrations
  (`src/migrations`, `push: false`).
- Content: `pages` (the 7 marketing pages: hero, sections, CTAs, pricing card copy, contact form copy,
  SEO), `posts` (Resources blog), `media` (uploads, `apps/cms/media/` locally), `users` (CMS editors,
  separate from platform users) and the `site` global (nav, header CTA, footer, cookie banner).
- Drafts: anonymous reads see published documents only.
- Types for content shared with the web app live in `packages/site-content`, together with the
  default copy that the seed writes and the web app falls back to if the CMS is unreachable.

## Commands (account `nova`, repo root)

```
pnpm --filter @datascribe/cms migrate
```

```
pnpm --filter @datascribe/cms seed
```

```
pnpm --filter @datascribe/cms dev
```

`seed` only creates missing documents; add `-- --force` to reset everything to the defaults. The first
visit to `http://localhost:3001/admin` asks for the first CMS admin account. After changing a
collection: `generate:types`, `generate:importmap` and `migrate:create`.
