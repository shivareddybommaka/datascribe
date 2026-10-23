import { defineConfig } from '@playwright/test';
// not ../api/test/constants: that would fix TEST_DATABASE_URL before it is set below
import { TEST_S3 } from '../api/test/s3';

/**
 * E2E (§13). Runs its own API (:4100) and web (:3100) against the `datascribe_e2e` database on the
 * Docker Postgres (5433, never the CRM on 5432). Needs `colima start` + `pnpm infra:up` (Mailpit).
 * Uses the installed Google Chrome, so no browser download. Parallel checkouts set E2E_API_PORT,
 * E2E_WEB_PORT and E2E_DATABASE_URL (5433 only) so their runs don't collide.
 */
export const E2E = {
  dbUrl:
    process.env.E2E_DATABASE_URL ??
    'postgresql://datascribe:datascribe@localhost:5433/datascribe_e2e',
  apiPort: Number(process.env.E2E_API_PORT ?? 4100),
  webPort: Number(process.env.E2E_WEB_PORT ?? 3100),
  mailpit: 'http://localhost:8025',
};
if (!/@localhost:5433\//.test(E2E.dbUrl)) throw new Error('E2E database must be on localhost:5433');
const webUrl = `http://localhost:${E2E.webPort}`;

// Picked up by the API test setup module that globalSetup reuses.
process.env.TEST_DATABASE_URL = E2E.dbUrl;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: webUrl,
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @datascribe/api exec tsx src/server.ts',
      url: `http://localhost:${E2E.apiPort}/api/v1/health`,
      reuseExistingServer: false,
      // API warnings/errors in the test output (pino logs carry no bodies or PHI)
      stdout: 'pipe',
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        API_PORT: String(E2E.apiPort),
        APP_URL: webUrl,
        DATABASE_URL: E2E.dbUrl,
        JWT_ACCESS_SECRET: 'e2e-access-secret-'.padEnd(48, 'a'),
        JWT_REFRESH_SECRET: 'e2e-refresh-secret-'.padEnd(48, 'b'),
        PHI_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        LOG_LEVEL: 'warn',
        // every spec signs in from the same IP; production keeps the 30 / 15 min default
        RATE_LIMIT_AUTH: '300',
        // local SeaweedFS with buckets of its own (created at API startup), 5 MiB parts
        ...TEST_S3,
        S3_BUCKET_DOCUMENTS: `ds-e2e-${E2E.apiPort}-documents`,
        S3_BUCKET_DELIVERABLES: `ds-e2e-${E2E.apiPort}-deliverables`,
      },
    },
    {
      command: `pnpm exec next dev --port ${E2E.webPort}`,
      url: webUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        API_URL: `http://localhost:${E2E.apiPort}`,
        NEXT_TELEMETRY_DISABLED: '1',
        NEXT_DIST_DIR: `.next-e2e-${E2E.webPort}`,
      },
    },
  ],
});
