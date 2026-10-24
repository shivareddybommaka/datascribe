import { describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  HttpStatusError,
  MemoryCacheStore,
  PrismaCacheStore,
  ProviderClient,
  RateLimitedError,
  TimeoutError,
  TokenBucket,
  UsageTracker,
  backoffDelay,
  isRetryableError,
  requestHash,
  withRetry,
  type FetchLike,
  type MedicalApiCacheDelegate,
} from '../src';
import { fakeClock, json, silentLogger } from './helpers';

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refills at the configured rate', () => {
    const c = fakeClock();
    const b = new TokenBucket({ capacity: 3, refillPerSecond: 2 }, c.now, c.sleep);
    expect([b.tryTake(), b.tryTake(), b.tryTake(), b.tryTake()]).toEqual([true, true, true, false]);
    c.advance(500); // +1 token
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    c.advance(10_000);
    expect(b.available).toBe(3); // capped at capacity
  });

  it('acquire() waits for the next token and queues callers fairly', async () => {
    const c = fakeClock();
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 4 }, c.now, c.sleep);
    await b.acquire();
    await b.acquire();
    await b.acquire();
    expect(c.sleeps).toEqual([250, 250]);
  });

  it('throws RateLimitedError instead of waiting longer than maxWaitMs', async () => {
    const c = fakeClock();
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 0.1 }, c.now, c.sleep);
    await b.acquire();
    await expect(b.acquire(1000)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('rejects invalid configs', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow();
    expect(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow();
  });
});

