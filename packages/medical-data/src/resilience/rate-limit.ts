export interface RateLimitConfig {
  /** Burst size. */
  capacity: number;
  /** Sustained rate. */
  refillPerSecond: number;
}

export class RateLimitedError extends Error {
  constructor() {
    super('Rate limit wait exceeds the allowed time');
    this.name = 'RateLimitedError';
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Token bucket per provider. `acquire()` waits for a token; if the wait would exceed
 * `maxWaitMs` it throws RateLimitedError instead, so a backlog can't stall callers forever.
 * Tokens are reserved before waiting, so concurrent callers queue fairly.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
  ) {
    if (config.capacity < 1 || config.refillPerSecond <= 0) {
      throw new Error('TokenBucket needs capacity >= 1 and refillPerSecond > 0');
    }
    this.tokens = config.capacity;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last) / 1000;
    this.tokens = Math.min(
      this.config.capacity,
      this.tokens + elapsed * this.config.refillPerSecond,
    );
    this.last = t;
  }

  /** Take a token without waiting; false when the bucket is empty. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  async acquire(maxWaitMs = 10_000): Promise<void> {
    this.refill();
    const waitMs = this.tokens >= 1 ? 0 : ((1 - this.tokens) / this.config.refillPerSecond) * 1000;
    if (waitMs > maxWaitMs) throw new RateLimitedError();
    this.tokens -= 1; // may go negative: reserves the token for this caller
    if (waitMs > 0) await this.sleep(Math.ceil(waitMs));
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }
}
