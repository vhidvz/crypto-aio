import { secp256k1 } from '@noble/curves/secp256k1';
import type { Blockchain } from '../core/blockchain/handle';
import type {
  AioOptions,
  Hooks,
  LifecycleOptions,
  WalletConfig,
} from '../core/config/types';
import { CryptoAio } from '../core/container/container';
import { StateError } from '../core/errors/error';
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
  /** Extra container options merged last. Never `clock`, `stores` or `transport` — those are
   * always the generation-fenced values (N3), so this type excludes them; passing any of them
   * would either fail to type-check or (if forced through) be silently overridden. */
  readonly aio?: Omit<AioOptions, 'clock' | 'stores' | 'transport'>;
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

/**
 * Flipped to `false` by `restart({ killPrevious: true })`; every wrapper built for this
 * generation (clock, fetch, the fetched Response's body readers, the shared signer, the store
 * proxies) checks it both when invoked and when the real call underneath settles, so a dead
 * generation can neither start nor finish any of them.
 *
 * N2: the fence only becomes complete once the microtask queue has drained past the point
 * where `generation.alive` was flipped. Code from the old generation that was already past a
 * *settled* fenced call (holding a plain value, not awaiting anything) keeps running
 * synchronously — nothing here can interrupt a synchronous continuation mid-expression — right
 * up until it reaches its *next* fenced call, which then never lets it proceed further (or, for
 * a synchronous wrapped call, throws instead — see `generationProxy`).
 */
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

/** Body-reading methods fenced on a fetched Response (N2); everything else (status, ok,
 * headers, clone(), ...) passes straight through. */
const FENCED_RESPONSE_READERS = new Set(['text', 'json', 'arrayBuffer']);

/**
 * N2: wraps a fetched Response so its body readers are fenced too — once a generation is
 * dead, `text()`/`json()`/`arrayBuffer()` on a Response it already received must never settle
 * either, exactly like the fetch call that produced it (a caller may have obtained the
 * Response while still alive and only read its body afterwards). Every other property or
 * method is bound to the real `target` (never invoked through the Proxy itself), so a native
 * accessor like `.ok`/`.status` still sees a genuine `Response` as `this`.
 */
function generationResponse(response: Response, generation: Generation): Response {
  return new Proxy(response, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop); // no receiver: see generationProxy.
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (typeof prop !== 'string' || !FENCED_RESPONSE_READERS.has(prop)) return bound;
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          if (!generation.alive) return; // never settles: already dead at call time.
          Promise.resolve(bound(...args)).then(
            (value) => {
              if (generation.alive) resolve(value);
            },
            (error: unknown) => {
              if (generation.alive) reject(error);
            },
          );
        });
    },
  });
}

/** Per-generation fetch, fenced the same way as the clock; the Response it resolves with is
 * itself fenced (N2), so a body read issued on it after the kill never settles either. */
function generationFetch(shared: typeof fetch, generation: Generation): typeof fetch {
  return ((...args: Parameters<typeof fetch>) =>
    new Promise<Response>((resolve, reject) => {
      if (!generation.alive) return;
      Promise.resolve(shared(...args)).then(
        (response) => {
          if (generation.alive) resolve(generationResponse(response, generation));
        },
        (error: unknown) => {
          if (generation.alive) reject(error);
        },
      );
    })) as typeof fetch;
}

/**
 * N4: wraps every method of `target` so a generation's death fences it, and generalizes the
 * old `generationStore` to any shared object with async methods (also used for the signer,
 * N2). Only a Promise/thenable result is fenced the way `sleep`/`fetch` are (never settles
 * once the generation dies); a genuinely synchronous method throws `StateError` when called on
 * an already-dead generation — there's no "never resolve" for a call that must return
 * synchronously — and otherwise passes its result straight through, unfenced. In practice every
 * method wrapped here (`Stores`, `Signer`) is async; the synchronous branch is a defensive
 * fallback for whatever else this helper wraps later.
 */
function generationProxy<T extends object>(target: T, generation: Generation): T {
  return new Proxy(target, {
    get(t, prop) {
      // N4: no receiver, so a native/data getter runs with the real target as `this`.
      const value: unknown = Reflect.get(t, prop);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        if (!generation.alive) {
          // A call issued once the generation is already dead: never invoke the real method
          // (no side effect from a dead continuation). It can't be left "hanging" the way an
          // in-flight promise can, so it fails fast instead.
          throw new StateError(
            'INVALID_TRANSITION',
            'crypto-aio/testing: this generation was killed by restart({ killPrevious: true })',
          );
        }
        const result = fn.apply(t, args);
        const thenable =
          typeof result === 'object' &&
          result !== null &&
          typeof (result as { then?: unknown }).then === 'function';
        if (!thenable) return result; // N4: a synchronous result passes straight through.
        return new Promise((resolve, reject) => {
          Promise.resolve(result as Promise<unknown>).then(
            (value) => {
              if (generation.alive) resolve(value);
            },
            (error: unknown) => {
              if (generation.alive) reject(error);
            },
          );
        });
      };
    },
  });
}

function generationStores(stores: Stores, generation: Generation): Stores {
  return {
    operations: generationProxy(stores.operations, generation),
    locks: generationProxy(stores.locks, generation),
    sequences: generationProxy(stores.sequences, generation),
    cursors: generationProxy(stores.cursors, generation),
  };
}

/** N2: the shared signer (see the doc comment on `signers` in `assemble` — it's stateless and
 * never rebuilt across generations) still has its `sign`/`getPublicKey` calls fenced per
 * generation, the same as any other in-flight call; the underlying `Signer` instance is
 * unchanged, just wrapped. */
function generationSigner(shared: Signer, generation: Generation): Signer {
  return generationProxy(shared, generation);
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
    logger: noopLogger,
    plugins: [fakePlugin()],
    providers: { fake: { endpoints } },
    // A local signer is stateless (holds no per-process state), so it is shared across
    // generations rather than rebuilt on every restart() — only its calls are fenced (N2).
    signers: { [signer.id]: generationSigner(signer, generation) },
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
    // N3: applied AFTER `options.aio`, so a generation's fencing can never be shadowed by it
    // (its type already excludes these three keys — see `FakeEnvOptions.aio`). `env.stores`
    // below reads the same `genStores` object handed to the container here, so they're
    // guaranteed to be the same fenced instances.
    clock: generationClock(clock, generation),
    stores: genStores,
    transport: {
      fetch: generationFetch(chain.fetch, generation),
      baseDelayMs: 1,
      maxDelayMs: 5,
      timeoutMs: 5_000,
      ...options.transport,
    },
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