describe('withRetry', () => {
  const opts = (sleep: (ms: number) => Promise<void>) => ({
    retries: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    sleep,
    random: () => 1,
  });

  it('retries retryable errors 3 times with exponential backoff, then throws', async () => {
    const c = fakeClock();
    const fn = vi.fn(async () => {
      throw new HttpStatusError(503);
    });
    await expect(withRetry(fn, opts(c.sleep))).rejects.toBeInstanceOf(HttpStatusError);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(c.sleeps).toEqual([100, 200, 400]);
  });

  it('returns as soon as an attempt succeeds', async () => {
    const c = fakeClock();
    let n = 0;
    const onRetry = vi.fn();
    const v = await withRetry(
      async () => {
        if (n++ < 2) throw new TypeError('fetch failed');
        return 'ok';
      },
      { ...opts(c.sleep), onRetry },
    );
    expect(v).toBe('ok');
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('does not retry client errors', async () => {
    const c = fakeClock();
    const fn = vi.fn(async () => {
      throw new HttpStatusError(400);
    });
    await expect(withRetry(fn, opts(c.sleep))).rejects.toThrow('HTTP 400');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('classifies errors and caps the delay', () => {
    expect(isRetryableError(new HttpStatusError(429))).toBe(true);
    expect(isRetryableError(new HttpStatusError(408))).toBe(true);
    expect(isRetryableError(new HttpStatusError(500))).toBe(true);
    expect(isRetryableError(new HttpStatusError(404))).toBe(false);
    expect(isRetryableError(new TimeoutError(10))).toBe(true);
    const o = { retries: 3, baseDelayMs: 100, maxDelayMs: 300, random: () => 0 };
    expect(backoffDelay(0, o)).toBe(50);
    expect(backoffDelay(5, o)).toBe(150); // capped at 300, half fixed
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold, half-opens after openMs, closes on a good trial', () => {
    const c = fakeClock();
    const b = new CircuitBreaker({ failureThreshold: 2, openMs: 1000 }, c.now);
    expect(b.allow()).toBe(true);
    b.failure();
    expect(b.state).toBe('closed');
    b.failure();
    expect(b.state).toBe('open');
    expect(b.allow()).toBe(false);
    c.advance(1000);
    expect(b.state).toBe('half_open');
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(false); // one trial at a time
    b.success();
    expect(b.state).toBe('closed');
  });

  it('re-opens when the half-open trial fails', () => {
    const c = fakeClock();
    const b = new CircuitBreaker({ failureThreshold: 1, openMs: 1000 }, c.now);
    b.failure();
    c.advance(1000);
    expect(b.allow()).toBe(true);
    b.failure();
    expect(b.state).toBe('open');
  });

  it('a success resets the consecutive failure count', () => {
    const b = new CircuitBreaker({ failureThreshold: 2, openMs: 1000 });
    b.failure();
    b.success();
    b.failure();
    expect(b.state).toBe('closed');
  });
});

describe('cache stores', () => {
  it('requestHash normalises case and whitespace and hides the term', () => {
    const a = requestHash(['icd10cm', ' Lumbar  Radiculopathy ', 5]);
    expect(a).toBe(requestHash(['icd10cm', 'lumbar radiculopathy', 5]));
    expect(a).not.toBe(requestHash(['icd10cm', 'lumbar radiculopathy', 6]));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('MemoryCacheStore expires entries and returns copies', async () => {
    const c = fakeClock();
    const s = new MemoryCacheStore(c.now);
    const value = [{ code: 'M54.16' }];
    await s.set('p', 'h', value, 1000);
    value[0]!.code = 'changed';
    expect(await s.get('p', 'h')).toEqual([{ code: 'M54.16' }]);
    expect(await s.get('other', 'h')).toBeUndefined();
    c.advance(1000);
    expect(await s.get('p', 'h')).toBeUndefined();
    expect(s.size).toBe(0);
  });

  it('PrismaCacheStore upserts by provider + hash, ignores expired rows, wraps null and purges', async () => {
    const c = fakeClock();
    const rows = new Map<string, { response: unknown; expiresAt: Date }>();
    const delegate: MedicalApiCacheDelegate = {
      findUnique: async ({ where }) =>
        rows.get(
          `${where.provider_requestHash.provider}:${where.provider_requestHash.requestHash}`,
        ) ?? null,
      upsert: async ({ where, create, update }) => {
        const k = `${where.provider_requestHash.provider}:${where.provider_requestHash.requestHash}`;
        rows.set(
          k,
          rows.has(k) ? update : { response: create.response, expiresAt: create.expiresAt },
        );
      },
      deleteMany: async ({ where }) => {
        let count = 0;
        for (const [k, v] of rows) {
          if (v.expiresAt < where.expiresAt.lt) {
            rows.delete(k);
            count++;
          }
        }
        return { count };
      },
    };
    const s = new PrismaCacheStore(delegate, c.now);
    await s.set('openfda', 'h1', null, 1000);
    await s.set('openfda', 'h2', { a: 1 }, 5000);
    await s.set('openfda', 'h2', { a: 2 }, 5000);
    expect(await s.get('openfda', 'h1')).toBeNull();
    expect(await s.get('openfda', 'h2')).toEqual({ a: 2 });
    expect(await s.get('openfda', 'missing')).toBeUndefined();
    c.advance(2000);
    expect(await s.get('openfda', 'h1')).toBeUndefined();
    expect(await s.purgeExpired()).toBe(1);
  });
});

describe('UsageTracker', () => {
  it('reports last-24h calls, errors, error rate, cache hits and skips per provider', async () => {
    const c = fakeClock();
    const u = new UsageTracker(c.now);
    u.record('openfda', 'ok', 100);
    c.advance(25 * 60 * 60 * 1000); // older events fall out of the window
    u.record('openfda', 'ok', 100);
    u.record('openfda', 'error', 300);
    u.record('openfda', 'cache_hit');
    u.record('openfda', 'breaker_open');
    u.record('nlm-ctss', 'disabled');
    const stats = await u.stats(undefined, ['medlineplus']);
    expect(stats).toEqual([
      {
        provider: 'medlineplus',
        calls: 0,
        errors: 0,
        errorRate: 0,
        cacheHits: 0,
        skipped: 0,
        avgLatencyMs: null,
      },
      {
        provider: 'nlm-ctss',
        calls: 0,
        errors: 0,
        errorRate: 0,
        cacheHits: 0,
        skipped: 1,
        avgLatencyMs: null,
      },
      {
        provider: 'openfda',
        calls: 2,
        errors: 1,
        errorRate: 0.5,
        cacheHits: 1,
        skipped: 1,
        avgLatencyMs: 200,
      },
    ]);
  });

  it('prunes old events so memory stays bounded', async () => {
    const c = fakeClock();
    const u = new UsageTracker(c.now, 1000);
    for (let i = 0; i < 1000; i++) {
      u.record('p', 'ok', 1);
      c.advance(10);
    }
    expect((await u.stats(1000))[0]!.calls).toBeLessThanOrEqual(101);
  });
});

describe('ProviderClient', () => {
  function setup(
    fetch: FetchLike,
    extra: Partial<ConstructorParameters<typeof ProviderClient>[0]> = {},
  ) {
    const c = fakeClock();
    const logger = silentLogger();
    const usage = new UsageTracker(c.now);
    const cache = new MemoryCacheStore(c.now);
    const client = new ProviderClient({
      provider: 'test',
      fetch,
      cache,
      usage,
      logger,
      rateLimit: { capacity: 100, refillPerSecond: 100 },
      retry: { random: () => 0 },
      breaker: { failureThreshold: 2, openMs: 60_000 },
      now: c.now,
      sleep: c.sleep,
      ...extra,
    });
    const get = (term = 'neck pain') =>
      client.run(
        ['k', term],
        async (http) => (await http.getJson(`https://x.example/?q=${term}`)) as unknown,
        'UNCODED',
      );
    return { c, logger, usage, cache, client, get };
  }

  it('caches successful responses by normalised request', async () => {
    const fetch = vi.fn(async () => json({ ok: 1 }));
    const { get, usage } = setup(fetch);
    expect(await get('Neck Pain')).toEqual({ ok: 1 });
    expect(await get('neck  pain')).toEqual({ ok: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await usage.stats())[0]).toMatchObject({ calls: 1, cacheHits: 1 });
  });

  it('retries 3 times, then falls back to "uncoded" instead of throwing', async () => {
    const fetch = vi.fn(async () => json({}, 503));
    const { get, c } = setup(fetch);
    expect(await get()).toBe('UNCODED');
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(c.sleeps.length).toBe(3);
  });

  it('times out a hung request after timeoutMs', async () => {
    const fetch: FetchLike = () => new Promise<Response>(() => undefined);
    const { client, logger } = setup(fetch, { timeoutMs: 20, retry: { retries: 0 } });
    const v = await client.run(['t'], (http) => http.getJson('https://x.example/'), 'UNCODED');
    expect(v).toBe('UNCODED');
    expect(logger.lines.at(-1)?.obj).toMatchObject({ status: 'error', error: 'TimeoutError' });
  });

  it('opens the breaker after repeated failures and skips the provider while open', async () => {
    const fetch = vi.fn(async () => json({}, 500));
    const { get, client, c } = setup(fetch, { retry: { retries: 0 } });
    await get('a');
    await get('b');
    expect(client.breaker.state).toBe('open');
    fetch.mockClear();
    expect(await get('c')).toBe('UNCODED');
    expect(fetch).not.toHaveBeenCalled();
    c.advance(60_000);
    fetch.mockImplementation(async () => json({ back: true }));
    expect(await get('d')).toEqual({ back: true });
    expect(client.breaker.state).toBe('closed');
  });

  it('treats 404 as null when asked, and other 4xx as a non-retried failure', async () => {
    const fetch = vi.fn(async () => json({ error: 'nope' }, 404));
    const { client } = setup(fetch);
    expect(
      await client.run(['a'], (h) => h.getJson('https://x.example/a', { nullOn404: true }), 'U'),
    ).toBeNull();
    expect(await client.run(['b'], (h) => h.getJson('https://x.example/b'), 'U')).toBe('U');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns the fallback without calling when the provider is disabled', async () => {
    const fetch = vi.fn(async () => json({}));
    const { get, usage } = setup(fetch, { isEnabled: () => false });
    expect(await get()).toBe('UNCODED');
    expect(fetch).not.toHaveBeenCalled();
    expect((await usage.stats())[0]).toMatchObject({ skipped: 1, calls: 0 });
  });

  it('falls back when the rate limit wait is too long, without retrying', async () => {
    const fetch = vi.fn(async () => json({ ok: 1 }));
    const { get } = setup(fetch, {
      rateLimit: { capacity: 1, refillPerSecond: 0.01 },
      timeoutMs: 1000,
    });
    expect(await get('a')).toEqual({ ok: 1 });
    expect(await get('b')).toBe('UNCODED');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps working when the cache store fails', async () => {
    const fetch = vi.fn(async () => json({ ok: 1 }));
    const broken = {
      get: async () => {
        throw new Error('db down');
      },
      set: async () => {
        throw new Error('db down');
      },
    };
    const { get } = setup(fetch, { cache: broken });
    expect(await get()).toEqual({ ok: 1 });
  });

  it('logs provider, latency and status only, never the term or URL', async () => {
    const fetch = vi.fn(async () => json({ ok: 1 }));
    const { get, logger } = setup(fetch);
    await get('secretterm');
    await get('secretterm');
    expect(logger.lines.map((l) => l.obj.status)).toEqual(['ok', 'cache_hit']);
    for (const l of logger.lines) {
      expect(Object.keys(l.obj).sort()).toEqual(['latencyMs', 'provider', 'status']);
      expect(JSON.stringify(l)).not.toContain('secretterm');
    }
  });

  it('sends JSON accept and user-agent headers and an abort signal', async () => {
    const fetch = vi.fn<FetchLike>(async () => json({}));
    const { get } = setup(fetch);
    await get();
    const init = fetch.mock.calls[0]![1];
    expect(init.headers).toMatchObject({ accept: 'application/json' });
    expect(init.headers['user-agent']).toMatch(/Datascribe/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
