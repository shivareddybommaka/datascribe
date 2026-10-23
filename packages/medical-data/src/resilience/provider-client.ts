import { CircuitBreaker, DEFAULT_BREAKER, type BreakerConfig } from './breaker';
import { DEFAULT_CACHE_TTL_MS, requestHash, type CacheStore } from './cache';
import { RateLimitedError, TokenBucket, type RateLimitConfig } from './rate-limit';
import {
  DEFAULT_RETRY,
  HttpStatusError,
  TimeoutError,
  isRetryableError,
  withRetry,
  type RetryOptions,
} from './retry';
import type { CallOutcome, UsageTracker } from './usage';

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

/** pino-compatible subset. */
export interface MedicalLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface ProviderClientOptions {
  provider: string;
  fetch: FetchLike;
  cache: CacheStore;
  usage: UsageTracker;
  rateLimit: RateLimitConfig;
  cacheTtlMs?: number;
  /** Per HTTP attempt (§8.4: 10 s). */
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  breaker?: BreakerConfig;
  logger?: MedicalLogger;
  /** Admin switch (§8.4); a disabled provider answers "uncoded" without calling. */
  isEnabled?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Http {
  /** GET JSON. With `nullOn404`, a 404 means "no match" and resolves to null. */
  getJson(
    url: string,
    opts?: { headers?: Record<string, string>; nullOn404?: boolean },
  ): Promise<unknown>;
}

const USER_AGENT = 'Datascribe-medical-data/1.0';

/**
 * Wraps every real adapter's calls (§8.4): cache → circuit breaker → token bucket → timeout →
 * retries with backoff. On any final failure it returns the caller's "uncoded" fallback instead of
 * throwing. Logs provider, latency and status only: URLs carry the term, so they're never logged.
 */
export class ProviderClient {
  readonly provider: string;
  readonly breaker: CircuitBreaker;
  readonly bucket: TokenBucket;
  private readonly opts: ProviderClientOptions;
  private readonly retry: RetryOptions;
  private readonly now: () => number;

  constructor(opts: ProviderClientOptions) {
    this.opts = opts;
    this.provider = opts.provider;
    this.now = opts.now ?? Date.now;
    this.breaker = new CircuitBreaker(opts.breaker ?? DEFAULT_BREAKER, this.now);
    this.bucket = new TokenBucket(opts.rateLimit, this.now, opts.sleep);
    this.retry = { ...DEFAULT_RETRY, sleep: opts.sleep, ...opts.retry };
  }

  private log(outcome: CallOutcome, latencyMs: number, extra: Record<string, unknown> = {}) {
    this.opts.usage.record(
      this.provider,
      outcome,
      outcome === 'ok' || outcome === 'error' ? latencyMs : undefined,
    );
    const entry = { provider: this.provider, latencyMs, status: outcome, ...extra };
    if (outcome === 'error') this.opts.logger?.warn(entry, 'medical api call failed');
    else this.opts.logger?.info(entry, 'medical api call');
  }

  private readonly http: Http = {
    getJson: async (url, o = {}) => {
      const timeoutMs = this.opts.timeoutMs ?? 10_000;
      await this.bucket.acquire(timeoutMs);
      const ctrl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Race as well as abort, so even a fetch that ignores the signal can't hang the caller.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctrl.abort();
          reject(new TimeoutError(timeoutMs));
        }, timeoutMs);
      });
      const attempt = async () => {
        const res = await this.opts.fetch(url, {
          signal: ctrl.signal,
          headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...o.headers },
        });
        if (res.status === 404 && o.nullOn404) {
          await res.body?.cancel();
          return null;
        }
        if (!res.ok) {
          await res.body?.cancel();
          throw new HttpStatusError(res.status);
        }
        return (await res.json()) as unknown;
      };
      const pending = attempt();
      pending.catch(() => undefined); // a late failure after a timeout is not unhandled
      try {
        return await Promise.race([pending, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };

  /**
   * Run one logical request. `key` identifies it for the cache (normalised + hashed);
   * `fallback` is the "uncoded" answer used when the provider is disabled, open or failing.
   */
  async run<T>(
    key: (string | number | undefined)[],
    call: (http: Http) => Promise<T>,
    fallback: T,
  ): Promise<T> {
    const started = this.now();
    const elapsed = () => this.now() - started;
    if (this.opts.isEnabled && !this.opts.isEnabled()) {
      this.log('disabled', 0);
      return fallback;
    }
    const hash = requestHash(key);
    try {
      const cached = await this.opts.cache.get(this.provider, hash);
      if (cached !== undefined) {
        this.log('cache_hit', elapsed());
        return cached as T;
      }
    } catch {
      // a broken cache must not block coding; fall through to the provider
    }
    if (!this.breaker.allow()) {
      this.log('breaker_open', 0);
      return fallback;
    }
    try {
      const value = await withRetry(() => call(this.http), {
        ...this.retry,
        isRetryable: (e) => !(e instanceof RateLimitedError) && isRetryableError(e),
      });
      this.breaker.success();
      this.log('ok', elapsed());
      try {
        await this.opts.cache.set(
          this.provider,
          hash,
          value,
          this.opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
        );
      } catch {
        // caching is best effort
      }
      return value;
    } catch (err) {
      this.breaker.failure();
      this.log('error', elapsed(), {
        error: err instanceof Error ? err.name : 'Error',
        ...(err instanceof HttpStatusError ? { httpStatus: err.status } : {}),
        breaker: this.breaker.state,
      });
      return fallback;
    }
  }
}
