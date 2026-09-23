import { abortReason, type Clock } from '../core/util/clock';

interface Timer {
  readonly at: number;
  readonly seq: number;
  readonly wake: () => void;
}

/** Lets pending promise chains and I/O callbacks run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Deterministic clock for tests: time moves only when `advance` is called. */
export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  #timers: Timer[] = [];

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  get pending(): number {
    return this.#timers.length;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = () => {
        this.#timers = this.#timers.filter((t) => t !== timer);
        reject(abortReason(signal as AbortSignal));
      };
      const timer: Timer = {
        at: this.#now + Math.max(0, ms),
        seq: this.#seq++,
        wake: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#timers.push(timer);
    });
  }

  /** Moves time forward, waking due sleepers in order and settling async work between them. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    await settle();
    for (;;) {
      const due = this.#timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      this.#now = Math.max(this.#now, due.at);
      due.wake();
      await settle();
    }
    this.#now = target;
    await settle();
  }
}

/** Advances `clock` in steps until `promise` settles, then returns its value or rethrows. */
export async function drive<T>(
  clock: FakeClock,
  promise: Promise<T>,
  stepMs = 10,
  maxSteps = 10_000,
): Promise<T> {
  let settled = false;
  const tracked = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );
  tracked.catch(() => undefined);
  await settle();
  for (let i = 0; i < maxSteps && !settled; i++) await clock.advance(stepMs);
  if (!settled)
    throw new Error(`promise did not settle within ${maxSteps * stepMs}ms of fake time`);
  return tracked;
}
