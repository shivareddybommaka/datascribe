#!/usr/bin/env node
/**
 * Staging smoke test (D-124): builds the production staging stack, runs it once on 39xx ports
 * against a throwaway `*_staging_smoke` database, checks login, the console, the portal and an
 * upload with Playwright, then stops it. The only user of STAGING_ALLOW_HTTP_FOR_SMOKE=1
 * (http://localhost instead of the tunnel's https URL).
 *
 *   node scripts/staging-smoke.mjs [--secrets-from .env]
 *
 * Secrets (JWT, PHI key, S3 keys, seed password) come from --secrets-from (default: this checkout's
 * .env); everything else is fixed here. Nothing is printed from the env file.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  ROOT,
  assertStaging,
  buildWeb,
  readEnvFile,
  resetDatabase,
  stagingEnv,
  startStack,
} from './staging-lib.mjs';

const args = process.argv.slice(2);
const secretsFlag = args.indexOf('--secrets-from');
const secretsFile = secretsFlag >= 0 ? args[secretsFlag + 1] : '.env';
const WEB_PORT = Number(process.env.SMOKE_WEB_PORT ?? 3901);
const API_PORT = Number(process.env.SMOKE_API_PORT ?? 4901);
const DIST_DIR = '.next-staging-smoke';
const tree = path
  .basename(ROOT)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_');
const dbName = `datascribe_${tree === 'datascribe' ? '' : `${tree}_`}staging_smoke`;

const SECRETS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'PHI_ENCRYPTION_KEY',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'SEED_USER_PASSWORD',
];

async function main() {
  const source = readEnvFile(secretsFile);
  const secrets = Object.fromEntries(SECRETS.filter((k) => source[k]).map((k) => [k, source[k]]));
  const env = stagingEnv(
    {
      ...secrets,
      STAGING_ALLOW_HTTP_FOR_SMOKE: '1',
      APP_URL: `http://localhost:${WEB_PORT}`,
      WEB_PORT: String(WEB_PORT),
      API_PORT: String(API_PORT),
      API_URL: `http://127.0.0.1:${API_PORT}`,
      DATABASE_URL: `postgresql://datascribe:datascribe@localhost:5433/${dbName}`,
      CMS_URL: 'none',
      REDIS_URL: 'redis://localhost:6379/5',
      REDIS_KEY_PREFIX: `ds-staging-smoke-${Date.now()}:`,
      QUEUE_PREFIX: `staging-smoke-${API_PORT}`,
      DISPATCH_INTERVAL_MS: '500',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET_DOCUMENTS: 'ds-staging-smoke-documents',
      S3_BUCKET_DELIVERABLES: 'ds-staging-smoke-deliverables',
      S3_SSE: 'none',
      S3_BROWSER_ACCESS: 'relay',
      UPLOAD_PART_SIZE_MB: '8',
      INVOICE_STORAGE_DIR: '.data/staging-smoke/invoices',
      TRUST_PROXY: 'loopback',
      TRUST_CF_CONNECTING_IP: 'true',
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      PAYMENT_GATEWAY: 'fake',
      MEDICAL_DATA_PROVIDER: 'mock',
      OCR_PROVIDER: 'mock',
      SUMMARY_PROVIDER: 'mock',
      // the smoke signs in a few times from one IP
      RATE_LIMIT_AUTH: '100',
      LOG_LEVEL: 'warn',
    },
    // no env file for next.config to load: every value is in the process env
    { ENV_FILE: path.join(ROOT, '.data/staging-smoke/no-env-file') },
  );
  assertStaging(env, { smoke: true });

  console.log(`[smoke] resetting ${dbName} (synthetic seed + demo leads)`);
  resetDatabase(env);
  console.log(`[smoke] building the staging web app (apps/web/${DIST_DIR})`);
  buildWeb(env, DIST_DIR);
  console.log(`[smoke] starting api :${API_PORT}, worker, web :${WEB_PORT}`);
  const stack = await startStack(env, { distDir: DIST_DIR, name: 'smoke' });
  const stopAndExit = async (code) => {
    await stack.stop(0);
    process.exit(code);
  };
  process.on('SIGINT', () => void stopAndExit(130));
  process.on('SIGTERM', () => void stopAndExit(143));

  let status = 1;
  try {
    const res = spawnSync(
      path.join(ROOT, 'apps/web/node_modules/.bin/playwright'),
      ['test', '--config', 'playwright.staging-smoke.config.ts'],
      {
        cwd: path.join(ROOT, 'apps/web'),
        stdio: 'inherit',
        env: {
          ...process.env,
          SMOKE_BASE_URL: env.APP_URL,
          SMOKE_PASSWORD: env.SEED_USER_PASSWORD ?? '',
        },
      },
    );
    status = res.status ?? 1;
  } finally {
    console.log('[smoke] stopping the stack');
    await stack.stop(0);
  }
  console.log(status === 0 ? '[smoke] PASSED' : `[smoke] FAILED (exit ${status})`);
  process.exit(status);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
