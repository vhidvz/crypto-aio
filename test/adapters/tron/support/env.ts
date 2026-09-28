/**
 * A container on the scripted Tron node, for end-to-end tests. `restart({ killPrevious:
 * true })` kills the old generation through `fenceGeneration` (handoff R20, ruling A5): every
 * clock sleep, fetch, store and signer call of the old container then never settles, exactly
 * like a dead process. A plain `restart()` starts a second live generation. `aio` and `bc`
 * are the current generation's; `clock` and `stores` are the shared, unfenced objects: drive
 * time and assert on durable state through them. A killed container is never closed (its
 * fenced calls never settle).
 *
 * The node's genesis serves no timestamp (proto3, as java-tron), and the builder refuses a
 * head too old to reference, so the env mines block 1 before any build.
 */
import {
  CryptoAio,
  noopLogger,
  type Blockchain,
  type LifecycleOptions,
  type Signer,
  type Stores,
} from '../../../../src';
import { secret } from '../../../../src/core/secret/secret';
import { localSigner } from '../../../../src/core/signing/local';
import { createMemoryStores } from '../../../../src/core/store/memory';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import { fenceGeneration, type Generation } from '../../../../src/testing/generation';
import { ScriptedTronNode, type NodeOptions } from './node';
import { KEY, KEY_ADDRESS } from './vectors';

export interface TronEnvOptions {
  readonly network?: 'mainnet' | 'shasta' | 'nile';
  readonly endpoints?: readonly string[];
  readonly node?: Partial<Omit<NodeOptions, 'clock' | 'network'>>;
  /** Sun for the test key's account (default 1,000 TRX); `0n` leaves it never activated. */
  readonly fund?: bigint;
  readonly stores?: Partial<Stores>;
  readonly signer?: Signer;
  readonly indexer?: boolean;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly lifecycle?: LifecycleOptions;
}

/** A local signer holding the test key that counts its `sign` calls. */
export function countingSigner(): { readonly signer: Signer; calls(): number } {
  const inner = localSigner({ id: 'hot', secp256k1: secret(KEY) });
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

export function createTronEnv(options: TronEnvOptions = {}) {
  const network = options.network ?? 'nile';
  const clock = new FakeClock(1_790_000_000_000);
  const node = new ScriptedTronNode({ solidDepth: 3, ...options.node, network, clock });
  const endpoints = (options.endpoints ?? ['main']).map((name) => ({
    name,
    url: node.endpoint(name),
  }));
  const signer = options.signer ?? countingSigner().signer;
  const stores: Stores = { ...createMemoryStores(clock), ...options.stores };
  // `fund: 0n` leaves the test key's account never activated (no account on chain).
  const fund = options.fund ?? 1_000_000_000n;
  if (fund > 0n) node.fund(KEY_ADDRESS, fund);
  // A head with a timestamp to reference (genesis serves none).
  node.mine();

  /** One generation (one simulated process): a container over the fenced shared parts. */
  const assemble = (generation: Generation) => {
    const fenced = fenceGeneration(
      { clock, fetch: node.fetch.fetch, stores, signers: { hot: signer } },
      generation,
    );
    const aio = new CryptoAio({
      env: false,
      logger: noopLogger,
      clock: fenced.clock,
      stores: fenced.stores,
      transport: { fetch: fenced.fetch, baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 5_000 },
      providers: { node: { endpoints } },
      signers: fenced.signers,
      wallets: { main: { signer: 'hot' } },
      chains: {
        tron: {
          network,
          provider: 'node',
          ...(options.indexer ? { indexer: 'node' } : {}),
          wallet: 'main',
          ...(options.options ? { options: options.options } : {}),
        },
      },
      lifecycle: {
        pollIntervalMs: 3_000,
        droppedGracePeriodMs: 30_000,
        rebroadcastIntervalMs: 15_000,
        waitTimeoutMs: 1_800_000,
        leaseMs: 30_000,
        claimLeaseMs: 30_000,
        ...options.lifecycle,
      },
    });
    const bc: Blockchain<'tron'> = aio.blockchain({ chain: 'tron' });
    return { aio, bc };
  };

  const run = <T>(promise: Promise<T>, stepMs = 100): Promise<T> =>
    drive(clock, promise, stepMs);
  /** Mines one block per 3 fake seconds until `promise` settles; throws after `maxBlocks`. */
  const mineWhile = async <T>(
    promise: Promise<T>,
    mineOptions: { readonly maxBlocks?: number; readonly include?: boolean } = {},
  ): Promise<T> => {
    const maxBlocks = mineOptions.maxBlocks ?? 600;
    let done = false;
    const tracked = promise.finally(() => {
      done = true;
    });
    tracked.catch(() => undefined);
    for (let i = 0; i < maxBlocks && !done; i++) {
      await clock.advance(3_000);
      node.mine(mineOptions.include === false ? { include: false } : {});
    }
    if (!done) throw new Error(`did not settle within ${maxBlocks} blocks`);
    return tracked;
  };
  let generation: Generation = { alive: true };
  let current = assemble(generation);
  /**
   * A new container over the same stores, node and clock. `killPrevious` simulates "the old
   * process died": the previous generation is fenced dead before the new one starts.
   */
  const restart = async (restartOptions: { readonly killPrevious?: boolean } = {}) => {
    if (restartOptions.killPrevious) generation.alive = false;
    generation = { alive: true };
    current = assemble(generation);
    return current;
  };
  return {
    get aio() {
      return current.aio;
    },
    get bc() {
      return current.bc;
    },
    node,
    clock,
    stores,
    address: KEY_ADDRESS,
    run,
    mineWhile,
    restart,
  };
}
