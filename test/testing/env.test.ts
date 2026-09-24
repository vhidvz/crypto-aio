import { inspect } from 'node:util';
import { containerOf } from '../../src/core/container/internals';
import { StateError } from '../../src/core/errors/error';
import { callbackSigner } from '../../src/core/signing/callback';
import { localSigner } from '../../src/core/signing/local';
import { createMemoryStores } from '../../src/core/store/memory';
import type { CursorStore } from '../../src/core/store/types';
import type { Clock } from '../../src/core/util/clock';
import { createFakeEnv, type FakeEnvOptions } from '../../src/testing/env';
import { FakeClock } from '../../src/testing/fake-clock';
import { thrown } from '../helpers';

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

  it("N-A: an old generation's async store/signer calls issued after the kill never settle and never throw", async () => {
    const env = await createFakeEnv();
    const oldSigner = containerOf(env.aio).effective().signers[env.signer.id];
    if (!oldSigner) throw new Error('expected the fenced signer to be registered');
    const restarted = await env.restart({ killPrevious: true });

    let storeCall: Promise<unknown> | undefined;
    let signerCall: Promise<unknown> | undefined;
    expect(() => {
      storeCall = env.stores.cursors.get('x');
      signerCall = oldSigner.getPublicKey('secp256k1-ecdsa');
    }).not.toThrow();
    const newGenClock = containerOf(restarted.aio).runtime.clock;
    const settledAs = (name: string) => () => name;
    const winner = await restarted.run(
      Promise.race([
        storeCall?.then(settledAs('store'), settledAs('store')),
        signerCall?.then(settledAs('signer'), settledAs('signer')),
        newGenClock.sleep(50).then(() => 'timeout'),
      ]),
    );
    expect(winner).toBe('timeout');

    // Diagnostics on the dead proxy pass straight through.
    expect(JSON.stringify(oldSigner)).toBe(JSON.stringify(env.signer));
    expect(() => inspect(oldSigner)).not.toThrow();
  });

  it('N-A: a synchronous method on a fenced store throws StateError once the generation is killed; port methods never settle', async () => {
    const memory = createMemoryStores(new FakeClock());
    // Non-`async` arrow functions returning promises: the port allowlist, not the function
    // kind, decides that `get`/`put` are async.
    const cursors = {
      get: (key: string) => memory.cursors.get(key),
      put: (...args: Parameters<CursorStore['put']>) => memory.cursors.put(...args),
      peek: () => 'live',
    };
    const env = await createFakeEnv({ stores: { cursors } });
    const fenced = env.stores.cursors as unknown as typeof cursors;
    expect(fenced.peek()).toBe('live');

    await env.restart({ killPrevious: true });

    expect(thrown(() => fenced.peek())).toBeInstanceOf(StateError);
    let settled = false;
    fenced.get('x').then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
  });

  it('N-B: a signer supplied through options.aio.signers is fenced too, alongside the default one', async () => {
    const cold = localSigner.generate({ curves: ['secp256k1'], id: 'cold' }).signer;
    const env = await createFakeEnv({ aio: { signers: { cold } } });
    const signers = containerOf(env.aio).effective().signers;
    const fencedCold = signers.cold;
    if (!fencedCold) throw new Error('expected the aio signer to be registered');
    expect(fencedCold).not.toBe(cold);
    expect(fencedCold.id).toBe('cold');
    expect(signers[env.signer.id]?.id).toBe(env.signer.id);

    let settled = false;
    fencedCold.getPublicKey('secp256k1-ecdsa').then(
      () => (settled = true),
      () => (settled = true),
    );
    await env.restart({ killPrevious: true });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
  });

  it("N-C: killPrevious fences a Response's clone(), blob() and body stream reads", async () => {
    const env = await createFakeEnv();
    const fetchFn = containerOf(env.aio).runtime.transport.fetch as typeof fetch;
    const post = () =>
      fetchFn(env.chain.endpoint('main'), {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'fake_blockNumber',
          params: [],
        }),
      });
    // While alive, the fenced clone and body stream behave like the real ones.
    const alive = await post();
    expect(JSON.parse(await alive.clone().text())).toMatchObject({ jsonrpc: '2.0' });
    const aliveBody = (await post()).body;
    if (!aliveBody) throw new Error('expected a body');
    const first = await aliveBody.getReader().read();
    expect(first.done).toBe(false);

    const [forClone, forBlob, forReader] = [await post(), await post(), await post()];
    const reader = forReader.body?.getReader();
    if (!reader) throw new Error('expected a body');
    await env.restart({ killPrevious: true });

    const settled: string[] = [];
    const track = (name: string, promise: Promise<unknown>) =>
      promise.then(
        () => settled.push(name),
        () => settled.push(name),
      );
    void track('clone', forClone.clone().text());
    void track('blob', forBlob.blob());
    void track('read', reader.read());
    await env.clock.advance(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toEqual([]);
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

  it('rejects writes through a fenced object instead of dropping them on the stand-in', async () => {
    const env = await createFakeEnv();
    const fenced = containerOf(env.aio).effective().signers[
      env.signer.id
    ] as unknown as Record<string, unknown>;
    const writes: [string, () => unknown][] = [
      ['set', () => (fenced.extra = 1)],
      ['defineProperty', () => Object.defineProperty(fenced, 'extra', { value: 1 })],
      ['deleteProperty', () => delete fenced.id],
    ];
    for (const [trap, write] of writes) {
      const error = thrown(write);
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({ message: expect.stringContaining(`'${trap}'`) });
    }
    expect(fenced.id).toBe(env.signer.id);
    expect(Object.keys(fenced)).not.toContain('extra');
  });

  it('fences a frozen callbackSigner and a frozen store without breaking Proxy invariants', async () => {
    const inner = localSigner.generate({ curves: ['secp256k1'], id: 'inner' }).signer;
    const signer = callbackSigner({
      id: 'custody',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
      sign: (requests, ctx) => inner.sign(requests, ctx),
    });
    expect(Object.isFrozen(signer)).toBe(true);
    const cursors = Object.freeze(createMemoryStores(new FakeClock()).cursors);
    const env = await createFakeEnv({ signer, stores: { cursors } });
    const fenced = containerOf(env.aio).effective().signers.custody;
    if (!fenced) throw new Error('expected the fenced signer to be registered');
    expect(fenced.id).toBe('custody');
    expect(fenced.schemes).toEqual(['secp256k1-ecdsa']);
    expect('getPublicKey' in fenced).toBe(true);
    expect(Object.keys(fenced)).toEqual(Object.keys(signer));
    expect(JSON.stringify(fenced)).toBe(JSON.stringify(signer));
    const cursor = { height: 1n, hash: 'h1', recent: [] };
    expect(await env.stores.cursors.put('k', cursor, null)).toBe(1);
    expect((await env.stores.cursors.get('k'))?.cursor).toEqual(cursor);

    await env.restart({ killPrevious: true });

    let settled = false;
    const settle = () => {
      settled = true;
    };
    fenced.getPublicKey('secp256k1-ecdsa').then(settle, settle);
    env.stores.cursors.get('k').then(settle, settle);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
  });
});
