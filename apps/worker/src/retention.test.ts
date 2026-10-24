import { describe, expect, it, vi } from 'vitest';
import { RETENTION_SCHEDULES, processRetentionJob, retentionConfigFromEnv } from './retention';

const result = { dryRun: false, orgs: 1, skippedOrgs: 0, eligible: 2, deleted: 2, failed: 0 };

describe('retention job', () => {
  it('runs the retention pass with the job time', async () => {
    const run = vi.fn(async () => result);
    const now = new Date('2026-10-25T03:00:00Z');
    expect(await processRetentionJob('retention-delete', run, now)).toEqual(result);
    expect(run).toHaveBeenCalledWith({ now });
  });

  it('fails loudly on unknown jobs', async () => {
    await expect(processRetentionJob('nope', vi.fn())).rejects.toThrow(/Unknown/);
  });

  it('repeats daily', () => {
    expect(RETENTION_SCHEDULES).toEqual({ 'retention-delete': { pattern: '0 3 * * *' } });
  });

  it('reads dry run and batch size from the environment, with safe defaults', () => {
    expect(retentionConfigFromEnv({})).toEqual({ dryRun: false, batchSize: 500 });
    expect(
      retentionConfigFromEnv({ RETENTION_DRY_RUN: 'true', RETENTION_BATCH_SIZE: '20' }),
    ).toEqual({ dryRun: true, batchSize: 20 });
    expect(retentionConfigFromEnv({ RETENTION_DRY_RUN: '1', RETENTION_BATCH_SIZE: '-5' })).toEqual({
      dryRun: false,
      batchSize: 500,
    });
  });
});
