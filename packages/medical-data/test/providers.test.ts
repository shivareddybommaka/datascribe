import { describe, expect, it, vi } from 'vitest';
import {
  ATTRIBUTION,
  CODE_PATTERN,
  createMedicalData,
  drugNameForLabel,
  htmlToText,
  isValidCode,
  parseConnect,
  parseCtss,
  parseLabel,
  parseRxCandidates,
  truncate,
  type FetchLike,
} from '../src';
import { fixtures, json, replayFetch } from './helpers';

const nlm = (fetch: FetchLike, extra = {}) =>
  createMedicalData({ provider: 'nlm', fetch, retry: { retries: 0 }, ...extra });

describe('fixtures', () => {
  it('were recorded from the official endpoints with synthetic terms and no API key', () => {
    const hosts = Object.values(fixtures).map((f) => new URL(f.request.url).host);
    expect(new Set(hosts)).toEqual(
      new Set([
        'clinicaltables.nlm.nih.gov',
        'rxnav.nlm.nih.gov',
        'api.fda.gov',
        'connect.medlineplus.gov',
      ]),
    );
    for (const f of Object.values(fixtures)) {
      expect(f.request.url).not.toMatch(/api_key/);
      expect(f.response.status).toBe(200);
    }
  });
});

describe('NLM ICD-10-CM (DiagnosisCoder)', () => {
  it('maps the recorded Clinical Tables response to ICD10CM matches', async () => {
    const fetch = replayFetch();
    const md = nlm(fetch);
    const matches = await md.diagnosis.search('lumbar radiculopathy', 5);
    expect(fetch.calls).toEqual([fixtures['icd10cm-lumbar-radiculopathy']!.request.url]);
    expect(matches[0]).toEqual({
      system: 'ICD10CM',
      code: 'M54.16',
      display: 'Radiculopathy, lumbar region',
      score: 1,
      source: ATTRIBUTION.icd10cm.source,
    });
    expect(matches.length).toBeGreaterThan(1);
    for (const m of matches) expect(CODE_PATTERN.ICD10CM.test(m.code)).toBe(true);
  });

  it('de-identifies before calling: the request carries only the clinical phrase', async () => {
    const fetch = replayFetch();
    const md = nlm(fetch);
    await md.diagnosis.search('Mr. John Smith DOB 01/02/1950 lumbar radiculopathy', 5);
    expect(fetch.calls).toEqual([fixtures['icd10cm-lumbar-radiculopathy']!.request.url]);
  });

  it('refused terms come back uncoded without any call', async () => {
    const fetch = vi.fn<FetchLike>();
    const md = nlm(fetch);
    expect(await md.diagnosis.search('MRN 12345678')).toEqual([]);
    expect(await md.diagnosis.search('x '.repeat(150))).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a malformed response is a failure, answered as uncoded', async () => {
    const md = nlm(async () => json({ unexpected: true }));
    expect(await md.diagnosis.search('neck pain')).toEqual([]);
    expect(() => parseCtss([0, [], null], 'ICD10CM', 's')).toThrow();
  });
});

describe('NLM HCPCS (ProcedureCoder)', () => {
  it('maps the recorded HCPCS response', async () => {
    const fetch = replayFetch();
    const matches = await nlm(fetch).procedure.search('cervical collar', 5);
    expect(matches).toHaveLength(5);
    expect(matches[0]).toMatchObject({
      system: 'HCPCS',
      code: 'L0140',
      source: ATTRIBUTION.hcpcs.source,
    });
    for (const m of matches) expect(CODE_PATTERN.HCPCS.test(m.code)).toBe(true);
  });
});

describe('NLM RxNorm (MedicationNormalizer)', () => {
  it('collapses approximateTerm candidates to one match per RxCUI, preferring the RXNORM name', async () => {
    const fetch = replayFetch();
    const matches = await nlm(fetch).medication.normalize('gabapentin');
    expect(fetch.calls).toEqual([fixtures['rxnorm-gabapentin']!.request.url]);
    expect(matches[0]).toMatchObject({
      system: 'RXNORM',
      code: '25480',
      display: 'gabapentin',
      source: 'Source: NLM RxNorm',
    });
    expect(new Set(matches.map((m) => m.code)).size).toBe(matches.length);
    expect(matches.length).toBeLessThanOrEqual(5);
  });

  it('drops candidates without a releasable name and orders by rank then score', () => {
    const out = parseRxCandidates(
      [
        { rxcui: '2', rank: '2', score: '5', name: 'b', source: 'RXNORM' },
        { rxcui: '1', rank: '1', score: '9', source: 'MMSL' },
        { rxcui: '1', rank: '1', score: '9', name: 'A-RX', source: 'RXNORM' },
        { rxcui: '3', rank: '1', score: '1' },
        { rank: '1' },
      ],
      's',
    );
    expect(out.map((m) => [m.code, m.display])).toEqual([
      ['1', 'A-RX'],
      ['2', 'b'],
    ]);
  });

  it('answers uncoded when the response has no candidates', async () => {
    expect(
      await nlm(async () => json({ approximateGroup: {} })).medication.normalize('zzz'),
    ).toEqual([]);
  });
});

