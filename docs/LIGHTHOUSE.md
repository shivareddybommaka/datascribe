# Lighthouse

Performance and SEO of the public M3 pages, mobile preset (D-127). Target ≥ 90 on both.

```sh
pnpm --filter @datascribe/web lighthouse
```

The script builds the web app into `apps/web/.next-lighthouse`, starts `next start` on :3800
(`LIGHTHOUSE_PORT`), runs Lighthouse `LIGHTHOUSE_RUNS` times (default 3) per page with the installed
Google Chrome (`CHROME_PATH` for another) and rewrites the table below with the median run. It exits
1 if a page is below 90. `CMS_URL` defaults to `none` (the bundled copy, same layout as CMS pages);
the pricing page lists plans only if the API at `API_URL` is running (it was for the run below).
`LIGHTHOUSE_SKIP_BUILD=1` reuses the last build. Scores are from a local Mac (Lighthouse's simulated
mobile throttling), not from production behind a CDN.

<!-- lighthouse:start -->

Measured 2026-10-24 with Lighthouse 13.5.0, mobile preset, median of 3 runs, `next start`
on :3800 (CMS_URL=none). Target ≥ 90.

| Page                  | Performance | SEO | LCP (ms) | TBT (ms) | CLS   | Weighted audits below 0.9 |
| --------------------- | ----------- | --- | -------- | -------- | ----- | ------------------------- |
| `/`                   | 100         | 100 | 1925     | 0        | 0.000 | —                         |
| `/services`           | 100         | 100 | 1924     | 0        | 0.000 | —                         |
| `/pricing`            | 99          | 100 | 2225     | 0        | 0.000 | —                         |
| `/about`              | 100         | 100 | 1925     | 0        | 0.000 | —                         |
| `/contact`            | 99          | 100 | 2224     | 0        | 0.000 | —                         |
| `/ai-medical-summary` | 100         | 100 | 1925     | 0        | 0.000 | —                         |
| `/resources`          | 100         | 100 | 1925     | 0        | 0.000 | —                         |

<!-- lighthouse:end -->

## History

- 2026-10-24, first run: every page 100 / 100 except `/contact`, performance **80** (CLS 0.40).
  The form used `useSearchParams` inside a `<Suspense>` without fallback, so the static HTML had no
  form and the sections below it jumped down when it rendered on the client. Fixed: the form is
  server-rendered, `?kind=demo` is applied after hydration, and Send stays disabled until then.
  Re-run: 99, CLS 0.
- Hints (unweighted Lighthouse insights, not counted in the score): render-blocking CSS, legacy
  JavaScript polyfills, unused JavaScript in the shared chunk and image delivery for the logo. Not
  worth changing at these scores; revisit if a page drops.
