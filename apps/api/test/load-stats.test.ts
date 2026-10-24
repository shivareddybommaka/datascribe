import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertLocalTarget, parseLevels, percentile, summarise, tableRows } from '../load/stats.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('load test helpers (pnpm load, docs/LOAD-TEST.md)', () => {
  it('computes nearest-rank percentiles', () => {
    const sample = Array.from({ length: 100 }, (_, i) => 100 - i); // 1..100, unsorted
    expect(percentile(sample, 50)).toBe(50);
    expect(percentile(sample, 95)).toBe(95);
    expect(percentile(sample, 99)).toBe(99);
    expect(percentile(sample, 100)).toBe(100);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });

  it('summarises a run with throughput and non-2xx counts', () => {
    const s = summarise({
      label: 'GET /x',
      connections: 10,
      durationS: 10,
      latenciesMs: [1, 2, 3, 4],
      statuses: { '200': 990, '429': 5, '500': 5 },
      errors: 2,
    });
    expect(s).toMatchObject({ requests: 1000, rps: 100, non2xx: 10, errors: 2, p50: 2 });
    const [header, , row] = tableRows([s]);
    expect(header).toContain('p95 ms');
    expect(row).toBe('| GET /x | 10 | 1000 | 100 | 2.0 | 4.0 | 4.0 | 10 | 2 |');
  });

  it('only targets a local API, never port 3000', () => {
    expect(assertLocalTarget('http://localhost:4800').port).toBe('4800');
    expect(() => assertLocalTarget('https://api.datascribe.example')).toThrow(/local API/);
    expect(() => assertLocalTarget('http://localhost:3000')).toThrow(/3000/);
  });

  it('parses connection levels', () => {
    expect(parseLevels(undefined, [1, 10])).toEqual([1, 10]);
    expect(parseLevels('1, 5,50', [])).toEqual([1, 5, 50]);
    expect(() => parseLevels('0,10', [])).toThrow();
    expect(() => parseLevels('ten', [])).toThrow();
  });

  it('is not part of turbo test or CI', () => {
    const api = JSON.parse(read('apps/api/package.json')) as { scripts: Record<string, string> };
    expect(api.scripts.test).not.toContain('load');
    expect(read('apps/api/vitest.config.ts')).not.toContain('load/');
    expect(read('.github/workflows/ci.yml')).not.toMatch(/pnpm (--filter @datascribe\/api )?load/);
    expect(read('turbo.json')).not.toMatch(/"load"/);
  });
});
