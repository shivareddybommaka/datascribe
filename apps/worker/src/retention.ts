import {
  DEFAULT_RETENTION_BATCH,
  type RetentionOptions,
  type RetentionResult,
} from '@datascribe/db/retention';

/** §10 retention / hard-delete queue (D-128). */
export const RETENTION_QUEUE = 'retention';

/** Daily, 03:00 UTC (after invoicing). Upserted at start-up, so restarts never duplicate it. */
export const RETENTION_SCHEDULES = {
  'retention-delete': { pattern: '0 3 * * *' },
} as const;

export interface RetentionConfig {
  dryRun: boolean;
  batchSize: number;
}

/** RETENTION_DRY_RUN=true logs counts only; RETENTION_BATCH_SIZE caps deletes per run. */
export function retentionConfigFromEnv(env: Record<string, string | undefined>): RetentionConfig {
  const n = Number(env.RETENTION_BATCH_SIZE);
  return {
    dryRun: env.RETENTION_DRY_RUN === 'true',
    batchSize: Number.isInteger(n) && n > 0 ? n : DEFAULT_RETENTION_BATCH,
  };
}

export async function processRetentionJob(
  name: string,
  run: (opts: Pick<RetentionOptions, 'now'>) => Promise<RetentionResult>,
  now = new Date(),
): Promise<RetentionResult> {
  if (name !== 'retention-delete') throw new Error(`Unknown retention job: ${name}`);
  return run({ now });
}
