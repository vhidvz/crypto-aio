import type { ResolvedSelection } from '../config/types';
import type { CryptoAio } from '../container/container';
import type { PooledDriver } from '../container/pool';
import type { DisposableNativeClient } from '../driver/types';
import { ConfigError } from '../errors/error';
import type { ResolvedWallet } from '../signing/wallet';

export interface HandleInternals {
  readonly container: CryptoAio;
  readonly selection: ResolvedSelection;
  pooled(): Promise<PooledDriver>;
  wallet(): Promise<ResolvedWallet>;
  /** Per-handle native SDK clients for `crypto-aio/native` (never shared). */
  readonly nativeClients: Map<string, unknown>;
  /** R34: throws `StateError('INVALID_TRANSITION')` once the root container is closed. */
  assertOpen(): void;
  /** R34: the root's `close()` will run this client's `close` (throws once it is closed). */
  registerNative(native: DisposableNativeClient): void;
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
