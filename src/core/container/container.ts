import { AssetService } from '../assets/service';
import { Blockchain } from '../blockchain/handle';
import type { HandleInternals } from '../blockchain/internal';
import { readEnvChains } from '../config/env';
import { isPlainObject, mergeScopes } from '../config/merge';
import { resolveSelection } from '../config/resolve';
import type {
  AioOptions,
  EffectiveOptions,
  HandleConfig,
  HandleOptions,
  ScopeOptions,
} from '../config/types';
import { ConfigError } from '../errors/error';
import { EventBus } from '../events/bus';
import { createLogger } from '../events/logger';
import type { AioEvent, AioEventName } from '../events/types';
import { OperationEngine, errorCode, withLifecycleDefaults } from '../lifecycle/engine';
import { Monitor } from '../lifecycle/monitor';
import type { ChainId } from '../model/ids';
import { SequenceCoordinator } from '../ordering/sequence';
import {
  applyPlugin,
  cloneCatalogs,
  createCatalogs,
  type Plugin,
} from '../registry/plugin';
import { SigningOrchestrator } from '../signing/orchestrator';
import { resolveWallet, type ResolvedWallet } from '../signing/wallet';
import { createMemoryStores } from '../store/memory';
import type { Stores } from '../store/types';
import { randomId } from '../util/bytes';
import { systemClock } from '../util/clock';
import { builtinPlugins } from './builtins';
import { bindContainer, containerOf, type RootRuntime } from './internals';
import { DriverPool, type PooledDriver } from './pool';

const NAMESPACE = /^[A-Za-z0-9._-]{1,64}$/;

interface ScopeInit {
  readonly parent: CryptoAio;
  readonly overrides: ScopeOptions;
}

/**
 * Deep-clones plain objects/arrays into a frozen copy so a later mutation of the caller's
 * own input can never reach a layer already captured by a container. Class instances
 * (Signer, Secret, ...) are referenced, not cloned — they're already immutable.
 */
function cloneFrozen<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item: unknown) => cloneFrozen(item))) as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = cloneFrozen(v);
    return Object.freeze(out) as T;
  }
  return value;
}

/** M4/N7: `chains`/`providers`/`wallets`/`signers`/`hooks`/`lifecycle` are all cloned and
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
      throw new ConfigError('CONFIG_INVALID', `invalid namespace '${namespace}'`);
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
      pooled: () => {
        pooled ??= runtime.pool.get(selection).catch((error: unknown) => {
          pooled = undefined;
          throw error;
        });
        return pooled;
      },
      wallet: () => {
        wallet ??= handle
          .pooled()
          .then(({ driver }) =>
            resolveWallet(
              selection,
              driver,
              internals.effective().signers,
              runtime.catalogs.schemes,
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

  /** Closes pooled drivers (root only; scopes share their root's pool). */
  async close(): Promise<void> {
    const internals = containerOf(this);
    if (internals.isRoot) await internals.runtime.pool.close();
  }

  #bind(runtime: RootRuntime, layers: readonly ScopeOptions[], isRoot: boolean): void {
    const effective = () => mergeScopes([runtime.envLayer, ...layers]);
    let engine: OperationEngine | undefined;
    let monitor: Monitor | undefined;
    const getEngine = () => (engine ??= createEngine(runtime, effective));
    bindContainer(this, {
      runtime,
      layers,
      isRoot,
      effective,
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
        })),
    });
  }
}
