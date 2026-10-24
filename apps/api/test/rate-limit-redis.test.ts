import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { RedisRateLimitStore, createRedis } from '../src/lib/redis';
import { TEST_REDIS_URL } from './constants';
import { SEED, buildApp, prisma } from './helpers';

/** Reachable Redis or a clear skip; in CI a missing Redis fails the run instead (D-111). */
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
    if (process.env.CI) throw new Error(`CI needs Redis at TEST_REDIS_URL for the D-111 tests`);
    console.warn(`[rate-limit-redis] Redis not reachable at ${TEST_REDIS_URL}; tests skipped`);
    return null;
  }
}

const redis = await connect();
const prefix = `test-${randomUUID()}:`;
const storeFor = (r: Redis) => (limiter: string) => new RedisRateLimitStore(r, limiter, prefix);
const LIMITS = { windowMs: 60_000, authPerWindow: 2, publicPerWindow: 2, accountPerWindow: 3 };

afterAll(async () => {
  if (!redis) return;
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
});

describe.skipIf(!redis)('rate limits in Redis (D-111)', () => {
  it('two API processes share one per-IP count', async () => {
    const a = buildApp({ rateLimits: LIMITS, rateLimitStore: storeFor(redis!) });
    const b = buildApp({ rateLimits: LIMITS, rateLimitStore: storeFor(redis!) });
    const body = { email: 'nobody@test.example', password: 'x' };
    expect((await request(a.app).post('/api/v1/auth/login').send(body)).status).toBe(401);
    expect((await request(b.app).post('/api/v1/auth/login').send(body)).status).toBe(401);
    const third = await request(a.app).post('/api/v1/auth/login').send(body);
    expect(third.status).toBe(429);
    expect(third.body).toEqual({
      error: { code: 'rate_limited', message: 'Too many requests, try again later' },
    });
    expect(third.headers['ratelimit-policy']).toBe('2;w=60');
    // the window runs from the first hit and expires by itself
    const [key] = await redis!.keys(`${prefix}rl:auth:*`);
    expect(await redis!.get(key!)).toBe('3');
    const ttl = await redis!.pttl(key!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('per-account counts are shared too and keys never hold an email', async () => {
    const limits = { ...LIMITS, authPerWindow: 100 };
    const apps = [1, 2].map(() =>
      buildApp({ rateLimits: limits, rateLimitStore: storeFor(redis!) }),
    );
    const send = (i: number) =>
      request(apps[i % 2]!.app)
        .post('/api/v1/auth/login')
        .send({ email: SEED.harborAdmin, password: 'wrong-password-x' });
    for (let i = 0; i < 3; i++) expect((await send(i)).status).toBe(401);
    expect((await send(3)).status).toBe(429);
    const keys = await redis!.keys(`${prefix}rl:account:*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).toMatch(/rl:account:email:[0-9a-f]{64}$/);
    expect(keys.join()).not.toContain('@');
    expect((await redis!.mget(keys)).map(Number)).toContain(4);
    // undo the failed attempts on the shared seed user
    await prisma.user.update({
      where: { email: SEED.harborAdmin },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  });

  it('limiters count separately under their own names', async () => {
    const store = storeFor(redis!);
    const auth = store('auth-x');
    const pub = store('public-x');
    auth.init({ windowMs: 60_000 } as never);
    pub.init({ windowMs: 60_000 } as never);
    await auth.increment('k');
    await auth.increment('k');
    expect((await pub.increment('k')).totalHits).toBe(1);
    expect((await auth.get('k'))?.totalHits).toBe(2);
    await auth.decrement('k');
    expect((await auth.get('k'))?.totalHits).toBe(1);
    await auth.resetKey('k');
    expect(await auth.get('k')).toBeUndefined();
    // decrementing a missing key doesn't create one without an expiry
    await auth.decrement('k');
    expect(await redis!.exists(`${prefix}rl:auth-x:k`)).toBe(0);
  });
});

describe('rate limits when Redis is down (D-111)', () => {
  it('fail closed: the limited route answers 500, it is never let through', async () => {
    const down = createRedis('redis://127.0.0.1:1/0');
    down.on('error', () => {});
    try {
      const { app, mailer } = buildApp({
        rateLimits: LIMITS,
        rateLimitStore: (limiter) => new RedisRateLimitStore(down, limiter, prefix),
      });
      const res = await request(app).post('/api/v1/auth/forgot').send({ email: SEED.acmeUser });
      expect(res.status).toBe(500);
      expect(mailer.sent).toHaveLength(0);
    } finally {
      down.disconnect();
    }
  });
});
