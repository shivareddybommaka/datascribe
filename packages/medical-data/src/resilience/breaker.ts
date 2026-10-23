export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerConfig {
  /** Consecutive failed calls (after retries) that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before one trial call is let through. */
  openMs: number;
}

export const DEFAULT_BREAKER: BreakerConfig = { failureThreshold: 5, openMs: 60_000 };

/**
 * Classic three-state circuit breaker. While open, callers skip the provider and fall back to
 * "uncoded" (§8.4), so a provider outage slows nothing down and never fails a case.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private _state: BreakerState = 'closed';
  private trialInFlight = false;

  constructor(
    private readonly config: BreakerConfig = DEFAULT_BREAKER,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): BreakerState {
    if (this._state === 'open' && this.now() - this.openedAt >= this.config.openMs) {
      this._state = 'half_open';
      this.trialInFlight = false;
    }
    return this._state;
  }

  /** May a call go through now? In half-open state only one trial call is allowed at a time. */
  allow(): boolean {
    const s = this.state;
    if (s === 'closed') return true;
    if (s === 'half_open' && !this.trialInFlight) {
      this.trialInFlight = true;
      return true;
    }
    return false;
  }

  success() {
    this.failures = 0;
    this._state = 'closed';
    this.trialInFlight = false;
  }

  failure() {
    this.failures += 1;
    if (this._state === 'half_open' || this.failures >= this.config.failureThreshold) {
      this._state = 'open';
      this.openedAt = this.now();
      this.trialInFlight = false;
    }
  }
}
