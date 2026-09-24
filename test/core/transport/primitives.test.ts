import { backoffDelay, parseRetryAfter } from '../../../src/core/transport/backoff';
import { CircuitBreaker } from '../../../src/core/transport/circuit';
import { TokenBucket } from '../../../src/core/transport/rate-limit';
import { FakeClock, settle } from '../../../src/testing/fake-clock';
import { thrown } from '../../helpers';

describe('backoff', () => {
  it('uses capped full jitter', () => {
    const opts = { baseDelayMs: 200, maxDelayMs: 5_000 };
    expect(backoffDelay(0, opts, () => 0.5)).toBe(100);
    expect(backoffDelay(3, opts, () => 0.5)).toBe(800);
    expect(backoffDelay(10, opts, () => 0.5)).toBe(2_500);
    expect(backoffDelay(10, opts, () => 0)).toBe(0);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = Date.parse('2026-09-23T00:00:00Z');
    expect(parseRetryAfter('2', now)).toBe(2_000);
    expect(parseRetryAfter('Wed, 23 Sep 2026 00:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfter('Wed, 23 Sep 2026 00:00:00 GMT', now + 1_000)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it('rejects malformed Retry-After values strictly', () => {
    const now = Date.parse('2026-09-23T00:00:00Z');
    expect(parseRetryAfter('garbage-2030', now)).toBeUndefined();
    expect(parseRetryAfter('-1', now)).toBeUndefined();
    expect(parseRetryAfter('+2', now)).toBeUndefined();
    expect(parseRetryAfter('1.5', now)).toBeUndefined();
    expect(parseRetryAfter(' 5', now)).toBeUndefined();
    expect(parseRetryAfter('99999999999', now)).toBeUndefined(); // 11 digits
    expect(parseRetryAfter('2030-01-01', now)).toBeUndefined();
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 PST', now)).toBeUndefined();
  });

  it('parses valid delta-seconds including zero', () => {
    const now = Date.parse('2026-09-23T00:00:00Z');
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter('120', now)).toBe(120_000);
  });

  it('parses IMF-fixdate correctly', () => {
    const dateStr = 'Wed, 21 Oct 2015 07:28:00 GMT';
    const dateTimestamp = Date.parse(dateStr);
    const fiveSecondsEarlier = dateTimestamp - 5_000;
    expect(parseRetryAfter(dateStr, fiveSecondsEarlier)).toBe(5_000);
    expect(parseRetryAfter(dateStr, dateTimestamp)).toBe(0);
  });

  it('backoff is safe from exponent overflow', () => {
    const opts = { baseDelayMs: 0, maxDelayMs: 100 };
    const result = backoffDelay(2_000, opts, () => 0.5);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100);
  });

  it('backoff respects maxDelayMs with large exponents', () => {
    const opts = { baseDelayMs: 10, maxDelayMs: 100 };
    const result = backoffDelay(100, opts, () => 0.5);
    expect(result).toBeLessThanOrEqual(100);
  });
});

describe('TokenBucket', () => {
  it('allows a burst then refills at the configured rate', async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(2, 1, clock);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    expect(bucket.msUntilToken()).toBe(500);
    let taken = false;
    void bucket.take().then(() => (taken = true));
    await clock.advance(499);
    expect(taken).toBe(false);
    await clock.advance(1);
    await settle();
    expect(taken).toBe(true);
  });

  it('rejects non-positive rates', () => {
    expect(thrown(() => new TokenBucket(0, 1, new FakeClock()))).toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold, half-opens after openMs and closes on a successful probe', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, openMs: 1_000 }, clock);
    breaker.onFailure();
    expect(breaker.state).toBe('closed');
    breaker.onFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.canRequest()).toBe(false);
    await clock.advance(1_000);
    expect(breaker.state).toBe('half-open');
    expect(breaker.canRequest()).toBe(true);
    // #4 (round 3): onAttempt() returns true when it took the half-open probe slot.
    expect(breaker.onAttempt()).toBe(true);
    expect(breaker.canRequest()).toBe(false);
    breaker.onFailure();
    expect(breaker.state).toBe('open');
    await clock.advance(1_000);
    expect(breaker.onAttempt()).toBe(true);
    breaker.onSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.canRequest()).toBe(true);
  });

  // #4 (round 3): onAttempt() returns false when there's no half-open slot to take.
  it('onAttempt returns false when the breaker is closed', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, openMs: 1_000 }, clock);
    expect(breaker.state).toBe('closed');
    expect(breaker.onAttempt()).toBe(false);
    expect(breaker.canRequest()).toBe(true);
  });

  // #2 (round 4): only the attempt that actually takes the half-open slot owns it.
  it('a second onAttempt() while probing returns false', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1_000 }, clock);
    breaker.onFailure();
    await clock.advance(1_000);
    expect(breaker.onAttempt()).toBe(true);
    expect(breaker.onAttempt()).toBe(false);
    expect(breaker.canRequest()).toBe(false);
  });

  // I7: an abandoned half-open probe (e.g. the caller aborted) must not lock the endpoint out.
  it('onAbandon clears a half-open probe without changing state', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1_000 }, clock);
    breaker.onFailure();
    expect(breaker.state).toBe('open');
    await clock.advance(1_000);
    expect(breaker.state).toBe('half-open');
    expect(breaker.onAttempt()).toBe(true);
    expect(breaker.canRequest()).toBe(false);
    breaker.onAbandon();
    expect(breaker.state).toBe('half-open');
    expect(breaker.canRequest()).toBe(true);
  });
});
