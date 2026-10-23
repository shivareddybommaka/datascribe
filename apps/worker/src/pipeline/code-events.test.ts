import { createMedicalData, type DiagnosisCoder } from '@datascribe/medical-data';
import { describe, expect, it, vi } from 'vitest';
import { CaseCoder } from './code-events';

const mock = () => createMedicalData({ provider: 'mock' });

describe('CaseCoder (mock providers)', () => {
  it('codes diagnoses, procedures and medications with definitions and drug labels', async () => {
    const coder = new CaseCoder(mock());
    const codes = await coder.codeTerms({
      diagnoses: ['Lumbar radiculopathy', 'Cervical sprain'],
      procedures: ['lumbar brace'],
      medications: ['gabapentin 300 mg'],
    });
    expect(codes.map((c) => `${c.system}:${c.code}`)).toEqual([
      'ICD10CM:M54.16',
      'ICD10CM:S13.4XXA',
      'HCPCS:L0650',
      'RXNORM:25480',
    ]);
    expect(codes[0]!.definition?.title).toBe('Radiculopathy, lumbar region');
    expect(codes[3]!.drugLabel?.indications).toMatch(/gabapentin/);
    expect(coder.stats).toEqual({ coded: 4, uncoded: 0, refused: 0, failed: 0 });
  });

  it('strips case identifiers before the adapter sees a term', async () => {
    const search = vi.fn<DiagnosisCoder['search']>().mockResolvedValue([]);
    const coder = new CaseCoder({ ...mock(), diagnosis: { search } }, ['Jane Testpatient']);
    await coder.codeTerms({
      diagnoses: ['Testpatient neck pain'],
      procedures: [],
      medications: [],
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0]).not.toMatch(/testpatient/i);
    expect(coder.stats.uncoded).toBe(1);
  });

  it('looks a repeated term up once and de-duplicates codes per event', async () => {
    const search = vi.fn<DiagnosisCoder['search']>(async (t) => mock().diagnosis.search(t, 1));
    const coder = new CaseCoder({ ...mock(), diagnosis: { search } });
    const terms = { diagnoses: ['sciatica', 'Sciatica'], procedures: [], medications: [] };
    expect(await coder.codeTerms(terms)).toHaveLength(1);
    await coder.codeTerms(terms);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('leaves a term uncoded when the provider fails, and keeps going', async () => {
    const coder = new CaseCoder({
      ...mock(),
      diagnosis: { search: () => Promise.reject(new Error('breaker open')) },
    });
    const codes = await coder.codeTerms({
      diagnoses: ['neck pain'],
      procedures: [],
      medications: ['ibuprofen'],
    });
    expect(codes.map((c) => c.code)).toEqual(['5640']);
    expect(coder.stats).toMatchObject({ failed: 1, coded: 1 });
  });

  it('refuses free text that is not a short term', async () => {
    const coder = new CaseCoder(mock());
    await coder.codeTerms({ diagnoses: ['x'.repeat(300)], procedures: [], medications: [] });
    expect(coder.stats.refused).toBe(1);
  });
});
