/**
 * The restart generation fence: `restart({ killPrevious: true })` simulates a
 * process that died, so nothing the old generation started may make further progress or
 * write to shared state. `createFakeEnv` uses it, and so does every family's end-to-end env
 * built on its own scripted node. Test-only: not part of `crypto-aio/testing`.
 */
import { StateError } from '../core/errors/error';
import type { Signer } from '../core/signing/types';
import type {
  CursorStore,
  LockManager,
  OperationStore,
  SequenceStore,
  Stores,
} from '../core/store/types';
import type { Clock } from '../core/util/clock';
import type { FakeClock } from './fake-clock';

/**
 * Flipped to `false` by `restart({ killPrevious: true })`; every wrapper built for this
 * generation (clock, fetch, the fetched Response's body readers, the shared signer, the store
 * proxies) checks it both when invoked and when the real call underneath settles, so a dead
 * generation can neither start nor finish any of them.
 *
 * The fence only becomes complete once the microtask queue has drained past the point
 * where `generation.alive` was flipped. Code from the old generation that was already past a
 * *settled* fenced call (holding a plain value, not awaiting anything) keeps running
 * synchronously — nothing here can interrupt a synchronous continuation mid-expression — right
 * up until it reaches its *next* fenced call, which then never lets it proceed further (or, for
 * a synchronous wrapped call, throws instead — see `generationProxy`).
 */
export interface Generation {
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

/** Body-reading methods fenced on a fetched Response (`bytes` only where the runtime
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
 * A stand-in for `response.body` whose every chunk is pulled from the real body through
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
 * Wraps a fetched Response so reading its body is fenced too — once a generation is
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
 * itself fenced, so a body read issued on it after the kill never settles either. */
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
 * Every async method of the `Stores` ports and of `Signer`. Exhaustive at compile time (a
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

/**
 * Diagnostics that must keep working on a dead proxy (`JSON.stringify`, `util.inspect`).
 */
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
 * Wraps every method of `target` so a generation's death fences it, and generalizes the
 * old `generationStore` to any shared object with async methods (`Stores`, `Signer`). An async
 * method (a port method named in `ASYNC_PORT_METHODS`, or a native `async` function) is
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
  // Writes are refused loudly: they would otherwise land silently on the stand-in.
  const refuse = (trap: string): never => {
    throw new TypeError(
      `crypto-aio/testing: '${trap}' is not supported on a fenced object`,
    );
  };
  return new Proxy({} as T, {
    set: () => refuse('set'),
    defineProperty: () => refuse('defineProperty'),
    deleteProperty: () => refuse('deleteProperty'),
    has: (_stand, prop) => Reflect.has(target, prop),
    ownKeys: () => Reflect.ownKeys(target),
    getPrototypeOf: () => Reflect.getPrototypeOf(target),
    getOwnPropertyDescriptor: (_stand, prop) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    get(_stand, prop) {
      // No receiver, so a native/data getter runs with the real target as `this`.
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
        if (!thenable) return result; // A synchronous result passes straight through.
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

/** The shared signer (see the doc comment on `signers` in `assemble`, `env.ts` — it's
 * stateless and never rebuilt across generations) still has its `sign`/`getPublicKey` calls
 * fenced per generation, the same as any other in-flight call; the underlying `Signer`
 * instance is unchanged, just wrapped. */
function generationSigner(shared: Signer, generation: Generation): Signer {
  return generationProxy(shared, generation);
}

/**
 * Fences one generation's view of the parts every generation shares. A family env builds
 * each container from the result, never from `parts` directly, and keeps `generation` so a
 * restart can kill it:
 *
 * ```ts
 * const generation = { alive: true };
 * const fenced = fenceGeneration(
 *   { clock, fetch: node.fetch.fetch, stores, signers: { [signer.id]: signer } },
 *   generation,
 * );
 * const aio = new CryptoAio({
 *   clock: fenced.clock,
 *   stores: fenced.stores,
 *   signers: fenced.signers,
 *   transport: { fetch: fenced.fetch },
 *   // ...providers, wallets, chains
 * });
 * // restart({ killPrevious: true }): kill this generation, then fence a new one over the
 * // same parts (same clock, node, stores and signer objects).
 * generation.alive = false;
 * ```
 *
 * Once `generation.alive` is `false`, every clock sleep, fetch (and body read), store call
 * and signer call of this generation, in flight or issued later, never settles; a
 * synchronous port method throws `StateError`. `clock.now()` stays live. Keep the raw
 * `clock` for driving time (`drive`, `advance`, `pending`) and the raw `stores` for test
 * assertions: they belong to no generation.
 */
export function fenceGeneration(
  parts: {
    readonly clock: FakeClock;
    readonly fetch: typeof fetch;
    readonly stores: Stores;
    readonly signers: Readonly<Record<string, Signer>>;
  },
  generation: Generation,
): {
  readonly clock: Clock;
  readonly fetch: typeof fetch;
  readonly stores: Stores;
  readonly signers: Readonly<Record<string, Signer>>;
} {
  return {
    clock: generationClock(parts.clock, generation),
    fetch: generationFetch(parts.fetch, generation),
    stores: generationStores(parts.stores, generation),
    signers: Object.fromEntries(
      Object.entries(parts.signers).map(([id, signer]) => [
        id,
        generationSigner(signer, generation),
      ]),
    ),
  };
}
