/**
 * Records one real response per provider into test/fixtures (§13: CI replays these, never live).
 * Run by hand only when a provider's format changes:
 *   pnpm --filter @datascribe/medical-data record-fixtures
 * Sends short synthetic clinical terms and codes only. No API key is used, so none is recorded.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMedicalData, type FetchLike } from '../src';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
mkdirSync(dir, { recursive: true });

let name = '';
const recording: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep as text
  }
  writeFileSync(
    join(dir, `${name}.json`),
    `${JSON.stringify({ recordedAt: new Date().toISOString(), request: { url }, response: { status: res.status, body } }, null, 2)}\n`,
  );
  console.log(`${name}: HTTP ${res.status}`);
  return new Response(text, { status: res.status, headers: res.headers });
};

const md = createMedicalData({ provider: 'nlm', fetch: recording, retry: { retries: 0 } });

const steps: [string, () => Promise<unknown>][] = [
  ['icd10cm-lumbar-radiculopathy', () => md.diagnosis.search('lumbar radiculopathy', 5)],
  ['hcpcs-cervical-collar', () => md.procedure.search('cervical collar', 5)],
  ['rxnorm-gabapentin', () => md.medication.normalize('gabapentin')],
  ['openfda-label-gabapentin', () => md.drugInfo.getLabel('gabapentin')],
  [
    'medlineplus-icd10-M54.16',
    () =>
      md.consumerHealth.define({
        system: 'ICD10CM',
        code: 'M54.16',
        display: 'Radiculopathy, lumbar region',
        source: '',
      }),
  ],
];

for (const [n, run] of steps) {
  name = n;
  const out = await run();
  console.log(`${n}: ${JSON.stringify(out).slice(0, 160)}`);
}
