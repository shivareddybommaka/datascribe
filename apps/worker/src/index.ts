import { LocalObjectStore, repoPath, runDunning, runMonthlyInvoicing } from '@datascribe/billing';
import { errorInfo, prisma } from '@datascribe/db';
import {
  deliverPendingEmails,
  notifyCaseReadyForReview,
  notifyInvoicesIssued,
  notifyProcessingFailed,
  notifyTasksDue,
} from '@datascribe/db/notifications';
import { runRetention } from '@datascribe/db/retention';
import {
  createMedicalData,
  createOcrProvider,
  createSummaryProvider,
  medicalDataConfigFromEnv,
  ocrProviderFromEnv,
  RedisUsageTracker,
  TesseractOcrProvider,
} from '@datascribe/medical-data';
import { createScanner, verifyDocument } from '@datascribe/scan';
import { loadKey, resolveDeployEnv } from '@datascribe/shared';
import { Queue, Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { BILLING_QUEUE, BILLING_SCHEDULES, processBillingJob } from './billing';
import { assertWorkerEnv } from './env';
import {
  NOTIFICATIONS_QUEUE,
  NOTIFICATION_SCHEDULES,
  processNotificationJob,
} from './notifications';
import {
  UPLOAD_SCAN_QUEUE,
  dispatchOnce,
  type DispatchTarget,
  type UploadScanJobData,
} from './pipeline/dispatch';
import { prismaDispatchSource, prismaPipelineStore } from './pipeline/prisma-store';
import {
  FIRST_RUNNER_STAGE,
  RUNNER_STAGES,
  runStage,
  type PipelineDeps,
  type PipelineJobData,
  type ScanOutcome,
} from './pipeline/runner';
import { renderPdfPage } from './pipeline/render-page';
import {
  RETENTION_QUEUE,
  RETENTION_SCHEDULES,
  processRetentionJob,
  retentionConfigFromEnv,
} from './retention';
import { s3DocumentObjects } from './pipeline/s3';
import { DEFAULT_JOB_OPTIONS, PIPELINE_QUEUES, redisConnection } from './queues';
import { closeSentry, initSentry, isFinalAttempt } from './sentry';

const logger = pino({ base: { service: 'worker' }, level: process.env.LOG_LEVEL ?? 'info' });
const connection = redisConnection(process.env.REDIS_URL ?? 'redis://localhost:6379');
// Own key space per checkout / e2e run when several share one Redis (D-081).
const prefix = process.env.QUEUE_PREFIX || 'bull';
const queueOpts = { connection, prefix };

// Same deploy profile as the API (D-120, D-117); production also needs ClamAV.
assertWorkerEnv(process.env);
const deployEnv = resolveDeployEnv(process.env);
// D-119: off unless SENTRY_DSN is set
const reportJobError = initSentry(process.env);

// ── §7 stage 1: virus scan (D-072, moved from the API in D-081); staging may use the mock ──
const scanner = createScanner({
  CLAMAV_HOST: process.env.CLAMAV_HOST || undefined,
  CLAMAV_PORT: Number(process.env.CLAMAV_PORT || 3310),
});
if (scanner.name === 'mock') {
  logger.warn('uploads use the mock virus scanner (no CLAMAV_HOST): only EICAR is detected');
}
const objects = s3DocumentObjects(process.env);
const scanDeps = { prisma, storage: objects, scanner, logger: logger.child({ component: 'scan' }) };
const scanDocument = async (documentId: string): Promise<ScanOutcome> =>
  // null: this process is already scanning it
  (await verifyDocument(scanDeps, documentId))?.scanStatus ?? 'pending';

// ── M5 pipeline: one queue per stage, each finished stage enqueues the next ──
// usage counters shared with the API's admin page (D-112)
const usage = RedisUsageTracker.connect(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  prefix: process.env.REDIS_KEY_PREFIX ?? 'ds:',
  onError: (name) => logger.warn({ err: { name } }, 'medical usage counter not written'),
});
const medical = createMedicalData({ ...medicalDataConfigFromEnv(process.env), usage });
const ocrKind = ocrProviderFromEnv(process.env);
const ocr = createOcrProvider(ocrKind);
const pipelineDeps: PipelineDeps = {
  store: prismaPipelineStore(prisma),
  phiKey: loadKey(process.env.PHI_ENCRYPTION_KEY),
  scanDocument,
  readObject: objects.read,
  ocr,
  // scanned PDF pages need an image; the mock OCR keeps them counted in needsOcr instead (D-082)
  renderPage: ocrKind === 'mock' ? undefined : (page) => renderPdfPage(page),
  coders: medical,
  summary: createSummaryProvider(
    (process.env.SUMMARY_PROVIDER || 'mock') as Parameters<typeof createSummaryProvider>[0],
  ),
  log: logger.child({ component: 'pipeline' }),
  notify: {
    readyForReview: (caseId) => notifyCaseReadyForReview(prisma, caseId),
    processingFailed: (caseId) => notifyProcessingFailed(prisma, caseId),
  },
};
const pipelineQueues = new Map(
  RUNNER_STAGES.map((stage) => [stage, new Queue<PipelineJobData>(stage, queueOpts)]),
);

