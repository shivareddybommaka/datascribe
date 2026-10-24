# Load test

The M10 load test (§12) measures the API's read routes under a few concurrency levels and checks
that the auth rate limits answer 429. It uses [autocannon](https://github.com/mcollina/autocannon)
(D-114). It is a manual tool: not part of `turbo test`, not run in CI
(`apps/api/test/load-stats.test.ts` checks this).

## What it does

1. Refuses any target other than `localhost` / `127.0.0.1` / `[::1]`, and port 3000.
2. Signs in once as a seeded synthetic user (default `client.admin@acme.example`, password
   `SEED_USER_PASSWORD`) and picks the first case that user sees.
3. For each route and each concurrency level, runs autocannon for a fixed time with the access
   token as a Bearer header:
   `GET /health`, `GET /auth/me`, `GET /cases`, `GET /cases/:id`, `GET /cases/:id/documents`.
4. Probes the rate-limited auth routes one request at a time, past each limit:
   - `POST /auth/login` for one unknown synthetic address (per-account limit, `RATE_LIMIT_ACCOUNT`),
   - `POST /auth/refresh` with the rotated cookie each time (per-IP `auth` limit, `RATE_LIMIT_AUTH`,
     shared with the sign-ins above),
   - `POST /auth/forgot` with a new unknown address each time (per-IP public limit,
     `RATE_LIMIT_PUBLIC`). Unknown addresses send no email.
     Then it logs the session out.
5. Prints p50 / p95 / p99 latency, requests, requests per second, non-2xx and connection error
   counts, and for each probe the status counts, where the first 429 came and its
   `RateLimit-Policy` header. It never prints response bodies, tokens or the password. It exits
   non-zero if any throughput run saw a non-2xx or error, or a probe never got a 429.

Refresh is not run under concurrency on purpose: refresh tokens rotate, and two requests with the
same token are treated as token theft (audit M1), and the route is limited to 30 per 15 min per IP.
Its latency comes from the sequential probe.

## How to run it

Needs Postgres, Redis and a seeded database (`pnpm db:seed`). Account `nova`, from the checkout:

```sh
pnpm --filter @datascribe/api exec tsx --env-file-if-exists=../../.env src/server.ts
```

In a second terminal (account `nova`):

```sh
pnpm load
```

Optional env: `LOAD_DURATION` (seconds per run, default 10), `LOAD_CONNECTIONS` (default
`1,10,50`), `LOAD_API_URL` (default `http://localhost:$API_PORT`), `LOAD_EMAIL`, `LOAD_PASSWORD`.
Set `LOG_LEVEL=warn` on the API so it doesn't log every request.

Things to know:

- After a run, the auth limits are used up for this machine's IP for 15 minutes (that is the
  point). To run again sooner, restart the API with another `REDIS_KEY_PREFIX` (fresh counters in
  Redis, nothing is switched off).
- Case list, case detail and document list write an audit row per request (§4.4, audit L4), so
  the run below added about 80,000 `AuditLog` rows to the dev database. Use a dev database only, never one with real data.

## Local results (2026-10-24)

**This is a laptop, not production sizing.** Apple M5 Max (18 cores, 36 GB), macOS 27. API: one
Node 26 process via `tsx` (`NODE_ENV=development`, `LOG_LEVEL=warn`) on the host. Postgres 16 and
Redis in Colima (4 vCPU, 6 GB). autocannon on the same machine. Seed data: 3 synthetic cases.
10 s per run.

| route                    | conns | requests | req/s | p50 ms | p95 ms | p99 ms | non-2xx | errors |
| ------------------------ | ----: | -------: | ----: | -----: | -----: | -----: | ------: | -----: |
| GET /health              |     1 |   146240 | 14624 |    0.1 |    0.1 |    0.2 |       0 |      0 |
| GET /health              |    10 |   410376 | 41038 |    0.2 |    0.5 |    0.6 |       0 |      0 |
| GET /health              |    50 |   400733 | 40073 |    1.3 |    1.9 |    2.8 |       0 |      0 |
| GET /auth/me             |     1 |     3138 |   314 |    3.5 |    3.7 |    4.1 |       0 |      0 |
| GET /auth/me             |    10 |    15468 |  1547 |    6.3 |    8.0 |   11.5 |       0 |      0 |
| GET /auth/me             |    50 |    25590 |  2559 |   17.4 |   29.2 |   52.0 |       0 |      0 |
| GET /cases               |     1 |     1874 |   187 |    5.2 |    6.2 |    7.3 |       0 |      0 |
| GET /cases               |    10 |    11689 |  1169 |    8.5 |    9.9 |   10.7 |       0 |      0 |
| GET /cases               |    50 |    19857 |  1986 |   23.9 |   34.9 |   38.6 |       0 |      0 |
| GET /cases/:id           |     1 |     1284 |   128 |    7.3 |   11.0 |   14.2 |       0 |      0 |
| GET /cases/:id           |    10 |     7308 |   731 |   13.5 |   17.0 |   19.0 |       0 |      0 |
| GET /cases/:id           |    50 |    10155 |  1016 |   47.0 |   70.8 |   84.1 |       0 |      0 |
| GET /cases/:id/documents |     1 |     1232 |   123 |    7.5 |   12.0 |   14.6 |       0 |      0 |
| GET /cases/:id/documents |    10 |     7952 |   795 |   12.2 |   15.8 |   18.3 |       0 |      0 |
| GET /cases/:id/documents |    50 |    18151 |  1815 |   29.2 |   39.3 |   44.7 |       0 |      0 |

| probe                                 | requests | statuses      | first 429 at | RateLimit-Policy | p50 ms | p95 ms |
| ------------------------------------- | -------: | ------------- | -----------: | ---------------- | -----: | -----: |
| login, one unknown account            |       12 | 401×10 429×2  |           11 | 10;w=900         |  404.9 |  408.1 |
| refresh (token rotated each time)     |       32 | 200×17 429×15 |           18 | 30;w=900         |    5.6 |   10.6 |
| forgot, new unknown address each time |       12 | 202×10 429×2  |           11 | 10;w=900         |  404.5 |  406.5 |

Reading it:

- §10 target "API p95 < 300 ms for non-processing routes": met on every route here, the worst
  being case detail at 50 connections (p95 71 ms). The three case routes write their audit row
  within the request, so that insert is part of their numbers.
- No errors or non-2xx responses in any throughput run.
- The limits trip exactly where configured: the 11th login for one account (10 per 15 min), the
  18th refresh (30 per IP: 1 sign-in + 12 logins + 17 refreshes = 30), the 11th forgot (10 per IP).
  The `RateLimit-Policy` header shows which limiter answered.
- Login and forgot take ~405 ms on every path, success or not: the `AUTH_RESPONSE_FLOOR_MS`
  timing floor (D-106, audit L9).

What this doesn't tell you: behaviour on production hardware, over a network or behind a load
balancer, with a large dataset (3 cases here; list queries are paginated and indexed, but not
measured at volume), with several API processes, or under write load (uploads, pipeline). The
processing-time target (300 pages in < 10 minutes) is a separate check, not part of this script.
