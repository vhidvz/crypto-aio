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

  /** Returns true when this call actually took the half-open probe slot, so the caller
   * can track ownership of it (e.g. to decide whether it may later abandon it). A slot
   * another attempt already holds is not taken again — false. Known gap: the slot is
   * claimed here, as the request is sent, not when the endpoint is picked, so a second
   * request picked while the slot was free still goes out; claiming it earlier would
   * change how proof reads try a recovering endpoint. */
  onAttempt(): boolean {
    if (this.state !== 'half-open' || this.#probing) return false;
    this.#probing = true;
    return true;
  }

  /** Clears a half-open probe slot without changing state (e.g. the probe was abandoned). */
  onAbandon(): void {
    this.#probing = false;
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
