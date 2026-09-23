import type { Clock } from '../util/clock';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitOptions {
  readonly failureThreshold: number;
  readonly openMs: number;
}

export class CircuitBreaker {
  #failures = 0;
  #openedAt: number | undefined;
  #probing = false;

  constructor(
    private readonly options: CircuitOptions,
    private readonly clock: Clock,
  ) {}

  get state(): CircuitState {
    if (this.#openedAt === undefined) return 'closed';
    return this.clock.now() - this.#openedAt >= this.options.openMs
      ? 'half-open'
      : 'open';
  }

  canRequest(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    return state === 'half-open' && !this.#probing;
  }

  onAttempt(): void {
    if (this.state === 'half-open') this.#probing = true;
  }

  onSuccess(): void {
    this.#failures = 0;
    this.#openedAt = undefined;
    this.#probing = false;
  }

  onFailure(): void {
    this.#probing = false;
    if (this.state === 'half-open') {
      this.#openedAt = this.clock.now();
      return;
    }
    this.#failures += 1;
    if (this.#failures >= this.options.failureThreshold) {
      this.#openedAt = this.clock.now();
    }
  }
}
