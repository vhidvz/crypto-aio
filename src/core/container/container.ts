import { AssetService } from '../assets/service';
import { Blockchain } from '../blockchain/handle';
import { internalsOf, type HandleInternals } from '../blockchain/internal';
import { readEnvChains } from '../config/env';
import { assertNoCycle, isPlainObject, mergeScopes } from '../config/merge';
import { resolveSelection } from '../config/resolve';
import type {
  AioOptions,
  EffectiveOptions,
  HandleConfig,
  HandleOptions,
  ResolvedSelection,
  ScopeOptions,
} from '../config/types';
import type { ChainDriver } from '../driver/types';
import { ConfigError } from '../errors/error';
import { EventBus } from '../events/bus';
import { createLogger } from '../events/logger';
import type { AioEvent, AioEventName } from '../events/types';
import {
  OperationEngine,
  errorCode,
  withLifecycleDefaults,
  type OperationTarget,
  type ReadTarget,
} from '../lifecycle/engine';
import { Monitor, type RecoveryReport, type WorkerOptions } from '../lifecycle/monitor';
import { loadObservations } from '../lifecycle/observations';
import { toView, type OperationView } from '../lifecycle/views';
import type { ChainId } from '../model/ids';
import { SequenceCoordinator } from '../ordering/sequence';
import {
  applyPlugin,
  cloneCatalogs,
  createCatalogs,
  type Catalogs,
  type Plugin,
} from '../registry/plugin';
import { SigningOrchestrator } from '../signing/orchestrator';
import { resolveWallet, type ResolvedWallet } from '../signing/wallet';
import { createMemoryStores } from '../store/memory';
import type { OperationRecord, OperationState, Stores } from '../store/types';
import { randomId } from '../util/bytes';
import { systemClock, type Clock } from '../util/clock';
import { builtinPlugins } from './builtins';
import {
  bindContainer,
  closedError,
  containerOf,
  type ContainerInternals,
  type RootRuntime,
} from './internals';
import { DriverPool, type PooledDriver } from './pool';

const NAMESPACE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The signal a worker loop, pass or recovery runs under: the caller's, if any, and the
 * root's `closing`, which `close()` aborts. A closed container starts no new work: it
 * stops claiming Operations from a shared store (holding each for a lease) and no longer
 * keeps the process alive.
 */
function workerSignal(
  runtime: RootRuntime,
  signal: AbortSignal | undefined,
): AbortSignal {
  if (runtime.closed) throw closedError();
  return signal
    ? AbortSignal.any([signal, runtime.closing.signal])
    : runtime.closing.signal;
}

/** How long `close()` waits for one native client's `close` before moving on. */
export const NATIVE_CLOSE_TIMEOUT_MS = 5_000;

/** Runs `close`, but gives up waiting after `ms` of `clock` time (the close keeps running). */
async function closeWithin(
  close: () => unknown,
  clock: Clock,
  ms: number,
): Promise<'closed' | 'timeout'> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      Promise.resolve()
        .then(close)
        .then(() => 'closed' as const),
      clock.sleep(ms, timer.signal).then(() => 'timeout' as const),
    ]);
  } finally {
    timer.abort();
  }
}

interface ScopeInit {
  readonly parent: CryptoAio;
  readonly overrides: ScopeOptions;
}

/**
 * Deep-clones plain objects/arrays into a frozen copy so a later mutation of the caller's
 * own input can never reach a layer already captured by a container. Class instances
 * (Signer, Secret, ...) are referenced, not cloned — they're already immutable.
 */
function cloneFrozen<T>(value: T, ancestors: Set<object> = new Set()): T {
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  assertNoCycle(value, ancestors);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        value.map((item: unknown) => cloneFrozen(item, ancestors)),
      ) as T;
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = cloneFrozen(v, ancestors);
    return Object.freeze(out) as T;
  } finally {
    ancestors.delete(value);
  }
}

