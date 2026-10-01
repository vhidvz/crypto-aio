/**
 * `crypto-aio/avalanche`: the SDK-free Avalanche types, the family's peer dependency and
 * capabilities, and the `crypto-aio/native` client type: importing this entry types
 * `native(bc, '@avalabs/avalanchejs')` as an {@link AvalancheNativeClient}.
 *
 * @module crypto-aio/avalanche
 */
import type { AvalancheNativeClient } from './driver';

// Through the package entry, as a user's own augmentation does, so the two merge in any
// file order. SDK types appear only here, so the main entry needs no SDK to type-check.
declare module '../../index' {
  interface NativeClientMap {
    '@avalabs/avalanchejs': AvalancheNativeClient;
  }
}

export type { AvalancheNativeClient } from './driver';
export { AVALANCHE_PEER_DEPENDENCIES } from './plugin';
export { AVALANCHE_CAPABILITIES } from './network';
/** The part of `@avalabs/avalanchejs` this library uses, as the native client types it. */
export type {
  AvalancheSdk,
  SdkAddress,
  SdkBaseTx,
  SdkBigInt,
  SdkContext,
  SdkCredential,
  SdkDimensions,
  SdkFeeState,
  SdkId,
  SdkInt,
  SdkManager,
  SdkOutputOwners,
  SdkSerializable,
  SdkSignature,
  SdkSignedTx,
  SdkTransaction,
  SdkTransferOutput,
  SdkTransferableInput,
  SdkTransferableOutput,
  SdkUnpacker,
  SdkUnsignedTx,
  SdkUtxo,
  SdkUtxoId,
} from './sdk';
export type {
  AvalancheExt,
  AvalancheFeeDetails,
  AvalancheFeeOverride,
  AvalancheUnspent,
  AvalancheVm,
} from './types';
