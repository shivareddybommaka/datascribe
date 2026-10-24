import { Redis } from 'ioredis';

export type CallOutcome = 'ok' | 'cache_hit' | 'error' | 'breaker_open' | 'disabled';
const OUTCOMES: readonly CallOutcome[] = ['ok', 'cache_hit', 'error', 'breaker_open', 'disabled'];

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

/**
 * Provider call counters for the admin settings page (§8.4: last-24h call counts and error rates).
 * Holds provider name, time, outcome and latency only, never the term.
 */
export interface UsageStore {
  /** Never throws and never waits: a counter must not slow down or fail a lookup. */
  record(provider: string, outcome: CallOutcome, latencyMs?: number): void;
  /** Stats per provider over the last `windowMs` (default 24 h). Known providers with no traffic are included. */
  stats(windowMs?: number, providers?: string[]): Promise<ProviderUsage[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Raw counts for one provider; both stores sum into these. */
interface Counts {
  outcomes: Record<CallOutcome, number>;
  latencySum: number;
  latencyN: number;
}

const emptyCounts = (): Counts => ({
  outcomes: { ok: 0, cache_hit: 0, error: 0, breaker_open: 0, disabled: 0 },
  latencySum: 0,
  latencyN: 0,
});

function summarise(by: Map<string, Counts>): ProviderUsage[] {
  return [...by.entries()]
    .map(([provider, c]) => {
      const calls = c.outcomes.ok + c.outcomes.error;
      return {
        provider,
        calls,
        errors: c.outcomes.error,
        errorRate: calls ? c.outcomes.error / calls : 0,
        cacheHits: c.outcomes.cache_hit,
        skipped: c.outcomes.breaker_open + c.outcomes.disabled,
        avgLatencyMs: c.latencyN ? Math.round(c.latencySum / c.latencyN) : null,
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

function rows(providers: Iterable<string>): Map<string, Counts> {
  return new Map([...providers].map((p) => [p, emptyCounts()]));
}

interface Event {
  at: number;
  provider: string;
  outcome: CallOutcome;
  latencyMs?: number;
}

/** In-process counters: tests, and processes without Redis. */
export class UsageTracker implements UsageStore {
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

  async stats(windowMs = DAY_MS, providers: string[] = []): Promise<ProviderUsage[]> {
    this.prune();
    const cutoff = this.now() - windowMs;
    const by = rows(providers);
    for (const e of this.events) {
      if (e.at < cutoff) continue;
      let c = by.get(e.provider);
      if (!c) by.set(e.provider, (c = emptyCounts()));
      c.outcomes[e.outcome] += 1;
      if ((e.outcome === 'ok' || e.outcome === 'error') && e.latencyMs !== undefined) {
        c.latencySum += e.latencyMs;
        c.latencyN += 1;
      }
    }
    return summarise(by);
  }
}

const BUCKET_MS = 60_000;

export interface RedisUsageOptions {
  /** key namespace shared by the API and worker of one deployment (REDIS_KEY_PREFIX) */
  prefix?: string;
  now?: () => number;
  retentionMs?: number;
  /** a failed write or connection error, at most once a minute; error name only (no values) */
  onError?: (errName: string) => void;
}

/**
 * Counters in Redis, so the API and every worker process add to the same numbers and the admin
 * page sees all of them (D-112). One hash per provider per minute
 * (`<prefix>usage:<provider>:<minute>`: outcome counts, latency sum and count), expiring a little
 * after the retention window, plus a set of providers seen.
 */
export class RedisUsageTracker implements UsageStore {
  private readonly prefix: string;
  private readonly now: () => number;
  private readonly retentionMs: number;

  constructor(
    private readonly redis: Redis,
    private readonly opts: RedisUsageOptions = {},
  ) {
    this.prefix = `${opts.prefix ?? ''}usage:`;
    this.now = opts.now ?? Date.now;
    this.retentionMs = opts.retentionMs ?? DAY_MS;
  }

  /** For processes that have no Redis client of their own (the worker). */
  static connect(url: string, opts: RedisUsageOptions = {}): RedisUsageTracker {
    const redis = new Redis(url, { maxRetriesPerRequest: 1, enableAutoPipelining: true });
    const tracker = new RedisUsageTracker(redis, opts);
    redis.on('error', (err: Error) => tracker.report(err.name));
    return tracker;
  }

  private lastReport = -Infinity;
  /** a Redis outage fails every call; one line a minute is enough */
  private report(errName: string) {
    const now = this.now();
    if (now - this.lastReport < BUCKET_MS) return;
    this.lastReport = now;
    this.opts.onError?.(errName);
  }

  async close() {
    this.redis.disconnect();
  }

  private bucketKey(provider: string, bucket: number) {
    return `${this.prefix}${provider}:${bucket}`;
  }

  record(provider: string, outcome: CallOutcome, latencyMs?: number) {
    const key = this.bucketKey(provider, Math.floor(this.now() / BUCKET_MS));
    const m = this.redis.multi().hincrby(key, outcome, 1);
    if ((outcome === 'ok' || outcome === 'error') && latencyMs !== undefined) {
      m.hincrby(key, 'lat_sum', Math.round(latencyMs)).hincrby(key, 'lat_n', 1);
    }
    m.pexpire(key, this.retentionMs + 2 * BUCKET_MS).sadd(`${this.prefix}providers`, provider);
    m.exec().catch((err: Error) => this.report(err.name));
  }

  /** Minute resolution: the oldest minute counts whole if any of it is inside the window. */
  async stats(windowMs = DAY_MS, providers: string[] = []): Promise<ProviderUsage[]> {
    const seen = await this.redis.smembers(`${this.prefix}providers`);
    const by = rows(new Set([...providers, ...seen]));
    const last = Math.floor(this.now() / BUCKET_MS);
    const first = Math.floor((this.now() - Math.min(windowMs, this.retentionMs)) / BUCKET_MS);
    const keys: [string, string][] = [];
    for (const provider of by.keys()) {
      for (let b = first; b <= last; b++) keys.push([provider, this.bucketKey(provider, b)]);
    }
    const p = this.redis.pipeline();
    for (const [, key] of keys) p.hgetall(key);
    const results = (await p.exec()) ?? [];
    results.forEach(([err, value], i) => {
      if (err) throw err;
      const h = value as Record<string, string>;
      const c = by.get(keys[i]![0])!;
      for (const o of OUTCOMES) c.outcomes[o] += Number(h[o] ?? 0);
      c.latencySum += Number(h.lat_sum ?? 0);
      c.latencyN += Number(h.lat_n ?? 0);
    });
    return summarise(by);
  }
}
