import { containerOf } from '../../src/core/container/internals';
import { createMemoryStores } from '../../src/core/store/memory';
import type { Clock } from '../../src/core/util/clock';
import { createFakeEnv, type FakeEnvOptions } from '../../src/testing/env';
import { FakeClock } from '../../src/testing/fake-clock';

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

  it('killPrevious fences a fetch already in flight (unresolved) so the old read never settles', async () => {
    const env = await createFakeEnv();
    // N8: exercises the fetch wrapper directly, rather than through a whole `bc` read, so
    // there's no doubt which fenced call is under test.
    const fetchFn = containerOf(env.aio).runtime.transport.fetch as typeof fetch;
    let settled = false;
    const pending = fetchFn(env.chain.endpoint('main'), {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'fake_blockNumber',
        params: [],
      }),
    });
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // No `await` above: FakeChain's fetch only resolves via a microtask (never a real timer),
    // so by JS's run-to-completion rule the raw fetch call is still genuinely unsettled at
    // this exact point — restart() flips `generation.alive` before any of its `.then()`
    // callbacks get a chance to run.
    await env.restart({ killPrevious: true });
    await env.clock.advance(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
  });

  it("killPrevious fences a Response's body readers even once the Response was already received", async () => {
    const env = await createFakeEnv();
    const fetchFn = containerOf(env.aio).runtime.transport.fetch as typeof fetch;
    const response = await fetchFn(env.chain.endpoint('main'), {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'fake_blockNumber',
        params: [],
      }),
    });

    await env.restart({ killPrevious: true });

    // N4/N2: non-body access still works and doesn't throw "Illegal invocation" — the wrapper
    // runs the real Response's own getters with the real Response as `this`.
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);

    let settled = false;
    response.text().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
  });

  it("killPrevious fences the shared signer's getPublicKey without rebuilding the signer", async () => {
    const env = await createFakeEnv();
    const genSigner = containerOf(env.aio).effective().signers[env.signer.id];
    if (!genSigner) throw new Error('expected the fenced signer to be registered');
    let settled = false;
    const pending = genSigner.getPublicKey('secp256k1-ecdsa');
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await env.restart({ killPrevious: true });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
  });

  it('env.stores is exactly the fenced store instances the container itself uses (N3)', async () => {
    const env = await createFakeEnv();
    const runtimeStores = containerOf(env.aio).runtime.stores;
    expect(runtimeStores.operations).toBe(env.stores.operations);
    expect(runtimeStores.locks).toBe(env.stores.locks);
    expect(runtimeStores.sequences).toBe(env.stores.sequences);
    expect(runtimeStores.cursors).toBe(env.stores.cursors);
  });

  it('N3: the fenced clock/stores/transport always win, even over a forced options.aio', async () => {
    const rogueClock: Clock = {
      now: () => 0,
      sleep: () => new Promise(() => undefined),
    };
    const rogueStores = createMemoryStores(new FakeClock());
    const env = await createFakeEnv({
      // FakeEnvOptions['aio'] excludes clock/stores/transport at the type level; this cast
      // simulates a caller that forces them through anyway, to prove the runtime merge order
      // (not just the type system) is what actually protects the fence.
      aio: { clock: rogueClock, stores: rogueStores } as unknown as FakeEnvOptions['aio'],
    });
    const runtime = containerOf(env.aio).runtime;
    expect(runtime.clock).not.toBe(rogueClock);
    expect(runtime.stores.operations).not.toBe(rogueStores.operations);
    expect(runtime.stores.operations).toBe(env.stores.operations);
  });
});
