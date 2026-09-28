/**
 * `crypto-aio/utxo`: the SDK-free UTXO types, the family's peer dependency and
 * capabilities, and the `crypto-aio/native` client type: importing this entry types
 * `native(bc, 'bitcoinjs-lib')` as a {@link UtxoNativeClient}.
 *
 * @module crypto-aio/utxo
 */
import type { UtxoNativeClient } from './driver';

// R37: through the package entry. SDK types appear only here (spec §5.6).
declare module '../../index' {
  interface NativeClientMap {
    'bitcoinjs-lib': UtxoNativeClient;
  }
}

export type { UtxoNativeClient } from './driver';
export { UTXO_PEER_DEPENDENCIES } from './plugin';
export { UTXO_CAPABILITIES } from './network';
export type {
  UtxoAddressType,
  UtxoExt,
  UtxoFeeDetails,
  UtxoFeeOverride,
  UtxoOutputType,
  UtxoSelectionPreview,
  UtxoSelectionRequest,
  UtxoUnspent,
  UtxoWalletOptions,
} from './types';
