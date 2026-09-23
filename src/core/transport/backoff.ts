export interface BackoffOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** Full-jitter exponential backoff: uniform in [0, min(max, base · 2^attempt)). */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  const cap = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * cap);
}

/** Parses `Retry-After` (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number,
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}
