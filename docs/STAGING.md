# Local staging on the Mac Studio

A staging copy of Datascribe runs on the Mac Studio. Shiva's own Cloudflare tunnel publishes it at
**https://datascribe.stayspot.app**, pointing at `http://localhost:3020`. It holds **synthetic
data only** until the AWS production launch. Design notes: D-120 (deploy profile), D-121 (behind
the tunnel), D-122 (storage relay), D-123 (web guard rails), D-124 (runner and runbook).

```
browser ─https─▶ Cloudflare (Access) ─▶ cloudflared on the Mac ─▶ 127.0.0.1:3020 Next (production build)
                                                                     └─ /api/v1 ─▶ 127.0.0.1:4020 API ─┐
                                              worker (BullMQ) ◀── Redis /5 ──────────────────────────┤
                                              Postgres :5433 datascribe_staging, SeaweedFS :9000, Mailpit
```

- **Ports**: web **3020** (never 3000, which is StaySpot's CRM tunnel, and never 3010, Shiva's dev
  preview), API 4020. Both bind to 127.0.0.1, so only the tunnel reaches them from outside.
- **Separate from everything else**: its own tunnel and token (not StaySpot's), its own databases
  (`datascribe_staging`, `datascribe_staging_cms`), Redis DB 5, buckets `ds-staging-*`, and its
  own Next build dir (`apps/web/.next-staging`). Nothing in `~/.cloudflared` is read or changed.
- **What staging refuses** (the API and worker won't start): a real LLM (`SUMMARY_PROVIDER` other
  than `mock`), `OCR_PROVIDER=textract`, live Stripe keys, any SMTP host other than
  `localhost` / `127.0.0.1` (Mailpit), Postgres port 5432, a database name without `staging`, an
  http `APP_URL`, `EXTRA_TRUSTED_ORIGINS`.
- **What staging allows** that production doesn't: local SeaweedFS without SSE (`S3_SSE=none`), the
  fake payment gateway (simulated checkout), the mock virus scanner (ClamAV if `CLAMAV_HOST` is
  set), and the storage relay (uploads and downloads go through the API, because browsers can't
  reach the Mac's `localhost:9000`).
- **On every page**: a fixed red banner, "Staging — synthetic data only. Do not upload real patient
  records.", plus `X-Robots-Tag: noindex`, a `robots.txt` that disallows everything, and no GA/GTM.
- **No CMS process**: `CMS_URL=none` renders the bundled marketing copy. A CMS would serve its
  media from localhost, which visitors behind the tunnel can't load.

All commands below run as the macOS account **nova** from the checkout (e.g.
`/Users/nova/projects/datascribe`), one per line. They need the local infrastructure running.

## 1. One-time setup

Start the local infrastructure (Postgres 5433, Redis, SeaweedFS, Mailpit):

```
colima start
```

```
/Users/nova/.local/bin/pnpm infra:up
```

Create `.env.staging` from the example (git-ignored, never committed):

```
cp .env.staging.example .env.staging
```

Fill in its empty secrets with **new staging-only values**, not dev's and never production's. Print
two JWT secrets and a PHI key, then paste them into `.env.staging` (`JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, `PHI_ENCRYPTION_KEY`):

```
openssl rand -base64 48
```

```
openssl rand -base64 48
```

```
openssl rand -base64 32
```

Also set `SEED_USER_PASSWORD` (12+ characters, the password of every seeded synthetic user) and
`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`. Those must be the same values that docker compose
gives SeaweedFS (the `S3_*` values in `.env`, or compose's defaults). Then check the file. The
check reports problems by variable name and never prints a value:

```
/Users/nova/.local/bin/pnpm staging:check
```

## 2. Create, reset and seed the staging database

This creates `datascribe_staging` on 5433 if it's missing, empties it, applies every migration and
seeds synthetic data: roles, three synthetic firms and users, three synthetic cases, plans, and the
demo CRM leads. It refuses any database whose name lacks `staging`, and port 5432.

```
/Users/nova/.local/bin/pnpm staging:db:reset
```

After pulling new code with migrations, keep the data and apply only the new migrations:

```
/Users/nova/.local/bin/pnpm staging:db:migrate
```

Seeded sign-ins (password = `SEED_USER_PASSWORD`): console `super.admin@datascribe.example` (and
`sales@`, `finance@`, `ops.manager@`, `case.manager@`, ... `@datascribe.example`). Internal users
enrol in MFA with an authenticator app at first sign-in. Portal users are
`client.admin@acme.example`, `client.user@acme.example` and `client.admin@harbor.example`. Mail
goes to Mailpit at http://localhost:8025.

## 3. Build and start

Build after every code change (production build of the web app, stamped for staging):

```
/Users/nova/.local/bin/pnpm staging:build
```

Start api, worker and web in the foreground (prefixed logs). It refuses to start if 3020 or 4020
is in use, or if the build wasn't made for this `APP_URL`:

```
/Users/nova/.local/bin/pnpm staging:start
```

Check it locally at http://127.0.0.1:3020. Sign-in only works through the https URL, because
`APP_URL` is https and the CSRF check compares origins. Uploads and downloads go through the
storage relay (D-122).

## 4. Stop

Press Ctrl-C in the terminal running `staging:start`, or from another terminal:

```
/Users/nova/.local/bin/pnpm staging:stop
```

Stop the tunnel with Ctrl-C in its terminal (section 6). With the tunnel down the site shows a
Cloudflare error page. To take it off the internet for good, delete the public hostname or the
tunnel in the dashboard.

## 5. Shiva: create the tunnel and Cloudflare Access (dashboard)

Do these in the Cloudflare dashboard for the account that holds `stayspot.app`. Set up Access
first, so the hostname is never public without it.

**Cloudflare Access (protects the site)**

1. Zero Trust → Access → Applications → **Add an application** → **Self-hosted**.
2. Name `Datascribe staging`. Session duration 24 hours. Public hostname: subdomain `datascribe`,
   domain `stayspot.app`, path empty (the whole site, including `/api/v1`).
3. Add a policy `Allow Shiva`: Action **Allow**, Include → **Emails** → Shiva's address (and
   anyone else who should see staging). Login method: One-time PIN (or the identity provider
   already used for StaySpot).
4. Save. Visitors now sign in at Cloudflare before they reach the app. The app's own login comes
   after that.

**The tunnel (new, separate from StaySpot's)**

1. Zero Trust → Networks → Tunnels → **Create a tunnel** → **Cloudflared** → name
   `datascribe-staging` → Save.
2. On the "Install and run a connector" page, **copy the token only**: it's the long string after
   `--token` in the shown command. **Don't run the shown `cloudflared service install …`
   command**: it installs a system service and could replace the service StaySpot's tunnel uses.
   Don't paste the token into chat, email or the repo.
3. Next → **Public hostname**: subdomain `datascribe`, domain `stayspot.app`, path empty, service
   type **HTTP**, URL `localhost:3020`. Save the tunnel.
4. Leave StaySpot's tunnel and its `crm.stayspot.app` hostname as they are.

## 6. Run the tunnel (account nova)

The token stays in an environment variable for this terminal only. It's never written to a file in
the repo, and `~/.cloudflared` isn't used: `--config` points at `infra/staging/cloudflared.yml`,
which holds no secrets.

Read the token without echoing it or saving it in shell history (paste it and press Enter):

```
read -rs "DATASCRIBE_TUNNEL_TOKEN?Datascribe staging tunnel token: "
```

```
export DATASCRIBE_TUNNEL_TOKEN
```

Start the tunnel in the foreground (Ctrl-C stops it), with staging already started (section 3):

```
cloudflared --config infra/staging/cloudflared.yml tunnel run --token "$DATASCRIBE_TUNNEL_TOKEN"
```

The `--token` argument is visible to other processes on the Mac (`ps`). To avoid that, cloudflared
also reads the token from the `TUNNEL_TOKEN` variable:

```
export TUNNEL_TOKEN="$DATASCRIBE_TUNNEL_TOKEN"
```

```
cloudflared --config infra/staging/cloudflared.yml tunnel run
```

Then open https://datascribe.stayspot.app. You should get Cloudflare Access, then the site with the
red staging banner.

## 7. Optional: run at login (launchd templates, not installed)

`infra/staging/` has two **templates**: `app.datascribe.staging.plist` (the stack) and
`app.datascribe.staging-tunnel.plist` (the tunnel, token from the login Keychain). Nothing installs
them. If Shiva wants staging to survive reboots:

Store the token in the login Keychain (it prompts for it, so it stays out of shell history):

```
security add-generic-password -a nova -s datascribe-staging-tunnel -w
```

Copy both templates to `~/Library/LaunchAgents`. Replace `__REPO__` with the checkout path and
`__NODE__` with the output of `which node`. Then load them:

```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.datascribe.staging.plist
```

```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.datascribe.staging-tunnel.plist
```

To stop and unload them:

```
launchctl bootout gui/$(id -u)/app.datascribe.staging-tunnel
```

```
launchctl bootout gui/$(id -u)/app.datascribe.staging
```

Logs go to `~/Library/Logs/datascribe-staging.log` and `~/Library/Logs/datascribe-staging-tunnel.log`.

## 8. Smoke test (developers)

This runs the production-built staging stack once on ports 3901 / 4901. It uses a throwaway
`datascribe_<checkout>_staging_smoke` database and the storage relay. Playwright (system Chrome)
checks the banner, noindex, robots.txt, no analytics, the console sign-in with MFA enrolment and
cookie flags, the portal, and an upload and download. Then it stops the stack. It's the only user
of `STAGING_ALLOW_HTTP_FOR_SMOKE=1` (http://localhost instead of the https URL). Secrets come from
the checkout's `.env`; nothing is printed.

```
/Users/nova/.local/bin/pnpm staging:smoke
```

## Notes

- Client IPs (rate limits, audit): with `TRUST_PROXY=loopback` the API trusts only the local Next
  hop. Cloudflare appends the real client address to `X-Forwarded-For`, and
  `TRUST_CF_CONNECTING_IP=true` takes it from `CF-Connecting-IP` instead. That header is used only
  when the hop is trusted, and it's refused in production (D-121).
- Keep `UPLOAD_PART_SIZE_MB` at 9 or below: Next's rewrite proxy passes at most 10 MB of a request
  body to the API. Cloudflare's limit is 100 MB.
- The API and worker run from TypeScript source with `tsx` under `NODE_ENV=production`. Workspace
  packages are consumed as source (D-002), so a plain `node dist/server.js` can't load them yet.
  The web app is a real `next build`.
- The seeded synthetic cases have no files in S3, so the worker logs a failed scan stage for the
  submitted seed case. This is expected and only affects that seed row.
