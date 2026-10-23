import { prisma } from '@datascribe/db';
import { PrismaCacheStore, createMedicalData } from '@datascribe/medical-data';
import { loadKey } from '@datascribe/shared';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { DEFAULT_RATE_LIMITS } from './context';
import { createLogger } from './lib/logger';
import { createSmtpMailer } from './lib/mailer';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const app = createApp({
  env,
  logger,
  prisma,
  phiKey: loadKey(env.PHI_ENCRYPTION_KEY),
  mailer: createSmtpMailer({ host: env.SMTP_HOST, port: env.SMTP_PORT, from: env.MAIL_FROM }),
  rateLimits: DEFAULT_RATE_LIMITS,
  medical: createMedicalData({
    provider: env.MEDICAL_DATA_PROVIDER,
    openFdaApiKey: env.OPENFDA_API_KEY || undefined,
    cache: new PrismaCacheStore(prisma.medicalApiCache),
    logger,
  }),
});

app.listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT }, 'api listening');
});
