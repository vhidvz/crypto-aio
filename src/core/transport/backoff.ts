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
  const clamped = Math.min(attempt, 30);
  const cap = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** clamped);
  return Math.floor(random() * cap);
}

/** Parses `Retry-After` (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number,
): number | undefined {
  if (!value) return undefined;
  // Delta-seconds: 1-10 digits only
  if (/^\d{1,10}$/.test(value)) return Number(value) * 1_000;
  // IMF-fixdate (RFC 7231): e.g. "Wed, 21 Oct 2015 07:28:00 GMT"
  if (
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    )
  ) {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return undefined;
    return Math.max(0, at - now);
  }
  return undefined;
}
