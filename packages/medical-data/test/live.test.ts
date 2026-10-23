import { describe, expect, it } from 'vitest';
import { createMedicalData } from '../src';

/**
 * Optional live smoke tests (§13), one per provider. Off by default and in CI; run by hand with
 *   RUN_LIVE_API_TESTS=true pnpm --filter @datascribe/medical-data exec vitest run test/live.test.ts
 * Synthetic clinical terms only.
 */
const live = process.env.RUN_LIVE_API_TESTS === 'true';

describe.skipIf(!live)('live provider smoke tests', () => {
  const md = createMedicalData({ provider: 'nlm', retry: { retries: 1 } });

  it('NLM Clinical Tables ICD-10-CM', async () => {
    const r = await md.diagnosis.search('lumbar radiculopathy', 3);
    expect(r.map((m) => m.code)).toContain('M54.16');
  });

  it('NLM Clinical Tables HCPCS', async () => {
    expect((await md.procedure.search('cervical collar', 3)).length).toBeGreaterThan(0);
  });

  it('NLM RxNav RxNorm', async () => {
    expect((await md.medication.normalize('gabapentin'))[0]?.code).toBe('25480');
  });

  it('openFDA drug label', async () => {
    expect((await md.drugInfo.getLabel('gabapentin'))?.indications).toBeTruthy();
  });

  it('MedlinePlus Connect', async () => {
    const def = await md.consumerHealth.define({
      system: 'ICD10CM',
      code: 'M54.16',
      display: '',
      source: '',
    });
    expect(def?.url).toMatch(/medlineplus\.gov/);
  });
});
