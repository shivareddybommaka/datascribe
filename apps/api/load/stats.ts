/** Pure helpers for the load test (`pnpm load`): percentiles and report lines. No I/O. */

/** Nearest-rank percentile of an unsorted sample, in the sample's unit; 0 for an empty sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export type RunStats = {
  label: string;
  connections: number;
  durationS: number;
  latenciesMs: number[];
  /** HTTP status → count */
  statuses: Record<string, number>;
  /** connection errors and timeouts (no HTTP response) */
  errors: number;
};

export type Summary = {
  label: string;
  connections: number;
  requests: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  non2xx: number;
  errors: number;
};

export function summarise(run: RunStats): Summary {
  const requests = Object.values(run.statuses).reduce((a, b) => a + b, 0);
  const non2xx = Object.entries(run.statuses)
    .filter(([code]) => !code.startsWith('2'))
    .reduce((a, [, n]) => a + n, 0);
  return {
    label: run.label,
    connections: run.connections,
    requests,
    rps: run.durationS > 0 ? requests / run.durationS : 0,
    p50: percentile(run.latenciesMs, 50),
    p95: percentile(run.latenciesMs, 95),
    p99: percentile(run.latenciesMs, 99),
    non2xx,
    errors: run.errors,
  };
}

const ms = (v: number) => `${v.toFixed(1)}`;

/** One Markdown table row per run: only counts and timings, never response bodies. */
export function tableRows(rows: Summary[]): string[] {
  return [
    '| route | conns | requests | req/s | p50 ms | p95 ms | p99 ms | non-2xx | errors |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (r) =>
        `| ${r.label} | ${r.connections} | ${r.requests} | ${r.rps.toFixed(0)} | ${ms(r.p50)} | ` +
        `${ms(r.p95)} | ${ms(r.p99)} | ${r.non2xx} | ${r.errors} |`,
    ),
  ];
}

/** Only local targets: the load test must never be pointed at a shared or production host. */
export function assertLocalTarget(url: string): URL {
  const u = new URL(url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    throw new Error(`load test only runs against a local API, not ${u.hostname}`);
  }
  if (u.port === '3000') throw new Error('port 3000 is reserved, never use it');
  return u;
}

/** "1,10,50" → [1, 10, 50] */
export function parseLevels(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  const levels = raw.split(',').map((s) => Number(s.trim()));
  if (levels.some((n) => !Number.isInteger(n) || n < 1 || n > 500)) {
    throw new Error('LOAD_CONNECTIONS must be comma-separated integers from 1 to 500');
  }
  return levels;
}
