import { secp256k1 } from '@noble/curves/secp256k1';
import type { Blockchain } from '../core/blockchain/handle';
import type {
  AioOptions,
  Hooks,
  LifecycleOptions,
  WalletConfig,
} from '../core/config/types';
import { CryptoAio } from '../core/container/container';
import { noopLogger } from '../core/events/logger';
import { localSigner } from '../core/signing/local';
import type { Signer } from '../core/signing/types';
import { createMemoryStores } from '../core/store/memory';
import type { Stores } from '../core/store/types';
import type { TransportOptions } from '../core/transport/types';
import type { Clock } from '../core/util/clock';
import {
  FakeChain,
  fakeAddress,
  type FakeChainOptions,
  type FakeEndpointOptions,
  type FakeOrdering,
} from './fake-chain';
import { FakeClock, drive } from './fake-clock';
import { fakePlugin } from './fake-plugin';

export type FakeChainId = 'fakechain' | 'fakeexpiry' | 'fakeseqno';

export interface FakeEnvOptions {
  readonly ordering?: FakeOrdering;
  readonly endpoints?: readonly (
    string | ({ readonly name: string } & FakeEndpointOptions)
  )[];
  /** Funds the wallet with this many base units (default 1_000_000). Use 0n for none. */
  readonly fund?: bigint;
  readonly chain?: Omit<FakeChainOptions, 'ordering' | 'clock'>;
  readonly wallets?: Readonly<Record<string, WalletConfig>>;
  readonly signer?: Signer;
  readonly stores?: Partial<Stores>;
  readonly transport?: Omit<TransportOptions, 'fetch'>;
  readonly lifecycle?: LifecycleOptions;
  readonly hooks?: Hooks;
  /** Extra container options merged last. */
  readonly aio?: AioOptions;
}

export interface FakeEnv {
  readonly clock: FakeClock;
  readonly chain: FakeChain;
  readonly aio: CryptoAio;
  readonly bc: Blockchain<FakeChainId>;
  readonly signer: Signer;
  readonly stores: Stores;
  readonly address: string;
  readonly chainId: FakeChainId;
  /** Drives a promise to completion on fake time (100 ms steps by default). */
  run<T>(promise: Promise<T>, stepMs?: number): Promise<T>;
  /** A fresh, unrelated fake-chain address. */
  stranger(): string;
  /**
   * Simulates a process restart: a new container (new pool, bus and owner id) attached to
   * the same durable state (stores, FakeChain, the one simulated FakeClock). By default the
   * previous generation's env keeps working — later tasks run two generations concurrently
   * this way. `{ killPrevious: true }` simulates "the old process died": every clock sleep,
   * fetch and store call already in flight or issued later on the OLD generation's handles
   * and stores never settles (neither resolves nor rejects), so it can make no further
   * progress and no old continuation can write to shared state.
   */
  restart(options?: { readonly killPrevious?: boolean }): Promise<FakeEnv>;
}

/** Flipped to `false` by `restart({ killPrevious: true })`; every wrapper built for this
 * generation (clock, fetch, stores) checks it both when invoked and when the real call
 * underneath settles, so a dead generation can neither start nor finish any of them. */
interface Generation {
  alive: boolean;
}

/** Per-generation clock: `now()` stays live (harmless to read); `sleep()` is fenced. */
function generationClock(shared: FakeClock, generation: Generation): Clock {
  return {
    now: () => shared.now(),
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (!generation.alive) return; // never settles: already dead at call time.
        shared.sleep(ms, signal).then(
          () => {
            if (generation.alive) resolve(); // else: never settles, dead before it woke.
          },
          (error: unknown) => {
            if (generation.alive) reject(error);
          },
        );
      }),
  };
}

/** Per-generation fetch, fenced the same way as the clock. */
function generationFetch(shared: typeof fetch, generation: Generation): typeof fetch {
  return ((...args: Parameters<typeof fetch>) =>
    new Promise<Response>((resolve, reject) => {
      if (!generation.alive) return;
      Promise.resolve(shared(...args)).then(
        (response) => {
          if (generation.alive) resolve(response);
        },
        (error: unknown) => {
          if (generation.alive) reject(error);
        },
      );
    })) as typeof fetch;
}

