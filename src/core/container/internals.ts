import type { AssetService } from '../assets/service';
import type { EffectiveOptions, ScopeOptions } from '../config/types';
import { ConfigError } from '../errors/error';
import type { EventBus } from '../events/bus';
import type { Logger } from '../events/logger';
import type { Catalogs } from '../registry/plugin';
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
}

export interface ContainerInternals {
  readonly runtime: RootRuntime;
  readonly layers: readonly ScopeOptions[];
  readonly isRoot: boolean;
  effective(): EffectiveOptions;
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
