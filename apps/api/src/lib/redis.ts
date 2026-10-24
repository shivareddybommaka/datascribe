import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import { Redis } from 'ioredis';

/**
 * Shared Redis client for the API (rate limits, D-111). Commands fail fast while Redis is down
 * instead of queueing for seconds; the limiter then answers 500, never "allowed" (fail closed).
 */
export function createRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    enableAutoPipelining: true,
    lazyConnect: false,
  });
}

// INCR, start the window on the first hit, return the count and the time left.
const INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return { hits, ttl }
`;

// DECR only an existing counter, so a late decrement never creates a key without a TTL.
const DECREMENT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('DECR', KEYS[1]) end
return 0
`;

/**
 * express-rate-limit store on Redis: one fixed window per key, shared by every API process
 * (D-111). Keys are `<keyPrefix>rl:<limiter>:<client key>`; client keys are IPs or hashed
 * account ids (D-101), never an email in clear.
 */
export class RedisRateLimitStore implements Store {
  /** counts are shared across processes */
  localKeys = false;
  prefix: string;
  private windowMs = 60_000;

  constructor(
    private readonly redis: Redis,
    limiter: string,
    keyPrefix = '',
  ) {
    this.prefix = `${keyPrefix}rl:${limiter}:`;
  }

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const [hits, ttl] = (await this.redis.eval(
      INCREMENT,
      1,
      this.prefix + key,
      String(this.windowMs),
    )) as [number, number];
    return { totalHits: hits, resetTime: new Date(Date.now() + ttl) };
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const k = this.prefix + key;
    const [hits, ttl] = await Promise.all([this.redis.get(k), this.redis.pttl(k)]);
    if (hits === null || ttl < 0) return undefined;
    return { totalHits: Number(hits), resetTime: new Date(Date.now() + ttl) };
  }

  async decrement(key: string): Promise<void> {
    await this.redis.eval(DECREMENT, 1, this.prefix + key);
  }

  async resetKey(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }
}
