/** Processing pipeline stages (REQUIREMENTS.md §7), in order. Each stage is its own queue. */
export const PIPELINE_QUEUES = [
  'scan',
  'extract',
  'classify',
  'extract-events',
  'code',
  'build-deliverables',
  'ready-for-review',
] as const;
export type PipelineQueue = (typeof PIPELINE_QUEUES)[number];

export const OTHER_QUEUES = ['email', 'billing', 'notifications'] as const;

/** §7: 3 attempts with exponential backoff. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
};

/**
 * BullMQ connection options from REDIS_URL. The path selects the database (redis://host:6379/2) so
 * checkouts can keep apart; `rediss:` turns on TLS (ElastiCache in-transit encryption, D-115).
 */
export function redisConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    db: Number(u.pathname.slice(1) || 0),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: { servername: u.hostname } } : {}),
  };
}

export function nextStage(stage: PipelineQueue): PipelineQueue | null {
  const i = PIPELINE_QUEUES.indexOf(stage);
  return PIPELINE_QUEUES[i + 1] ?? null;
}
