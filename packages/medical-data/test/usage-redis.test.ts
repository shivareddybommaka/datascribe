import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { RedisUsageTracker, UsageTracker, createMedicalData } from '../src';
import { fakeClock } from './helpers';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

/** Reachable Redis or a clear skip; in CI a missing Redis fails the run instead (D-112). */
async function connect(): Promise<Redis | null> {
  const r = new Redis(TEST_REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  try {
    await r.connect();
    await r.ping();
    return r;
  } catch {
    r.disconnect();
    if (process.env.CI) throw new Error('CI needs Redis at TEST_REDIS_URL for the D-112 tests');
    console.warn(`[usage-redis] Redis not reachable at ${TEST_REDIS_URL}; tests skipped`);
    return null;
  }
}

const redis = await connect();
const prefix = `test-${randomUUID()}:`;
const clients: Redis[] = [];
/** a separate connection per tracker, like separate API and worker processes */
const client = () => {
  const c = new Redis(TEST_REDIS_URL);
  clients.push(c);
  return c;
};

afterAll(async () => {
  for (const c of clients) c.disconnect();
  if (!redis) return;
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
});

describe.skipIf(!redis)('RedisUsageTracker (D-112)', () => {
  it('API and worker processes add to the same counters', async () => {
    const c = fakeClock();
    const api = new RedisUsageTracker(client(), { prefix, now: c.now });
    const worker = new RedisUsageTracker(client(), { prefix, now: c.now });
    api.record('openfda', 'ok', 100);
    worker.record('openfda', 'error', 300);
    worker.record('openfda', 'cache_hit');
    api.record('nlm-ctss', 'breaker_open');
    worker.record('nlm-ctss', 'disabled');
    await worker.stats(); // same connection: its writes are applied before this read
    const stats = await api.stats(undefined, ['medlineplus']);
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
        skipped: 2,
        avgLatencyMs: null,
      },
      {
        provider: 'openfda',
        calls: 2,
        errors: 1,
        errorRate: 0.5,
        cacheHits: 1,
        skipped: 0,
        avgLatencyMs: 200,
      },
    ]);
  });

  it('matches the in-memory tracker for the last 24 h and lets old minutes expire', async () => {
    const c = fakeClock();
    const r = new RedisUsageTracker(client(), { prefix: `${prefix}win:`, now: c.now });
    const m = new UsageTracker(c.now);
    const both = (outcome: 'ok' | 'error', ms: number) => {
      r.record('nlm-rxnav', outcome, ms);
      m.record('nlm-rxnav', outcome, ms);
    };
    both('ok', 10);
    c.advance(25 * 60 * 60 * 1000); // the first call falls out of the window
    both('ok', 20);
    c.advance(150_000); // > 2 minutes, so minute rounding can't pull it into a 1-minute window
    both('error', 41);
    expect(await r.stats()).toEqual(await m.stats());
    expect((await r.stats())[0]).toMatchObject({ calls: 2, errors: 1, avgLatencyMs: 31 });
    // a shorter window, minute resolution
    expect((await r.stats(60_000))[0]).toMatchObject({ calls: 1 });
    // every bucket expires a little after the retention window; terms are never stored
    const keys = await redis!.keys(`${prefix}win:usage:nlm-rxnav:*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      const ttl = await redis!.pttl(k);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 120_000);
      for (const field of Object.keys(await redis!.hgetall(k))) {
        expect([
          'ok',
          'error',
          'cache_hit',
          'breaker_open',
          'disabled',
          'lat_sum',
          'lat_n',
        ]).toContain(field);
      }
    }
  });

  it('feeds createMedicalData, whose usageStats lists every upstream', async () => {
    const usage = new RedisUsageTracker(client(), { prefix: `${prefix}md:` });
    const md = createMedicalData({ provider: 'nlm', usage, fetch: async () => new Response('[]') });
    const stats = await md.usageStats();
    expect(stats.map((s) => s.provider)).toEqual([
      'medlineplus',
      'nlm-ctss',
      'nlm-rxnav',
      'openfda',
    ]);
  });

  it('keeps prefixes apart', async () => {
    const a = new RedisUsageTracker(client(), { prefix: `${prefix}a:` });
    const b = new RedisUsageTracker(client(), { prefix: `${prefix}b:` });
    a.record('openfda', 'ok', 5);
    await a.stats();
    expect(await b.stats()).toEqual([]);
  });
});

describe('RedisUsageTracker when Redis is down (D-112)', () => {
  it('recording never throws and reports at most once a minute; stats reject', async () => {
    const onError = vi.fn();
    const usage = RedisUsageTracker.connect('redis://127.0.0.1:1/0', { onError });
    try {
      for (let i = 0; i < 20; i++) expect(() => usage.record('openfda', 'ok', 1)).not.toThrow();
      await expect(usage.stats()).rejects.toThrow();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(typeof onError.mock.calls[0]![0]).toBe('string');
    } finally {
      await usage.close();
    }
  });
});
