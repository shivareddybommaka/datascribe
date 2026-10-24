import { LocalObjectStore, repoPath, runDunning, runMonthlyInvoicing } from '@datascribe/billing';
import { prisma } from '@datascribe/db';
import {
  createMedicalData,
  createOcrProvider,
  createSummaryProvider,
  medicalDataConfigFromEnv,
  RedisUsageTracker,
} from '@datascribe/medical-data';
import { loadKey } from '@datascribe/shared';
import { Queue, Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { BILLING_QUEUE, BILLING_SCHEDULES, processBillingJob } from './billing';
import { prismaPipelineStore } from './pipeline/prisma-store';
import {
  RUNNER_STAGES,
  runStage,
  type PipelineDeps,
  type PipelineJobData,
} from './pipeline/runner';
import { s3ObjectReader } from './pipeline/s3';
import { DEFAULT_JOB_OPTIONS, PIPELINE_QUEUES } from './queues';

const logger = pino({ base: { service: 'worker' }, level: process.env.LOG_LEVEL ?? 'info' });
const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) };

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
  readObject: s3ObjectReader(process.env),
  ocr: createOcrProvider('mock'), // tesseract arrives with M5b step 7 (D-079)
  coders: medical,
  summary: createSummaryProvider(
    (process.env.SUMMARY_PROVIDER || 'mock') as Parameters<typeof createSummaryProvider>[0],
  ),
  log: logger.child({ component: 'pipeline' }),
};
const pipelineQueues = new Map(
  RUNNER_STAGES.map((stage) => [stage, new Queue<PipelineJobData>(stage, { connection })]),
);

const workers = PIPELINE_QUEUES.map(
  (name) =>
    new Worker<PipelineJobData>(
      name,
      async (job) => {
        if (name === 'scan') {
          // Scanning still runs in the API until M5b step 4 (D-072).
          logger.info({ queue: name, jobId: job.id }, 'scan stage runs in the API for now');
          return;
        }
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
      { connection, concurrency: 2 },
    ),
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

const billingQueue = new Queue(BILLING_QUEUE, { connection });
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
    { connection, concurrency: 1 },
  ),
);

logger.info({ queues: workers.length }, 'worker started');

async function shutdown() {
  await Promise.all(workers.map((w) => w.close()));
  await billingQueue.close();
  await Promise.all([...pipelineQueues.values()].map((q) => q.close()));
  await usage.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