const workers: Worker[] = PIPELINE_QUEUES.map(
  (name) =>
    new Worker<PipelineJobData>(
      name,
      async (job) => {
        const result = await runStage(
          name,
          job.data,
          { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 },
          pipelineDeps,
        );
        if (result.next) {
          await pipelineQueues.get(result.next)!.add(result.next, job.data, DEFAULT_JOB_OPTIONS);
        }
        return result.stats ?? {};
      },
      { ...queueOpts, concurrency: 2 },
    ),
);

// Uploads are scanned as they complete, so the portal shows Ready / Infected before submitting.
const uploadScanQueue = new Queue<UploadScanJobData>(UPLOAD_SCAN_QUEUE, queueOpts);
workers.push(
  new Worker<UploadScanJobData>(
    UPLOAD_SCAN_QUEUE,
    async (job) => ({ status: await scanDocument(job.data.documentId) }),
    { ...queueOpts, concurrency: 2 },
  ),
);

// The API only writes rows; this hands completed uploads and submitted cases to the queues.
const dispatchSource = prismaDispatchSource(prisma);
const dispatchTarget: DispatchTarget = {
  async scanUpload(documentId, jobId) {
    await uploadScanQueue.add(UPLOAD_SCAN_QUEUE, { documentId }, { ...DEFAULT_JOB_OPTIONS, jobId });
  },
  async startCase(caseId, jobId) {
    await pipelineQueues
      .get(FIRST_RUNNER_STAGE)!
      .add(FIRST_RUNNER_STAGE, { caseId }, { ...DEFAULT_JOB_OPTIONS, jobId });
  },
};
const startCases = process.env.PIPELINE_START_CASES !== 'false';
let dispatching = false;
const dispatchTimer = setInterval(
  () => {
    if (dispatching) return;
    dispatching = true;
    dispatchOnce(dispatchSource, dispatchTarget, { startCases })
      .then((n) => {
        if (n.uploads + n.cases > 0) logger.debug(n, 'dispatched');
      })
      .catch((err: unknown) => logger.warn({ err: errorInfo(err) }, 'dispatch failed'))
      .finally(() => {
        dispatching = false;
      });
  },
  Number(process.env.DISPATCH_INTERVAL_MS || 2_000),
);

// ── M8 billing: monthly invoicing + dunning as repeatable jobs ──
const appUrl = process.env.APP_URL ?? 'http://localhost:3010';
const smtpPort = Number(process.env.SMTP_PORT ?? 1025);
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST ?? 'localhost',
  port: smtpPort,
  secure: smtpPort === 465,
});
const mailer = {
  async send(mail: { to: string; subject: string; text: string }) {
    await transport.sendMail({
      from: process.env.MAIL_FROM ?? 'no-reply@datascribe.example',
      ...mail,
    });
  },
};
const store = new LocalObjectStore(repoPath(process.env.INVOICE_STORAGE_DIR ?? '.data/invoices'));
const billingLog = logger.child({ queue: BILLING_QUEUE });

