/**
 * `crypto-aio/avalanche`: the SDK-free Avalanche types, the family's peer dependency and
 * capabilities, and the `crypto-aio/native` client type: importing this entry types
 * `native(bc, '@avalabs/avalanchejs')` as an {@link AvalancheNativeClient}.
 *
 * @module crypto-aio/avalanche
 */
import type { AvalancheNativeClient } from './driver';

// R37: through the package entry. SDK types appear only here (spec §5.6).
declare module '../../index' {
  interface NativeClientMap {
    '@avalabs/avalanchejs': AvalancheNativeClient;
  }
}

export type { AvalancheNativeClient } from './driver';
export { AVALANCHE_PEER_DEPENDENCIES } from './plugin';
export { AVALANCHE_CAPABILITIES } from './network';
export type {
  AvalancheExt,
  AvalancheFeeDetails,
  AvalancheFeeOverride,
  AvalancheUnspent,
  AvalancheVm,
} from './types';
