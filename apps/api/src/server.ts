import { LocalObjectStore, createGateway, repoPath } from '@datascribe/billing';
import { prisma } from '@datascribe/db';
import { PrismaCacheStore, createMedicalData } from '@datascribe/medical-data';
import { loadKey } from '@datascribe/shared';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { DEFAULT_RATE_LIMITS } from './context';
import { createLogger } from './lib/logger';
import { createSmtpMailer } from './lib/mailer';
import { MedicalSwitches } from './lib/medical-switches';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const gateway = createGateway({
  ...env,
  fakeCheckoutBaseUrl: `${env.APP_URL}/api/v1/payments/fake-checkout`,
});
if (gateway.name === 'fake') {
  logger.warn('payments use the Fake gateway (no STRIPE_SECRET_KEY): checkout is simulated');
}
const medicalSwitches = new MedicalSwitches(prisma);
await medicalSwitches.load();
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
    isEnabled: medicalSwitches.isEnabled,
  }),
  medicalSwitches,
  gateway,
  store: new LocalObjectStore(repoPath(env.INVOICE_STORAGE_DIR)),
});

app.listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT, gateway: gateway.name }, 'api listening');
});
