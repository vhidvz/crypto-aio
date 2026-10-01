import type { AssetService } from '../assets/service';
import type { EffectiveOptions, ScopeOptions } from '../config/types';
import { ConfigError, StateError } from '../errors/error';
import type { EventBus } from '../events/bus';
import type { Logger } from '../events/logger';
import type { OperationEngine } from '../lifecycle/engine';
import type { Monitor } from '../lifecycle/monitor';
import type { Catalogs } from '../registry/plugin';
import type { SignerDeadline } from '../signing/guard';
import type { Stores } from '../store/types';
import type { TransportOptions } from '../transport/types';
import type { Clock } from '../util/clock';
import type { DriverPool } from './pool';

/** State shared by a root container and all of its scopes. */
export interface RootRuntime {
  readonly namespace: string;
  catalogs: Catalogs;
  envLayer: ScopeOptions;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly profile?: string;
  readonly clock: Clock;
  readonly log: Logger;
  readonly events: EventBus;
  readonly stores: Stores;
  readonly pool: DriverPool;
  readonly assets: AssetService;
  readonly transport: TransportOptions;
  /** Owner id used for leases and claims taken by this process. */
  readonly owner: string;
  /**
   * Set by the root's `close()`; a closed container refuses handle and `native()` work.
   */
  closed: boolean;
  /** Aborted by the root's `close()`, which stops every worker loop and recovery. */
  readonly closing: AbortController;
  /** The `close` of every native SDK client handed out, run by the root's `close()`. */
  readonly natives: Set<() => void | Promise<void>>;
}

/** What a closed container's handles and `native()` fail with. */
export function closedError(): StateError {
  return new StateError('INVALID_TRANSITION', 'this crypto-aio container is closed');
}

export interface ContainerInternals {
  readonly runtime: RootRuntime;
  readonly layers: readonly ScopeOptions[];
  readonly isRoot: boolean;
  effective(): EffectiveOptions;
  /** Lazily created per container (scopes have their own hooks and lifecycle settings). */
  engine(): OperationEngine;
  /** Lazily created per container, on top of its engine. */
  monitor(): Monitor;
  /** The bound on a signer's public-key read (this container's `signTimeoutMs`). */
  signerDeadline(): SignerDeadline;
}

const registry = new WeakMap<object, ContainerInternals>();

export function bindContainer(container: object, internals: ContainerInternals): void {
  registry.set(container, internals);
}

export function containerOf(container: object): ContainerInternals {
  const internals = registry.get(container);
  if (!internals) throw new ConfigError('CONFIG_INVALID', 'not a CryptoAio container');
  return internals;
}
