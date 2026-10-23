import { LocalObjectStore, repoPath, runDunning, runMonthlyInvoicing } from '@datascribe/billing';
import { prisma } from '@datascribe/db';
import {
  deliverPendingEmails,
  notifyInvoicesIssued,
  notifyTasksDue,
} from '@datascribe/db/notifications';
import { Queue, Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { BILLING_QUEUE, BILLING_SCHEDULES, processBillingJob } from './billing';
import {
  NOTIFICATIONS_QUEUE,
  NOTIFICATION_SCHEDULES,
  processNotificationJob,
} from './notifications';
import { DEFAULT_JOB_OPTIONS, PIPELINE_QUEUES } from './queues';

const logger = pino({ base: { service: 'worker' }, level: process.env.LOG_LEVEL ?? 'info' });
const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
// the URL's path selects the Redis database (redis://host:6379/2), so checkouts can keep apart
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  db: Number(redisUrl.pathname.slice(1) || 0),
};

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
    { connection, concurrency: 1 },
  ),
);

// ── M9 notifications: email outbox + task-due reminders (D-090) ──
const notifyLog = logger.child({ queue: NOTIFICATIONS_QUEUE });
const notificationsQueue = new Queue(NOTIFICATIONS_QUEUE, { connection });
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
    { connection, concurrency: 1 },
  ),
);

logger.info({ queues: workers.length }, 'worker started');

async function shutdown() {
  await Promise.all(workers.map((w) => w.close()));
  await billingQueue.close();
  await notificationsQueue.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
