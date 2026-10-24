import { LocalObjectStore, repoPath, runDunning, runMonthlyInvoicing } from '@datascribe/billing';
import { errorInfo, prisma } from '@datascribe/db';
import {
  createMedicalData,
  createOcrProvider,
  createSummaryProvider,
  medicalDataConfigFromEnv,
  RedisUsageTracker,
} from '@datascribe/medical-data';
import { createScanner, verifyDocument } from '@datascribe/scan';
import { loadKey } from '@datascribe/shared';
import { Queue, Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { BILLING_QUEUE, BILLING_SCHEDULES, processBillingJob } from './billing';
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
import { s3DocumentObjects } from './pipeline/s3';
import { DEFAULT_JOB_OPTIONS, PIPELINE_QUEUES } from './queues';

const logger = pino({ base: { service: 'worker' }, level: process.env.LOG_LEVEL ?? 'info' });
const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  db: Number(redisUrl.pathname.slice(1) || 0),
};
// Own key space per checkout / e2e run when several share one Redis (D-081).
const prefix = process.env.QUEUE_PREFIX || 'bull';
const queueOpts = { connection, prefix };

// ── §7 stage 1: virus scan (D-072, moved from the API in D-081) ──
if (process.env.NODE_ENV === 'production' && !process.env.CLAMAV_HOST) {
  throw new Error('production needs a real virus scanner (set CLAMAV_HOST)');
}
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
const pipelineDeps: PipelineDeps = {
  store: prismaPipelineStore(prisma),
  phiKey: loadKey(process.env.PHI_ENCRYPTION_KEY),
  scanDocument,
  readObject: objects.read,
  ocr: createOcrProvider('mock'), // tesseract arrives with M5b step 7 (D-079)
  coders: medical,
  summary: createSummaryProvider(
    (process.env.SUMMARY_PROVIDER || 'mock') as Parameters<typeof createSummaryProvider>[0],
  ),
  log: logger.child({ component: 'pipeline' }),
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
        runMonthlyInvoicing: (now) => runMonthlyInvoicing(prisma, { now, store, log: billingLog }),
        runDunning: (now) => runDunning(prisma, mailer, { now, appUrl, log: billingLog }),
      });
      billingLog.info({ job: job.name, jobId: job.id, ...result }, 'billing job done');
      return result;
    },
    { ...queueOpts, concurrency: 1 },
  ),
);

logger.info({ queues: workers.length, scanner: scanner.name }, 'worker started');

async function shutdown() {
  clearInterval(dispatchTimer);
  await Promise.all(workers.map((w) => w.close()));
  await billingQueue.close();
  await uploadScanQueue.close();
  await Promise.all([...pipelineQueues.values()].map((q) => q.close()));
  await usage.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