/** `chains`/`providers`/`wallets`/`signers`/`hooks`/`lifecycle` are all cloned and
 * deep-frozen at construction, so mutating the caller's options object afterwards never
 * affects handles already built from this layer. For `signers`, only the map OBJECT is
 * cloned (a fresh, frozen copy so adding/replacing a key on the caller's own map can't reach
 * an existing layer) — the `Signer` values it holds are opaque and always taken by reference,
 * never cloned or frozen, even a plain-object signer (`Signer` is an interface), so it keeps
 * its identity and its own mutable state. */
function scopePart(options: ScopeOptions): ScopeOptions {
  const { chains, providers, signers, wallets, hooks, lifecycle } = options;
  return {
    ...(chains ? { chains: cloneFrozen(chains) } : {}),
    ...(providers ? { providers: cloneFrozen(providers) } : {}),
    ...(signers ? { signers: Object.freeze({ ...signers }) } : {}),
    ...(wallets ? { wallets: cloneFrozen(wallets) } : {}),
    ...(hooks ? { hooks: cloneFrozen(hooks) } : {}),
    ...(lifecycle ? { lifecycle: cloneFrozen(lifecycle) } : {}),
  };
}

function createEngine(
  runtime: RootRuntime,
  effective: () => EffectiveOptions,
): OperationEngine {
  const lifecycle = () => withLifecycleDefaults(effective().lifecycle);
  const { leaseMs } = lifecycle();
  const log = runtime.log.child('lifecycle');
  return new OperationEngine({
    namespace: runtime.namespace,
    stores: runtime.stores,
    events: runtime.events,
    clock: runtime.clock,
    log,
    orchestrator: new SigningOrchestrator({
      schemes: () => runtime.catalogs.schemes,
      events: runtime.events,
      clock: runtime.clock,
      hooks: () => effective().hooks,
    }),
    sequences: new SequenceCoordinator({
      locks: runtime.stores.locks,
      sequences: runtime.stores.sequences,
      clock: runtime.clock,
      owner: runtime.owner,
      leaseMs,
      acquireTimeoutMs: leaseMs,
      // The code only: a store's error message may carry detail that logs must not.
      onReleaseError: (error) =>
        log.warn('lease release failed', { code: errorCode(error) }),
    }),
    lifecycle,
  });
}

/**
 * The signer-free read target of a stored Operation, for every check,
 * worker pass and recovery read: its chain, network and library over its own named
 * providers first, then the current defaults when those no longer resolve (inline configs
 * are recorded by hash only and cannot be rebuilt). No wallet or signer is selected, not
 * even a chain default one, so a rotated signer, a removed wallet or a hung custody
 * backend never stops monitoring.
 */
async function readTarget(
  container: CryptoAio,
  record: OperationRecord,
): Promise<ReadTarget> {
  const internals = containerOf(container);
  const { runtime } = internals;
  const { chain, network, library } = record.context;
  const effective = internals.effective();
  const { wallet: _wallet, signer: _signer, ...defaults } = effective.chains[chain] ?? {};
  const signerFree = { ...effective, chains: { ...effective.chains, [chain]: defaults } };
  const select = (provider?: readonly string[]) =>
    resolveSelection({
      handle: { chain, network, library, ...(provider ? { provider } : {}) },
      effective: signerFree,
      catalogs: runtime.catalogs,
      log: runtime.log,
    });
  const named = record.context.providers.filter((name) => !name.startsWith('inline:'));
  let selection: ResolvedSelection;
  try {
    selection = select(named.length > 0 ? named : undefined);
  } catch (error) {
    // Only a config that no longer resolves (e.g. a renamed provider) falls back.
    if (!(error instanceof ConfigError)) throw error;
    selection = select();
  }
  if (runtime.closed) throw closedError();
  return { selection, pooled: await runtime.pool.get(selection) };
}

/**
 * The wallets the monitor resolved for its writes, cached per container (one public-key
 * read per wallet selection, not one per pass) and bounded by `lifecycle.signTimeoutMs`. A
 * failed resolution is not kept. The cache is dropped when the config changes: a container's
 * layers are frozen, so only a plugin (`use()`, new catalogs and env layer) changes it.
 */
