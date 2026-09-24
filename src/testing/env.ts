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
import type {
  CursorStore,
  LockManager,
  OperationStore,
  SequenceStore,
  Stores,
} from '../core/store/types';
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
   * would either fail to type-check or (if forced through) be silently overridden. Its
   * `signers` are merged by name over the default signer, and every entry is fenced (N-B). */
  readonly aio?: Omit<AioOptions, 'clock' | 'stores' | 'transport'>;
}

export interface FakeEnv {
  readonly clock: FakeClock;
  readonly chain: FakeChain;
  readonly aio: CryptoAio;
  readonly bc: Blockchain<FakeChainId>;
  /**
   * N-D: the raw, unfenced `Signer` instance — the same object across every `restart()`
   * (stateless, never rebuilt). The container itself holds a fenced PROXY of it (see
   * `generationSigner`/N-B), not this object, so an identity assertion against the
   * container's copy (e.g. `containerOf(aio).effective().signers[id]`) must compare `.id`,
   * never `===` against this field.
   */
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

/** Runs `start` unless the generation is already dead, and settles like its result only while
 * the generation is still alive; otherwise the returned promise never settles. */
function fenced<T>(generation: Generation, start: () => PromiseLike<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!generation.alive) return; // never settles: already dead at call time.
    Promise.resolve(start()).then(
      (value) => {
        if (generation.alive) resolve(value); // else: never settles, dead before it settled.
      },
      (error: unknown) => {
        if (generation.alive) reject(error);
      },
    );
  });
}

/** Per-generation clock: `now()` stays live (harmless to read); `sleep()` is fenced. */
function generationClock(shared: FakeClock, generation: Generation): Clock {
  return {
    now: () => shared.now(),
    sleep: (ms, signal) => fenced(generation, () => shared.sleep(ms, signal)),
  };
}

/** Body-reading methods fenced on a fetched Response (N2, N-C; `bytes` only where the runtime
 * has it). `clone()` and `body` are fenced separately; everything else (status, ok, headers,
 * ...) passes straight through. */
const FENCED_RESPONSE_READERS = new Set([
  'text',
  'json',
  'arrayBuffer',
  'blob',
  'bytes',
  'formData',
]);

/**
 * N-C: a stand-in for `response.body` whose every chunk is pulled from the real body through
 * the fence, so a `read()` (via `getReader()`, async iteration, `pipeTo`, `tee`, ...) never
 * settles once the generation is dead. `highWaterMark: 0` means nothing is pulled — and the
 * real body isn't even locked — until a consumer actually reads, so merely touching `.body`
 * (e.g. `if (res.body) await res.text()`) still leaves the real body readable by `text()`.
 */
function generationBody(
  body: ReadableStream<Uint8Array>,
  generation: Generation,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      pull: (controller) =>
        fenced(generation, () => (reader ??= body.getReader()).read()).then((chunk) => {
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        }),
      cancel: (reason) => (reader ? reader.cancel(reason) : body.cancel(reason)),
    },
    { highWaterMark: 0 },
  );
}

/**
 * N2/N-C: wraps a fetched Response so reading its body is fenced too — once a generation is
 * dead, every body reader (`text()`, `json()`, `blob()`, ...), a read of the `body` stream,
 * and the same on any `clone()` of it (itself a fenced Response) must never settle either,
 * exactly like the fetch call that produced it (a caller may have obtained the Response while
 * still alive and only read its body afterwards). Every other property or method is bound to
 * the real `target` (never invoked through the Proxy itself), so a native accessor like
 * `.ok`/`.status` still sees a genuine `Response` as `this`.
 */
function generationResponse(response: Response, generation: Generation): Response {
  let body: ReadableStream<Uint8Array> | null | undefined;
  return new Proxy(response, {
    get(target, prop) {
      if (prop === 'body') {
        // Memoized: like the real getter, every access returns the same stream.
        if (body === undefined)
          body = target.body === null ? null : generationBody(target.body, generation);
        return body;
      }
      const value: unknown = Reflect.get(target, prop); // no receiver: see generationProxy.
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (prop === 'clone') return () => generationResponse(target.clone(), generation);
      if (typeof prop !== 'string' || !FENCED_RESPONSE_READERS.has(prop)) return bound;
      return (...args: unknown[]) => fenced(generation, () => bound(...args));
    },
  });
}

/** Per-generation fetch, fenced the same way as the clock; the Response it resolves with is
 * itself fenced (N2), so a body read issued on it after the kill never settles either. */
function generationFetch(shared: typeof fetch, generation: Generation): typeof fetch {
  return ((...args: Parameters<typeof fetch>) =>
    fenced(generation, () =>
      shared(...args).then((response) => generationResponse(response, generation)),
    )) as typeof fetch;
}

