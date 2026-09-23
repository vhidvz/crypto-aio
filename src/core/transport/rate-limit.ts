import { ConfigError } from '../errors/error';
import type { Clock } from '../util/clock';

export class TokenBucket {
  #tokens: number;
  #updatedAt: number;

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

  async take(signal?: AbortSignal): Promise<void> {
    while (!this.tryTake()) await this.clock.sleep(this.msUntilToken(), signal);
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