function walletCache(
  runtime: RootRuntime,
  internals: () => ContainerInternals,
): (selection: ResolvedSelection, driver: ChainDriver) => Promise<ResolvedWallet> {
  let catalogs: Catalogs = runtime.catalogs;
  const wallets = new Map<string, Promise<ResolvedWallet>>();
  return (selection, driver) => {
    if (runtime.catalogs !== catalogs) {
      catalogs = runtime.catalogs;
      wallets.clear();
    }
    const key = selection.configHash;
    const cached = wallets.get(key);
    if (cached) return cached;
    const { effective, signerDeadline } = internals();
    const resolving = resolveWallet(
      selection,
      driver,
      effective().signers,
      catalogs.schemes,
      signerDeadline(),
    ).catch((error: unknown) => {
      if (wallets.get(key) === resolving) wallets.delete(key);
      throw error;
    });
    wallets.set(key, resolving);
    return resolving;
  };
}

/**
 * The wallet-bound target of a stored Operation, resolved lazily and only for the
 * writes that need one: the all-rejected verdict, nonce reconciliation and recovery's
 * resend. None of them signs, and their address lease is keyed on the Operation itself.
 * Its frozen context (chain, network, library, wallet, signer) is rebuilt against the
 * container's current config with its own named providers first; when that no longer
 * resolves (a renamed provider, a rotated signer), the wallet alone over the current
 * defaults, with neither the recorded signer nor the providers: the wallet's current
 * signer, public key or address then stands for it (a watch-only wallet is enough). The
 * engine checks the resolved wallet still owns the Operation before using it.
 */
async function operationTarget(
  container: CryptoAio,
  runtime: RootRuntime,
  record: OperationRecord,
  wallets: (selection: ResolvedSelection, driver: ChainDriver) => Promise<ResolvedWallet>,
): Promise<OperationTarget> {
  const { chain, network, library, wallet, signer, providers } = record.context;
  const base = { chain, network, library, wallet } as HandleConfig<ChainId>;
  const named = providers.filter((name) => !name.startsWith('inline:'));
  let handle: Blockchain<ChainId>;
  try {
    handle = container.blockchain({
      ...base,
      ...(signer !== undefined ? { signer } : {}),
      ...(named.length > 0 ? { provider: named } : {}),
    });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    handle = container.blockchain(base);
  }
  const internals = internalsOf(handle);
  const pooled = await internals.pooled();
  return {
    selection: internals.selection,
    pooled,
    wallet: await wallets(internals.selection, pooled.driver),
    assets: runtime.assets,
  };
}

export interface OperationsFilter {
  readonly states?: readonly OperationState[];
  readonly chain?: string;
  readonly network?: string;
  readonly limit?: number;
}

export interface OperationsApi {
  get(id: string): Promise<OperationView | null>;
  /** In creation order. */
  list(filter?: OperationsFilter): Promise<OperationView[]>;
  /** Startup recovery for this namespace (see RecoveryReport); it never signs. */
  recover(options?: { readonly signal?: AbortSignal }): Promise<RecoveryReport>;
}

export interface MonitorApi {
  /** Runs worker passes until `signal` aborts; any number of workers may run. */
  start(options?: WorkerOptions): Promise<void>;
  /** One worker pass; resolves to the number of Operations it claimed. */
  runOnce(options?: WorkerOptions): Promise<number>;
}

/**
 * Dependency container: stores, signers, wallets, hooks, plugins and a shared driver pool.
 * Separate `new CryptoAio()` instances are fully isolated (use one per tenant).
 */
export class CryptoAio {
  readonly namespace: string;

