export type CallOutcome = 'ok' | 'cache_hit' | 'error' | 'breaker_open' | 'disabled';

export interface ProviderUsage {
  provider: string;
  /** Calls that reached (or tried to reach) the provider: ok + error. */
  calls: number;
  errors: number;
  /** errors / calls, 0 when there were no calls. */
  errorRate: number;
  cacheHits: number;
  /** Requests answered "uncoded" without calling: breaker open or provider disabled. */
  skipped: number;
  avgLatencyMs: number | null;
}

interface Event {
  at: number;
  provider: string;
  outcome: CallOutcome;
  latencyMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Per-process provider call counters for the admin settings page (§8.4: last-24h call counts and
 * error rates). Holds provider name, time, outcome and latency only, never the term.
 */
export class UsageTracker {
  private events: Event[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly retentionMs = DAY_MS,
  ) {}

  record(provider: string, outcome: CallOutcome, latencyMs?: number) {
    this.events.push({ at: this.now(), provider, outcome, latencyMs });
    // prune occasionally so memory stays bounded by one window of traffic
    if (this.events.length % 500 === 0) this.prune();
  }

  private prune() {
    const cutoff = this.now() - this.retentionMs;
    this.events = this.events.filter((e) => e.at >= cutoff);
  }

  /** Stats per provider over the last `windowMs` (default 24 h). Known providers with no traffic are included. */
  stats(windowMs = DAY_MS, providers: string[] = []): ProviderUsage[] {
    this.prune();
    const cutoff = this.now() - windowMs;
    const by = new Map<string, ProviderUsage & { latencySum: number; latencyN: number }>();
    const row = (provider: string) => {
      let r = by.get(provider);
      if (!r) {
        r = {
          provider,
          calls: 0,
          errors: 0,
          errorRate: 0,
          cacheHits: 0,
          skipped: 0,
          avgLatencyMs: null,
          latencySum: 0,
          latencyN: 0,
        };
        by.set(provider, r);
      }
      return r;
    };
    for (const p of providers) row(p);
    for (const e of this.events) {
      if (e.at < cutoff) continue;
      const r = row(e.provider);
      if (e.outcome === 'ok' || e.outcome === 'error') {
        r.calls += 1;
        if (e.outcome === 'error') r.errors += 1;
        if (e.latencyMs !== undefined) {
          r.latencySum += e.latencyMs;
          r.latencyN += 1;
        }
      } else if (e.outcome === 'cache_hit') r.cacheHits += 1;
      else r.skipped += 1;
    }
    return [...by.values()]
      .map(({ latencySum, latencyN, ...r }) => ({
        ...r,
        errorRate: r.calls ? r.errors / r.calls : 0,
        avgLatencyMs: latencyN ? Math.round(latencySum / latencyN) : null,
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }
}
