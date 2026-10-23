import { LocalObjectStore, createGateway, repoPath } from '@datascribe/billing';
import { prisma } from '@datascribe/db';
import { PrismaCacheStore, createMedicalData } from '@datascribe/medical-data';
import { loadKey } from '@datascribe/shared';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { DEFAULT_RATE_LIMITS } from './context';
import { createLogger } from './lib/logger';
import { createSmtpMailer } from './lib/mailer';
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
const storage = new S3DocumentStorage(env, [env.APP_URL, ...env.EXTRA_TRUSTED_ORIGINS]);
const scanner = createScanner(env);
if (scanner.name === 'mock') {
  logger.warn('uploads use the mock virus scanner (no CLAMAV_HOST): only EICAR is detected');
}

// Private buckets, CORS for browser part uploads and default SSE: before taking traffic (D-014).
await storage.ensureBuckets();
const backfill = await encryptLegacyPhi(prisma, phiKey);
if (backfill.cases + backfill.messages + backfill.validated > 0) {
  logger.info(backfill, 'encrypted legacy case notes / messages (audit L5)');
}

const app = createApp({
  env,
  logger,
  prisma,
  phiKey,
  mailer: createSmtpMailer({ host: env.SMTP_HOST, port: env.SMTP_PORT, from: env.MAIL_FROM }),
  rateLimits: DEFAULT_RATE_LIMITS,
  medical: createMedicalData({
    provider: env.MEDICAL_DATA_PROVIDER,
    openFdaApiKey: env.OPENFDA_API_KEY || undefined,
    cache: new PrismaCacheStore(prisma.medicalApiCache),
    logger,
  }),
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
  // checks interrupted by a restart (M5b moves this to the worker's scan stage)
  resumePendingVerifications({ prisma, storage, scanner, logger })
    .then((n) => n > 0 && logger.info({ documents: n }, 'resumed pending document checks'))
    .catch((err: Error) =>
      logger.error({ err: { name: err.name, message: err.message } }, 'resume checks failed'),
    );
});