  constructor(options?: AioOptions);
  /** @internal */
  constructor(options: AioOptions, scope: ScopeInit);
  constructor(options: AioOptions = {}, scope?: ScopeInit) {
    if (scope) {
      const parent = containerOf(scope.parent);
      this.namespace = parent.runtime.namespace;
      this.#bind(parent.runtime, [...parent.layers, scopePart(scope.overrides)], false);
      return;
    }
    const namespace = options.namespace ?? 'default';
    if (!NAMESPACE.test(namespace))
      throw new ConfigError(
        'CONFIG_INVALID',
        'invalid namespace: use 1 to 64 letters, digits, dots, underscores or hyphens',
      );
    const clock = options.clock ?? systemClock;
    const log = options.logger ?? createLogger();
    const catalogs = createCatalogs();
    for (const plugin of [...builtinPlugins(), ...(options.plugins ?? [])])
      applyPlugin(catalogs, plugin);
    const env = options.env === false ? {} : (options.env ?? process.env);
    const events = new EventBus(clock, log);
    // eslint-disable-next-line prefer-const -- closures below read it after assignment
    let runtime: RootRuntime;
    const pool = new DriverPool({
      catalogs: () => runtime.catalogs,
      clock,
      events,
      log,
      transport: () => runtime.transport,
    });
    runtime = {
      namespace,
      catalogs,
      envLayer: {
        chains: readEnvChains(
          env,
          catalogs.chains.list().map((c) => c.id),
          options.profile,
        ),
      },
      env,
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      clock,
      log,
      events,
      stores: {
        ...createMemoryStores(clock),
        ...(Object.fromEntries(
          Object.entries(options.stores ?? {}).filter(([, store]) => store !== undefined),
        ) as Partial<Stores>),
      },
      pool,
      assets: new AssetService(() => runtime.catalogs),
      transport: options.transport ?? {},
      owner: randomId('aio'),
      closed: false,
      closing: new AbortController(),
      natives: new Set(),
    };
    this.namespace = namespace;
    this.#bind(runtime, [scopePart(options)], true);
  }

  /**
   * Child container: inherits config, pool, stores and namespace; overrides merge on top.
   * Not a tenant boundary — a scope shares its root's pool and stores. Use a separate
   * `new CryptoAio({ namespace })` when isolation between tenants is required.
   */
  scope(overrides: ScopeOptions): CryptoAio {
    return new CryptoAio({}, { parent: this, overrides });
  }

  blockchain<C extends ChainId>(config: HandleConfig<C>): Blockchain<C> {
    const internals = containerOf(this);
    const { runtime } = internals;
    const selection = resolveSelection({
      handle: config as HandleOptions,
      effective: internals.effective(),
      catalogs: runtime.catalogs,
      log: runtime.log,
    });
    let pooled: Promise<PooledDriver> | undefined;
    let wallet: Promise<ResolvedWallet> | undefined;
    const handle: HandleInternals = {
      container: this,
      selection,
      nativeClients: new Map(),
      assertOpen: () => {
        if (runtime.closed) throw closedError();
      },
      registerNative: (native) => {
        if (runtime.closed) throw closedError();
        if (native.close) runtime.natives.add(() => native.close?.());
      },
      // A closed root refuses work even through a pooled driver this handle holds.
      pooled: () => {
        if (runtime.closed) return Promise.reject(closedError());
        pooled ??= runtime.pool.get(selection).catch((error: unknown) => {
          pooled = undefined;
          throw error;
        });
        return pooled;
      },
      wallet: () => {
        if (runtime.closed) return Promise.reject(closedError());
        wallet ??= handle
          .pooled()
          .then(({ driver }) =>
            resolveWallet(
              selection,
              driver,
              internals.effective().signers,
              runtime.catalogs.schemes,
              internals.signerDeadline(),
            ),
          )
          .catch((error: unknown) => {
            wallet = undefined;
            throw error;
          });
        return wallet;
      },
    };
    return new Blockchain<C>(handle);
  }

  /** Registers a plugin on this root container (copy-on-write catalogs). */
  use(plugin: Plugin): this {
    const internals = containerOf(this);
    if (!internals.isRoot)
      throw new ConfigError(
        'CONFIG_INVALID',
        'plugins can only be added to a root container',
      );
    const { runtime } = internals;
    const next = cloneCatalogs(runtime.catalogs);
    applyPlugin(next, plugin);
    runtime.catalogs = next;
    runtime.envLayer = {
      chains: readEnvChains(
        runtime.env,
        next.chains.list().map((c) => c.id),
        runtime.profile,
      ),
    };
    return this;
  }

