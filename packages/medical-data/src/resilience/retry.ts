/** Non-2xx response from a provider. */
export class HttpStatusError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
  }
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

export interface RetryOptions {
  /** Retries after the first attempt (§8.4: 3). */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** 0..1 random source for jitter; injectable for tests. */
  random?: () => number;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown) => void;
}

export const DEFAULT_RETRY: RetryOptions = { retries: 3, baseDelayMs: 250, maxDelayMs: 4000 };

/** Network errors, timeouts, 408, 429 and 5xx are worth retrying; other 4xx are not. */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof HttpStatusError) {
    return err.status === 408 || err.status === 429 || err.status >= 500;
  }
  return true;
}

/** Exponential backoff with "equal jitter": base * 2^n, half fixed and half random, capped. */
export function backoffDelay(attempt: number, opts: RetryOptions): number {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  const random = opts.random ?? Math.random;
  return Math.round(exp / 2 + random() * (exp / 2));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retryable = opts.isRetryable ?? isRetryableError;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.retries || !retryable(err)) throw err;
      opts.onRetry?.(attempt + 1, err);
      await sleep(backoffDelay(attempt, opts));
    }
  }
}
