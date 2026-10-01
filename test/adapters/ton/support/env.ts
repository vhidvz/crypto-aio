/**
 * A container on the scripted toncenter node, for end-to-end tests. `restart()` builds a
 * new container over the same stores, node, clock and signer, like `createFakeEnv`'s: a
 * plain restart leaves the old container running beside the new one, and
 * `restart({ killPrevious: true })` first kills the old generation through
 * `fenceGeneration`, so every clock sleep, fetch, store and signer call it makes or has
 * in flight never settles, exactly like a dead process. The killed container is never
 * closed: `close()` would hang on its fenced stores. `aio` and `bc` stay the first
 * container's; `clock`, `stores` and the signer's counter are the raw, unfenced objects:
 * drive time and assert on durable state through them.
 *
 * Determinism, since the flake budget is zero: time is the `FakeClock`'s, the stores run
 * on it (`stores(clock)` builds any replacement on it too), the node's hashes come from
 * counters, and nothing touches the network. Operation and Attempt ids stay random
 * (`randomBytes`), but they only name things: the store orders its work by time. One
 * source is left to the suite: `CryptoAio` builds its transports itself, with no `id` or
 * `random` option, so their backoff jitter falls back to `Math.random`. A suite that uses
 * this env pins it (`jest.spyOn(Math, 'random').mockReturnValue(0.5)` in `beforeEach`,
 * restored in `afterEach`), as `e2e.test.ts` does.
 */
import {
  CryptoAio,
  createLogger,
  type Blockchain,
  type LifecycleOptions,
  type Signer,
  type Stores,
} from '../../../../src';
import { secret } from '../../../../src/core/secret/secret';
import { localSigner } from '../../../../src/core/signing/local';
import { createMemoryStores } from '../../../../src/core/store/memory';
import { drive, type FakeClock } from '../../../../src/testing/fake-clock';
import { fenceGeneration, type Generation } from '../../../../src/testing/generation';
import { testWallet, tonClock } from './harness';
import { ScriptedTonNode, type TonNodeOptions } from './node';
import { KEY } from './vectors';

export interface TonEnvOptions {
  readonly network?: 'mainnet' | 'testnet';
  readonly version?: 'v4r2' | 'v5r1';
  readonly node?: Omit<TonNodeOptions, 'clock' | 'globalId'>;
  /** Nanograms for the test wallet (default 10 GRAM); `0n` leaves it without an account. */
  readonly fund?: bigint;
  /** Stores replacing the memory defaults, built on the env's fake clock. */
  readonly stores?: (clock: FakeClock) => Partial<Stores>;
  readonly signer?: Signer;
  readonly lifecycle?: LifecycleOptions;
}

/** A local signer holding the test key that counts its `sign` calls. */
export function countingSigner(): { readonly signer: Signer; calls(): number } {
  const inner = localSigner({ id: 'hot', ed25519: secret(KEY) });
  let calls = 0;
  const signer: Signer = {
    id: inner.id,
    schemes: inner.schemes,
    getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
    sign: (requests, ctx) => {
      calls += 1;
      return inner.sign(requests, ctx);
    },
  };
  return { signer, calls: () => calls };
}

export async function createTonEnv(options: TonEnvOptions = {}) {
  const network = options.network ?? 'testnet';
  const globalId = network === 'mainnet' ? -239 : -3;
  const version = options.version ?? 'v5r1';
  const clock = tonClock();
  const node = new ScriptedTonNode({ ...options.node, clock, globalId });
  const v2 = node.endpoint('main', 'v2');
  const v3 = node.endpoint('main', 'v3');
  const signer = options.signer ?? countingSigner().signer;
  const stores: Stores = { ...createMemoryStores(clock), ...options.stores?.(clock) };
  const address = testWallet(version, globalId);
  const fund = options.fund ?? 10_000_000_000n;
  if (fund > 0n) node.fund(address, fund);
  /** The codes of every warning any container logged (codes only, as the library logs). */
  const warnings: string[] = [];
  const logger = createLogger('e2e', (level, _namespace, _message, fields) => {
    if (level === 'warn' && typeof fields?.code === 'string') warnings.push(fields.code);
  });

  /** One generation (one simulated process): a container over the fenced shared parts. */
  const assemble = (generation: Generation) => {
    const fenced = fenceGeneration(
      { clock, fetch: node.fetch.fetch, stores, signers: { hot: signer } },
      generation,
    );
    const aio = new CryptoAio({
      env: false,
      logger,
      clock: fenced.clock,
      stores: fenced.stores,
      transport: { fetch: fenced.fetch, baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 5_000 },
      providers: {
        v2: { endpoints: [{ url: v2 }] },
        v3: { endpoints: [{ url: v3, kind: 'indexer' }] },
      },
      signers: fenced.signers,
      wallets: { main: { signer: 'hot', ton: { version } } },
      chains: { ton: { network, provider: 'v2', indexer: 'v3', wallet: 'main' } },
      lifecycle: {
        pollIntervalMs: 1_000,
        droppedGracePeriodMs: 10_000,
        rebroadcastIntervalMs: 5_000,
        waitTimeoutMs: 600_000,
        leaseMs: 30_000,
        claimLeaseMs: 30_000,
        ...options.lifecycle,
      },
    });
    const bc: Blockchain<'ton'> = aio.blockchain({ chain: 'ton' });
    return { aio, bc };
  };

  const run = <T>(promise: Promise<T>, stepMs = 100): Promise<T> =>
    drive(clock, promise, stepMs);
  /**
   * Mines one masterchain block per fake second until `promise` settles; throws after
   * `maxSteps` blocks. The default fits a transfer's way to proven finality (a few blocks)
   * with room to spare, so a stuck wait fails by name, not by Jest's timeout; a scenario that
   * waits out a message's lifetime passes its own budget.
   */
  const mineWhile = async <T>(promise: Promise<T>, maxSteps = 30): Promise<T> => {
    let done = false;
    const tracked = promise.finally(() => {
      done = true;
    });
    tracked.catch(() => undefined);
    for (let i = 0; i < maxSteps && !done; i++) {
      node.mine();
      await clock.advance(1_000);
    }
    if (!done) throw new Error(`did not settle within ${maxSteps} blocks`);
    return tracked;
  };
  let generation: Generation = { alive: true };
  const first = assemble(generation);
  /** A new container over the same raw parts; `killPrevious` fences the old one dead first. */
  const restart = (restartOptions: { readonly killPrevious?: boolean } = {}) => {
    if (restartOptions.killPrevious) generation.alive = false;
    generation = { alive: true };
    return assemble(generation);
  };
  return {
    ...first,
    node,
    clock,
    stores,
    address,
    warnings,
    run,
    mineWhile,
    restart,
  };
}
