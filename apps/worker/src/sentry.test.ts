import { describe, expect, it } from 'vitest';
import { initSentry, isFinalAttempt } from './sentry';

describe('worker Sentry (D-119)', () => {
  it('is off without SENTRY_DSN', () => {
    expect(initSentry({ NODE_ENV: 'test' })).toBeUndefined();
    expect(initSentry({ NODE_ENV: 'test', SENTRY_DSN: ' ' })).toBeUndefined();
  });

  it('reports a job only after its last attempt', () => {
    expect(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 3 } })).toBe(false);
    expect(isFinalAttempt({ attemptsMade: 3, opts: { attempts: 3 } })).toBe(true);
    expect(isFinalAttempt({ attemptsMade: 1, opts: {} })).toBe(true);
  });
});
