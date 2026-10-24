import { LocalObjectStore, createGateway, repoPath } from '@datascribe/billing';
import { errorInfo, prisma } from '@datascribe/db';
import { PrismaCacheStore, createMedicalData } from '@datascribe/medical-data';
import { loadKey } from '@datascribe/shared';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { DEFAULT_RATE_LIMITS } from './context';
import { createLogger } from './lib/logger';
import { createSmtpMailer } from './lib/mailer';
import { MedicalSwitches } from './lib/medical-switches';
import { RedisRateLimitStore, createRedis } from './lib/redis';
import { createScanner } from './lib/scanner';
import { S3DocumentStorage } from './lib/storage';
import { resumePendingVerifications } from './services/documents';
import { encryptLegacyPhi } from './services/phi-backfill';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const phiKey = loadKey(env.PHI_ENCRYPTION_KEY);
const gateway = createGateway({
  ...env,
  fakeCheckoutBaseUrl: `${env.APP_URL}/api/v1/payments/fake-checkout`,
});
if (gateway.name === 'fake') {
  logger.warn('payments use the Fake gateway (no STRIPE_SECRET_KEY): checkout is simulated');
}
// Not awaited: boot must not depend on the DB being ready; until it loads, every source is on
// and the first adapter call retries the load.
const medicalSwitches = new MedicalSwitches(prisma);
medicalSwitches.load().catch((err: Error) => {
  logger.warn({ err: { name: err.name } }, 'medical switches not loaded yet');
});
// Rate-limit counters shared by every API process (D-111). While Redis is down the limited
// routes answer 500 rather than skipping the limit.
const redis = createRedis(env.REDIS_URL);
let redisDown = false;
redis.on('error', (err: Error) => {
  if (!redisDown)
    logger.error({ err: { name: err.name } }, 'redis unavailable; limited routes fail');
  redisDown = true;
});
redis.on('ready', () => {
  if (redisDown) logger.info('redis reconnected');
  redisDown = false;
});
const storage = new S3DocumentStorage(env, [env.APP_URL, ...env.EXTRA_TRUSTED_ORIGINS]);
const scanner = createScanner(env);
if (scanner.name === 'mock') {
  logger.warn('uploads use the mock virus scanner (no CLAMAV_HOST): only EICAR is detected');
}

const errInfo = (err: unknown) => ({ err: errorInfo(err) });

/** Private buckets, CORS for browser part uploads and default SSE (D-014); retried until S3 is up. */
function prepareBuckets() {
  storage.ensureBuckets().then(
    () => logger.info({ bucket: storage.bucket }, 'document buckets ready'),
    (err) => {
      logger.error(errInfo(err), 'S3 bucket setup failed; uploads fail until it succeeds');
      setTimeout(prepareBuckets, 30_000).unref();
    },
  );
}

/**
 * Background startup work. Never fatal: the API keeps serving (e.g. CRM, billing) and these are
 * logged. Legacy plaintext stays readable until the backfill succeeds (decryptOptional).
 */
async function startupTasks() {
  prepareBuckets();
  // E2E (NODE_ENV=test) resets its fresh database after the servers start; connecting before that
  // leaves stale pooled connections. A fresh DB has no legacy rows or interrupted checks anyway.
  if (env.NODE_ENV === 'test') return;
  try {
    const backfill = await encryptLegacyPhi(prisma, phiKey);
    if (backfill.cases + backfill.messages + backfill.validated > 0) {
      logger.info(backfill, 'encrypted legacy case notes / messages (audit L5)');
    }
  } catch (err) {
    logger.error(errInfo(err), 'L5 backfill failed; it runs again at the next start');
  }
  // checks interrupted by a restart (M5b moves this to the worker's scan stage)
  try {
    const n = await resumePendingVerifications({ prisma, storage, scanner, logger });
    if (n > 0) logger.info({ documents: n }, 'resumed pending document checks');
  } catch (err) {
    logger.error(errInfo(err), 'resuming document checks failed');
  }
}

const app = createApp({
  env,
  logger,
  prisma,
  phiKey,
  mailer: createSmtpMailer({ host: env.SMTP_HOST, port: env.SMTP_PORT, from: env.MAIL_FROM }),
  rateLimits: {
    ...DEFAULT_RATE_LIMITS,
    authPerWindow: env.RATE_LIMIT_AUTH,
    publicPerWindow: env.RATE_LIMIT_PUBLIC,
    accountPerWindow: env.RATE_LIMIT_ACCOUNT,
  },
  rateLimitStore: (limiter) => new RedisRateLimitStore(redis, limiter, env.REDIS_KEY_PREFIX),
  medical: createMedicalData({
    provider: env.MEDICAL_DATA_PROVIDER,
    openFdaApiKey: env.OPENFDA_API_KEY || undefined,
    cache: new PrismaCacheStore(prisma.medicalApiCache),
    logger,
    isEnabled: medicalSwitches.isEnabled,
  }),
  medicalSwitches,
  gateway,
  store: new LocalObjectStore(repoPath(env.INVOICE_STORAGE_DIR)),
  storage,
  scanner,
});

app.listen(env.API_PORT, () => {
  logger.info(
    { port: env.API_PORT, gateway: gateway.name, scanner: scanner.name, sse: env.S3_SSE },
    'api listening',
  );
  void startupTasks();
});
