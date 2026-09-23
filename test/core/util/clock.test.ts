import { systemClock } from '../../../src/core/util/clock';
import { FakeClock, drive } from '../../../src/testing/fake-clock';

describe('systemClock', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort(new Error('stop'));
    await expect(systemClock.sleep(10_000, ctl.signal)).rejects.toThrow('stop');
  });

  it('rejects when aborted while sleeping', async () => {
    const ctl = new AbortController();
    const p = systemClock.sleep(10_000, ctl.signal);
    ctl.abort(new Error('late'));
    await expect(p).rejects.toThrow('late');
  });
});

describe('FakeClock', () => {
  it('wakes sleepers in due order when advanced', async () => {
    const clock = new FakeClock(1000);
    const order: number[] = [];
    void clock.sleep(30).then(() => order.push(30));
    void clock.sleep(10).then(() => order.push(10));
    await clock.advance(20);
    expect(order).toEqual([10]);
    expect(clock.now()).toBe(1020);
    await clock.advance(20);
    expect(order).toEqual([10, 30]);
    expect(clock.pending).toBe(0);
  });

  it('supports abort', async () => {
    const clock = new FakeClock();
    const ctl = new AbortController();
    const p = clock.sleep(100, ctl.signal);
    ctl.abort(new Error('cancelled'));
    await expect(p).rejects.toThrow('cancelled');
    expect(clock.pending).toBe(0);
  });

  it('drives a promise to completion with fake time', async () => {
    const clock = new FakeClock(0);
    const value = await drive(
      clock,
      clock.sleep(1_000).then(() => 'done'),
      100,
    );
    expect(value).toBe('done');
    expect(clock.now()).toBeGreaterThanOrEqual(1_000);
    await expect(drive(clock, Promise.reject(new Error('nope')))).rejects.toThrow('nope');
  });

  it('runs chained sleeps scheduled while advancing', async () => {
    const clock = new FakeClock(0);
    let done = false;
    void (async () => {
      await clock.sleep(5);
      await clock.sleep(5);
      done = true;
    })();
    await clock.advance(10);
    expect(done).toBe(true);
  });
});
