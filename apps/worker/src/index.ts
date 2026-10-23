import {
  LocalObjectStore,
  repoPath,
  runDunning,
  runMonthlyInvoicing,
} from '@datascribe/billing';
import { prisma } from '@datascribe/db';
import { Queue, Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { BILLING_QUEUE, BILLING_SCHEDULES, processBillingJob } from './billing';
import { DEFAULT_JOB_OPTIONS, PIPELINE_QUEUES } from './queues';

const logger = pino({ base: { service: 'worker' }, level: process.env.LOG_LEVEL ?? 'info' });
const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) };

// M0: workers are registered but stages are no-ops. Real processors arrive in M5.
const workers = PIPELINE_QUEUES.map(
  (name) =>
    new Worker(
      name,
      async (job) => {
        logger.info({ queue: name, jobId: job.id }, 'stage not implemented yet (M5)');
      },
      { connection },
    ),
);

// ── M8 billing: monthly invoicing + dunning as repeatable jobs ──
const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const smtpPort = Number(process.env.SMTP_PORT ?? 1025);
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST ?? 'localhost',
  port: smtpPort,
  secure: smtpPort === 465,
});
const mailer = {
  async send(mail: { to: string; subject: string; text: string }) {
    await transport.sendMail({ from: process.env.MAIL_FROM ?? 'no-reply@datascribe.example', ...mail });
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
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
