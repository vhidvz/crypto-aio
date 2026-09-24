import type { ResolvedSelection } from '../config/types';
import type { CryptoAio } from '../container/container';
import type { PooledDriver } from '../container/pool';
import { ConfigError } from '../errors/error';
import type { ResolvedWallet } from '../signing/wallet';

export interface HandleInternals {
  readonly container: CryptoAio;
  readonly selection: ResolvedSelection;
  pooled(): Promise<PooledDriver>;
  wallet(): Promise<ResolvedWallet>;
  /** Per-handle native SDK clients for `crypto-aio/native` (never shared). */
  readonly nativeClients: Map<string, unknown>;
}

const registry = new WeakMap<object, HandleInternals>();

export function bindInternals(handle: object, internals: HandleInternals): void {
  registry.set(handle, internals);
}

export function internalsOf(handle: object): HandleInternals {
  const internals = registry.get(handle);
  if (!internals)
    throw new ConfigError('CONFIG_INVALID', 'not a crypto-aio Blockchain handle');
  return internals;
}
