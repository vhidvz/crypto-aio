export interface Clock {
  now(): number;
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