  on<E extends AioEventName>(type: E, handler: (event: AioEvent<E>) => void): () => void {
    return containerOf(this).runtime.events.on(type, handler);
  }

  onAny(handler: (event: AioEvent) => void): () => void {
    return containerOf(this).runtime.events.onAny(handler);
  }

  /** Stored Operations of this namespace, as views, and startup recovery. */
  get operations(): OperationsApi {
    const internals = containerOf(this);
    const store = internals.runtime.stores.operations;
    const namespace = internals.runtime.namespace;
    const view = async (record: OperationRecord) =>
      toView(record, await loadObservations(store, record));
    return {
      get: async (id) => {
        const record = await store.get(namespace, id);
        return record ? view(record) : null;
      },
      list: async (filter = {}) =>
        Promise.all(
          (
            await store.list({
              namespace,
              ...(filter.states ? { states: filter.states } : {}),
              ...(filter.chain ? { chain: filter.chain } : {}),
              ...(filter.network ? { network: filter.network } : {}),
              ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
            })
          ).map(view),
        ),
      recover: async (options = {}) =>
        internals.monitor().recover({
          ...options,
          signal: workerSignal(internals.runtime, options.signal),
        }),
    };
  }

  /** Background workers that check due Operations without anyone waiting on them. */
  get monitor(): MonitorApi {
    const internals = containerOf(this);
    return {
      start: async (options = {}) =>
        internals.monitor().start({
          ...options,
          signal: workerSignal(internals.runtime, options.signal),
        }),
      runOnce: async (options = {}) =>
        internals.monitor().runOnce({
          workerId: options.workerId ?? internals.runtime.owner,
          ...(options.batch !== undefined ? { batch: options.batch } : {}),
          signal: workerSignal(internals.runtime, options.signal),
        }),
    };
  }

  /**
   * Closes the root container: runs the `close` of every native client that
   * `crypto-aio/native` handed out (a failing one is logged by code and skipped), then
   * closes the pooled drivers. Its handles and `native()` then fail with
   * `INVALID_TRANSITION`. A scope's `close()` does nothing; scopes share their root's pool.
   */
  async close(): Promise<void> {
    const internals = containerOf(this);
    if (!internals.isRoot) return;
    const { runtime } = internals;
    runtime.closed = true;
    // Every worker loop, pass and recovery stops at its next check, and its sleeps end.
    runtime.closing.abort();
    const natives = [...runtime.natives];
    runtime.natives.clear();
    await Promise.all(
      natives.map(async (close) => {
        try {
          const outcome = await closeWithin(
            close,
            runtime.clock,
            NATIVE_CLOSE_TIMEOUT_MS,
          );
          if (outcome === 'timeout') {
            runtime.log.warn('native client close timed out', {
              timeoutMs: NATIVE_CLOSE_TIMEOUT_MS,
            });
          }
        } catch (error) {
          runtime.log.warn('native client close failed', { code: errorCode(error) });
        }
      }),
    );
    await runtime.pool.close();
  }

  #bind(runtime: RootRuntime, layers: readonly ScopeOptions[], isRoot: boolean): void {
    const effective = () => mergeScopes([runtime.envLayer, ...layers]);
    let engine: OperationEngine | undefined;
    let monitor: Monitor | undefined;
    const getEngine = () => (engine ??= createEngine(runtime, effective));
    const wallets = walletCache(runtime, () => containerOf(this));
    bindContainer(this, {
      runtime,
      layers,
      isRoot,
      effective,
      signerDeadline: () => ({
        clock: runtime.clock,
        timeoutMs: withLifecycleDefaults(effective().lifecycle).signTimeoutMs,
      }),
      engine: getEngine,
      monitor: () =>
        (monitor ??= new Monitor({
          engine: getEngine(),
          stores: runtime.stores,
          events: runtime.events,
          clock: runtime.clock,
          log: runtime.log.child('monitor'),
          namespace: runtime.namespace,
          lifecycle: () => withLifecycleDefaults(effective().lifecycle),
          resolveRead: (record) => readTarget(this, record),
          resolveTarget: (record) => operationTarget(this, runtime, record, wallets),
        })),
    });
  }
}