type AsyncPortMethod =
  | keyof OperationStore
  | keyof LockManager
  | keyof SequenceStore
  | keyof CursorStore
  | Exclude<keyof Signer, 'id' | 'schemes'>;

/**
 * N-A: every async method of the `Stores` ports and of `Signer`. Exhaustive at compile time (a
 * port method added later fails the build until it's listed here), and independent of how an
 * implementation spells the method — a non-`async` function returning a Promise counts too.
 */
const ASYNC_PORT_METHODS: { readonly [K in AsyncPortMethod]: true } = {
  create: true,
  get: true,
  getByKey: true,
  findByRef: true,
  update: true,
  appendAttempt: true,
  getObservation: true,
  putObservation: true,
  claimDue: true,
  releaseClaim: true,
  list: true,
  purge: true,
  acquire: true,
  renew: true,
  release: true,
  put: true,
  getPublicKey: true,
  sign: true,
  cancelRequest: true,
  exportKey: true,
};

/** N-A: diagnostics that must keep working on a dead proxy (`JSON.stringify`, `util.inspect`). */
const PASSTHROUGH = new Set<PropertyKey>([
  'toJSON',
  'inspect',
  Symbol.for('nodejs.util.inspect.custom'),
]);

function isAsyncMethod(prop: PropertyKey, fn: unknown): boolean {
  return (
    (typeof prop === 'string' && Object.hasOwn(ASYNC_PORT_METHODS, prop)) ||
    Object.prototype.toString.call(fn) === '[object AsyncFunction]'
  );
}

/**
 * N4: wraps every method of `target` so a generation's death fences it, and generalizes the
 * old `generationStore` to any shared object with async methods (`Stores`, `Signer`). An async
 * method (N-A: a port method named in `ASYNC_PORT_METHODS`, or a native `async` function) is
 * fenced the way `sleep`/`fetch` are: once the generation is dead it never settles and never
 * throws, whether it was already in flight or is only called afterwards. A genuinely
 * synchronous method throws `StateError` when called on an already-dead generation — there's
 * no "never resolve" for a call that must return synchronously. `toJSON`/`inspect` pass
 * through unfenced.
 */
function generationProxy<T extends object>(target: T, generation: Generation): T {
  // The Proxy wraps an empty, extensible stand-in, never `target` itself: a frozen target
  // (e.g. a `callbackSigner`) has non-configurable read-only properties, and the Proxy
  // invariants would then forbid returning the fenced wrapper instead of the real value.
  // Every read is forwarded to the real object; descriptors are reported configurable.
  return new Proxy({} as T, {
    has: (_stand, prop) => Reflect.has(target, prop),
    ownKeys: () => Reflect.ownKeys(target),
    getPrototypeOf: () => Reflect.getPrototypeOf(target),
    getOwnPropertyDescriptor: (_stand, prop) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    get(_stand, prop) {
      // N4: no receiver, so a native/data getter runs with the real target as `this`.
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (PASSTHROUGH.has(prop)) return fn.bind(target);
      const isAsync = isAsyncMethod(prop, fn);
      return (...args: unknown[]) => {
        if (!generation.alive) {
          // A call issued once the generation is already dead never invokes the real method
          // (no side effect from a dead continuation). An async one just never settles; a
          // synchronous one can't be left "hanging", so it fails fast instead.
          if (isAsync) return new Promise(() => undefined);
          throw new StateError(
            'INVALID_TRANSITION',
            'crypto-aio/testing: this generation was killed by restart({ killPrevious: true })',
          );
        }
        const result = fn.apply(target, args);
        const thenable =
          typeof result === 'object' &&
          result !== null &&
          typeof (result as { then?: unknown }).then === 'function';
        if (!thenable) return result; // N4: a synchronous result passes straight through.
        return fenced(generation, () => result as PromiseLike<unknown>);
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
  // A local signer is stateless (holds no per-process state), so it is shared across
  // generations rather than rebuilt on every restart() — only its calls are fenced (N2). N-B:
  // every entry of the FINAL merged map (the default signer plus `options.aio.signers`, the
  // latter winning by name) is fenced, and it's applied after `...options.aio` below so an
  // `aio.signers` map can never bypass the fence.
  const signers = Object.fromEntries(
    Object.entries({ [signer.id]: signer, ...options.aio?.signers }).map(([id, s]) => [
      id,
      generationSigner(s, generation),
    ]),
  );
  const aio = new CryptoAio({
    env: false,
    logger: noopLogger,
    plugins: [fakePlugin()],
    providers: { fake: { endpoints } },
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
    // (its type already excludes clock/stores/transport — see `FakeEnvOptions.aio`; `signers`
    // is the fenced merge above, N-B). `env.stores` below reads the same `genStores` object
    // handed to the container here, so they're guaranteed to be the same fenced instances.
    signers,
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
