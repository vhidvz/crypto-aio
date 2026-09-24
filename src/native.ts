import type { Blockchain } from './core/blockchain/handle';
import { internalsOf } from './core/blockchain/internal';
import { ConfigError, UnsupportedCapabilityError } from './core/errors/error';
import type { ChainId, NativeClientMap } from './core/model/ids';

/**
 * Escape hatch to the underlying SDK client. OUTSIDE the semver guarantees of crypto-aio.
 *
 * The client belongs to this handle only: the driver builds it for the handle on the first
 * call, and later calls on the same handle return that same client. It is never the pooled
 * instance the drivers use, so mutating it cannot affect other handles or tenants, and it is
 * reachable only through this function (not through the handle, `JSON` or `inspect`). The
 * library name must match the handle's (`INCOMPATIBLE_SELECTION` otherwise).
 */
export async function native<
  L extends Extract<keyof NativeClientMap, string>,
  C extends ChainId = ChainId,
>(handle: Blockchain<C>, library: L): Promise<NativeClientMap[L]> {
  const internals = internalsOf(handle);
  if (internals.selection.library !== library) {
    throw new ConfigError(
      'INCOMPATIBLE_SELECTION',
      `this handle uses '${internals.selection.library}', not '${library}'`,
    );
  }
  const cached = internals.nativeClients.get(library);
  if (cached !== undefined) return cached as NativeClientMap[L];
  const { driver } = await internals.pooled();
  // A concurrent call may have built the client while this one awaited the driver.
  const built = internals.nativeClients.get(library);
  if (built !== undefined) return built as NativeClientMap[L];
  if (!driver.createNativeClient) {
    throw new UnsupportedCapabilityError(
      'UNSUPPORTED_CAPABILITY',
      `library '${library}' exposes no native client`,
    );
  }
  const client = driver.createNativeClient();
  internals.nativeClients.set(library, client);
  return client as NativeClientMap[L];
}
