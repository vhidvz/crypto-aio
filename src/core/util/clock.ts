/**
 * The time source of a container (`AioOptions.clock`), its stores and its transports. A
 * port you may implement: it never gains a required member in a 1.x release.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('The operation was aborted');
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal as AbortSignal));
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        Math.max(0, ms),
      );
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};
