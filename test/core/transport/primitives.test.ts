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
    breaker.onAttempt();
    expect(breaker.canRequest()).toBe(false);
    breaker.onFailure();
    expect(breaker.state).toBe('open');
    await clock.advance(1_000);
    breaker.onAttempt();
    breaker.onSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.canRequest()).toBe(true);
  });
});