/** Wraps one async method the same way `generationClock`/`generationFetch` wrap theirs. */
function generationAsync<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  thisArg: unknown,
  generation: Generation,
): (...args: A) => Promise<R> {
  return (...args: A) =>
    new Promise<R>((resolve, reject) => {
      if (!generation.alive) return;
      Promise.resolve(fn.apply(thisArg, args)).then(
        (value) => {
          if (generation.alive) resolve(value);
        },
        (error: unknown) => {
          if (generation.alive) reject(error);
        },
      );
    });
}

/** Proxies every method of a shared store instance through `generationAsync`. */
function generationStore<T extends object>(store: T, generation: Generation): T {
  return new Proxy(store, {
    get(target, prop, receiver: unknown) {
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function'
        ? generationAsync(
            value as (...args: unknown[]) => Promise<unknown>,
            target,
            generation,
          )
        : value;
    },
  });
}

function generationStores(stores: Stores, generation: Generation): Stores {
  return {
    operations: generationStore(stores.operations, generation),
    locks: generationStore(stores.locks, generation),
    sequences: generationStore(stores.sequences, generation),
    cursors: generationStore(stores.cursors, generation),
  };
}

interface Shared {
  readonly clock: FakeClock;
  readonly chain: FakeChain;
  readonly chainId: FakeChainId;
  readonly endpoints: readonly { readonly name: string; readonly url: string }[];
  readonly signer: Signer;
  readonly stores: Stores;
  readonly options: FakeEnvOptions;
}

export async function createFakeEnv(options: FakeEnvOptions = {}): Promise<FakeEnv> {
  const clock = new FakeClock();
  const ordering = options.ordering ?? 'nonce';
  const chain = new FakeChain({ ...options.chain, ordering, clock });
  const chainId: FakeChainId =
    ordering === 'nonce'
      ? 'fakechain'
      : ordering === 'expiry'
        ? 'fakeexpiry'
        : 'fakeseqno';
  const endpoints = (options.endpoints ?? ['main']).map((entry) => {
    const { name, ...rest } = typeof entry === 'string' ? { name: entry } : entry;
    return { name, url: chain.endpoint(name, rest) };
  });
  const signer =
    options.signer ?? localSigner.generate({ curves: ['secp256k1'], id: 'hot' }).signer;
  const overrides = Object.fromEntries(
    Object.entries(options.stores ?? {}).filter(([, store]) => store !== undefined),
  ) as Partial<Stores>;
  const stores: Stores = { ...createMemoryStores(clock), ...overrides };
  const env = await assemble(
    { clock, chain, chainId, endpoints, signer, stores, options },
    { alive: true },
  );
  const fund = options.fund ?? 1_000_000n;
  if (fund > 0n) chain.fund(env.address, fund);
  return env;
}

async function assemble(shared: Shared, generation: Generation): Promise<FakeEnv> {
  const { clock, chain, chainId, endpoints, signer, stores, options } = shared;
  const genStores = generationStores(stores, generation);
  const aio = new CryptoAio({
    env: false,
    clock: generationClock(clock, generation),
    logger: noopLogger,
    plugins: [fakePlugin()],
    stores: genStores,
    transport: {
      fetch: generationFetch(chain.fetch, generation),
      baseDelayMs: 1,
      maxDelayMs: 5,
      timeoutMs: 5_000,
      ...options.transport,
    },
    providers: { fake: { endpoints } },
    // A local signer is stateless (holds no per-process state), so it is shared across
    // generations rather than rebuilt on every restart().
    signers: { [signer.id]: signer },
    wallets: { main: { signer: signer.id }, ...options.wallets },
    chains: { [chainId]: { provider: 'fake', wallet: 'main' } },
    lifecycle: {
      pollIntervalMs: 1_000,
      droppedGracePeriodMs: 10_000,
      rebroadcastIntervalMs: 5_000,
      waitTimeoutMs: 120_000,
      leaseMs: 30_000,
      claimLeaseMs: 30_000,
      ...options.lifecycle,
    },
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...options.aio,
  });
  const bc = aio.blockchain({ chain: chainId });
  const run = <T>(promise: Promise<T>, stepMs = 100): Promise<T> =>
    drive(clock, promise, stepMs);
  const address = (await run(bc.walletAddress())).canonical;
  const stranger = () =>
    fakeAddress(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true));
  const restart = (restartOptions?: {
    readonly killPrevious?: boolean;
  }): Promise<FakeEnv> => {
    if (restartOptions?.killPrevious) generation.alive = false;
    return assemble(shared, { alive: true });
  };
  return {
    clock,
    chain,
    aio,
    bc,
    signer,
    stores: genStores,
    address,
    chainId,
    run,
    stranger,
    restart,
  };
}