const billingQueue = new Queue(BILLING_QUEUE, queueOpts);
for (const [name, repeat] of Object.entries(BILLING_SCHEDULES)) {
  // upsert: restarting the worker never duplicates a schedule
  await billingQueue.upsertJobScheduler(name, repeat, { name, opts: DEFAULT_JOB_OPTIONS });
}

workers.push(
  new Worker(
    BILLING_QUEUE,
    async (job) => {
      const result = await processBillingJob(job.name, {
        runMonthlyInvoicing: async (now) => {
          const result = await runMonthlyInvoicing(prisma, { now, store, log: billingLog });
          await notifyInvoicesIssued(prisma, result.invoiceIds);
          return result;
        },
        runDunning: (now) => runDunning(prisma, mailer, { now, appUrl, log: billingLog }),
      });
      billingLog.info({ job: job.name, jobId: job.id, ...result }, 'billing job done');
      return result;
    },
    { ...queueOpts, concurrency: 1 },
  ),
);

// ── M9 notifications: email outbox + task-due reminders (D-090) ──
const notifyLog = logger.child({ queue: NOTIFICATIONS_QUEUE });
const notificationsQueue = new Queue(NOTIFICATIONS_QUEUE, queueOpts);
for (const [name, repeat] of Object.entries(NOTIFICATION_SCHEDULES)) {
  await notificationsQueue.upsertJobScheduler(name, repeat, {
    name,
    opts: { removeOnComplete: 100, removeOnFail: 1_000 },
  });
}
workers.push(
  new Worker(
    NOTIFICATIONS_QUEUE,
    async (job) => {
      const result = await processNotificationJob(job.name, {
        deliverEmails: (now) =>
          deliverPendingEmails(prisma, mailer, { now, appUrl, log: notifyLog }),
        notifyTasksDue: (now) => notifyTasksDue(prisma, now),
      });
      const busy = Object.values(result).some((n) => n > 0);
      if (busy) notifyLog.info({ job: job.name, ...result }, 'notifications job done');
      return result;
    },
    { ...queueOpts, concurrency: 1 },
  ),
);

// ── §10 retention: hard-delete source documents of long-closed cases (D-128) ──
const retentionLog = logger.child({ queue: RETENTION_QUEUE });
const retentionConfig = retentionConfigFromEnv(process.env);
const retentionQueue = new Queue(RETENTION_QUEUE, queueOpts);
for (const [name, repeat] of Object.entries(RETENTION_SCHEDULES)) {
  await retentionQueue.upsertJobScheduler(name, repeat, { name, opts: DEFAULT_JOB_OPTIONS });
}
workers.push(
  new Worker(
    RETENTION_QUEUE,
    async (job) => {
      const result = await processRetentionJob(job.name, ({ now }) =>
        runRetention(prisma, {
          now,
          ...retentionConfig,
          deleteObject: objects.remove,
          log: retentionLog,
        }),
      );
      retentionLog.info({ job: job.name, jobId: job.id, ...result }, 'retention job done');
      return result;
    },
    { ...queueOpts, concurrency: 1 },
  ),
);

if (reportJobError) {
  for (const worker of workers) {
    worker.on('failed', (job, err) => {
      if (job && isFinalAttempt(job)) reportJobError(err, worker.name);
    });
  }
}

logger.info(
  { queues: workers.length, deploy: deployEnv, scanner: scanner.name, ocr: ocrKind },
  'worker started',
);

async function shutdown() {
  clearInterval(dispatchTimer);
  await Promise.all(workers.map((w) => w.close()));
  await billingQueue.close();
  await notificationsQueue.close();
  await retentionQueue.close();
  await uploadScanQueue.close();
  await Promise.all([...pipelineQueues.values()].map((q) => q.close()));
  await usage.close();
  if (ocr instanceof TesseractOcrProvider) await ocr.close();
  await prisma.$disconnect();
  await closeSentry();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
