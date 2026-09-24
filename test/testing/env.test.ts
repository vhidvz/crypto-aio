import { containerOf } from '../../src/core/container/internals';
import { createFakeEnv } from '../../src/testing/env';

describe('createFakeEnv restart()', () => {
  it('keeps the previous generation alive by default and shares durable state', async () => {
    const env = await createFakeEnv({ fund: 5_000_000n });
    env.chain.mine(3);
    const restarted = await env.restart();

    expect(restarted).not.toBe(env);
    expect(restarted.aio).not.toBe(env.aio);
    expect(restarted.clock).toBe(env.clock);
    expect(restarted.chain).toBe(env.chain);
    expect(restarted.signer).toBe(env.signer);

    // Durable state (chain + stores) is shared, not copied.
    expect(await restarted.run(restarted.bc.getBlockHeight())).toBe(3n);
    await restarted.stores.cursors.put('k', { height: 1n, hash: 'h', recent: [] }, null);
    const seenFromOld = await env.stores.cursors.get('k');
    expect(seenFromOld?.cursor.height).toBe(1n);

    // The old generation still works after a plain restart() (no kill).
    expect(await env.run(env.bc.getBlockHeight())).toBe(3n);
  });

  it('killPrevious fences a clock.sleep already in flight so it never settles', async () => {
    const env = await createFakeEnv();
    const genClock = containerOf(env.aio).runtime.clock;
    let settled = false;
    const sleeping = genClock.sleep(1_000);
    sleeping.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await env.restart({ killPrevious: true });
    await env.clock.advance(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
  });

  it("killPrevious fences an old handle's pending read so it never settles", async () => {
    const env = await createFakeEnv();
    let state: 'pending' | 'settled' = 'pending';
    const pending = env.bc.getBlockHeight();
    pending.then(
      () => {
        state = 'settled';
      },
      () => {
        state = 'settled';
      },
    );

    const restarted = await env.restart({ killPrevious: true });
    const newGenClock = containerOf(restarted.aio).runtime.clock;
    const winner = await restarted.run(
      Promise.race([
        pending.then(() => 'old' as const),
        newGenClock.sleep(50).then(() => 'timeout' as const),
      ]),
    );

    expect(winner).toBe('timeout');
    expect(state).toBe('pending');

    // The new generation itself works normally.
    expect(await restarted.run(restarted.bc.getBlockHeight())).toBe(0n);
  });

  it("killPrevious fences an old generation's store calls so they never settle", async () => {
    const env = await createFakeEnv();
    let settled = false;
    const pending = env.stores.cursors.get('nope');
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    const restarted = await env.restart({ killPrevious: true });
    const newGenClock = containerOf(restarted.aio).runtime.clock;
    const winner = await restarted.run(
      Promise.race([
        pending.then(() => 'old' as const),
        newGenClock.sleep(50).then(() => 'timeout' as const),
      ]),
    );

    expect(winner).toBe('timeout');
    expect(settled).toBe(false);
  });
});
