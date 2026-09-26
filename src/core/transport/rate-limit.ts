import { ConfigError } from '../errors/error';
import type { Clock } from '../util/clock';

export class TokenBucket {
  #tokens: number;
  #updatedAt: number;
  /** Priority takers waiting now (A17). */
  #priorityWaiting = 0;

  constructor(
    private readonly rps: number,
    private readonly burst: number,
    private readonly clock: Clock,
  ) {
    if (!(rps > 0) || !(burst >= 1)) {
      throw new ConfigError('CONFIG_INVALID', 'rate limit needs rps > 0 and burst >= 1');
    }
    this.#tokens = burst;
    this.#updatedAt = clock.now();
  }

  tryTake(): boolean {
    this.#refill();
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return true;
    }
    return false;
  }

  msUntilToken(): number {
    this.#refill();
    return this.#tokens >= 1 ? 0 : Math.ceil(((1 - this.#tokens) * 1_000) / this.rps);
  }

  /**
   * Waits for a token. A17: a `priority` taker (a health probe) goes ahead of every waiting
   * ordinary taker, which leaves the next token to it, so a queue of requests never starves
   * a probe past its deadline. Every token is still taken here: priority only reorders.
   */
  async take(signal?: AbortSignal, priority = false): Promise<void> {
    if (priority) this.#priorityWaiting += 1;
    try {
      while ((!priority && this.#priorityWaiting > 0) || !this.tryTake()) {
        await this.clock.sleep(this.msUntilToken(), signal);
      }
    } finally {
      if (priority) this.#priorityWaiting -= 1;
    }
  }

  #refill(): void {
    const now = this.clock.now();
    const elapsed = now - this.#updatedAt;
    if (elapsed > 0) {
      this.#tokens = Math.min(this.burst, this.#tokens + (elapsed * this.rps) / 1_000);
      this.#updatedAt = now;
    }
  }
}
