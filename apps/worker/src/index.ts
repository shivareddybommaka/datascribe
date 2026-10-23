import { Worker } from 'bullmq';
import { pino } from 'pino';
import { PIPELINE_QUEUES } from './queues';

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

logger.info({ queues: PIPELINE_QUEUES.length }, 'worker started');

async function shutdown() {
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