describe('openFDA (DrugInfoProvider)', () => {
  it('extracts indications and warnings from the recorded label', async () => {
    const fetch = replayFetch();
    const label = await nlm(fetch).drugInfo.getLabel('gabapentin');
    expect(fetch.calls).toEqual([fixtures['openfda-label-gabapentin']!.request.url]);
    expect(label?.source).toBe(ATTRIBUTION.openfda.source);
    expect(label?.indications).toMatch(/postherpetic neuralgia/i);
    expect(label?.warnings?.length).toBeGreaterThan(20);
    expect(label!.indications!.length).toBeLessThanOrEqual(1502);
  });

  it('strips strengths and dose forms so "gabapentin 300 mg capsule" finds the same label', async () => {
    const fetch = replayFetch();
    await nlm(fetch).drugInfo.getLabel('gabapentin 300 mg oral capsule');
    expect(fetch.calls).toEqual([fixtures['openfda-label-gabapentin']!.request.url]);
    expect(drugNameForLabel('Oxycodone HCl 5 mg tablet ER')).toBe('oxycodone');
  });

  it('searches by RxCUI and adds the API key when configured', async () => {
    const fetch = vi.fn<FetchLike>(async () => json({ error: { code: 'NOT_FOUND' } }, 404));
    const md = nlm(fetch, { openFdaApiKey: 'test-key-not-real' });
    expect(await md.drugInfo.getLabel('25480')).toBeNull();
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.searchParams.get('search')).toBe('openfda.rxcui:"25480"');
    expect(url.searchParams.get('api_key')).toBe('test-key-not-real');
    expect(fetch).toHaveBeenCalledTimes(1); // 404 = no label, not retried
  });

  it('parseLabel handles empty results and prefers boxed warnings; truncate cuts at a sentence', () => {
    expect(parseLabel({ results: [] }, 's')).toBeNull();
    expect(parseLabel({ results: [{}] }, 's')).toBeNull();
    expect(
      parseLabel({ results: [{ boxed_warning: ['Boxed.'], warnings: ['Plain.'] }] }, 's'),
    ).toEqual({
      warnings: 'Boxed.',
      source: 's',
    });
    const long = `${'First sentence is here. '.repeat(10)}tail`;
    expect(truncate(long, 100)).toMatch(/here\. …$/);
    expect(truncate('x'.repeat(50), 10)).toBe('xxxxxxxxxx …');
    expect(truncate(undefined)).toBeUndefined();
  });
});

describe('MedlinePlus Connect (ConsumerHealthInfo)', () => {
  const m5416 = {
    system: 'ICD10CM' as const,
    code: 'M54.16',
    display: 'Radiculopathy, lumbar region',
    source: '',
  };

  it('returns the recorded topic as plain text with its URL', async () => {
    const fetch = replayFetch();
    const def = await nlm(fetch).consumerHealth.define(m5416);
    expect(fetch.calls).toEqual([fixtures['medlineplus-icd10-M54.16']!.request.url]);
    expect(def?.title).toBe('Back Pain');
    expect(def?.url).toMatch(/^https:\/\/medlineplus\.gov\//);
    expect(def?.summary).not.toMatch(/<[a-z]/i);
    expect(def!.summary.length).toBeLessThanOrEqual(1202);
  });

  it('never calls for unsupported systems or malformed codes', async () => {
    const fetch = vi.fn<FetchLike>();
    const md = nlm(fetch);
    expect(await md.consumerHealth.define({ ...m5416, system: 'HCPCS', code: 'L0140' })).toBeNull();
    expect(await md.consumerHealth.define({ ...m5416, code: 'John Smith' })).toBeNull();
    expect(await md.consumerHealth.define({ ...m5416, system: 'RXNORM', code: '12a' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('parses empty feeds as no match and decodes HTML', () => {
    expect(parseConnect({ feed: { entry: [] } })).toBeNull();
    expect(parseConnect(null)).toBeNull();
    expect(
      htmlToText('<p>A &amp; B</p><ul><li>one&#39;s</li></ul>&nbsp;&lt;x&gt; &quot;q&quot;'),
    ).toBe('A & B\none\'s\n<x> "q"');
    expect(isValidCode({ system: 'SNOMED', code: '41381004' })).toBe(true);
    expect(isValidCode({ system: 'ICD10CM', code: 'U07.1' })).toBe(false);
  });
});

describe('usage stats across upstreams', () => {
  it('counts calls and cache hits per upstream for the admin page', async () => {
    const md = nlm(replayFetch());
    await md.diagnosis.search('lumbar radiculopathy', 5);
    await md.diagnosis.search('lumbar radiculopathy', 5);
    await md.medication.normalize('gabapentin');
    const stats = Object.fromEntries((await md.usageStats()).map((s) => [s.provider, s]));
    expect(Object.keys(stats).sort()).toEqual(['medlineplus', 'nlm-ctss', 'nlm-rxnav', 'openfda']);
    expect(stats['nlm-ctss']).toMatchObject({ calls: 1, cacheHits: 1, errors: 0 });
    expect(stats['nlm-rxnav']).toMatchObject({ calls: 1 });
    expect(stats.openfda).toMatchObject({ calls: 0, errorRate: 0 });
  });

  it('provider toggles are read per call', async () => {
    let enabled = false;
    const fetch = replayFetch();
    const md = nlm(fetch, { isEnabled: () => enabled });
    expect(await md.diagnosis.search('lumbar radiculopathy', 5)).toEqual([]);
    enabled = true;
    expect((await md.diagnosis.search('lumbar radiculopathy', 5)).length).toBeGreaterThan(0);
  });
});
