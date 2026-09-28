/**
 * `crypto-aio/tron`: the Tron family's constants and SDK-free types, and the
 * `crypto-aio/native` client type: importing this entry types `native(bc, 'tronweb')` as a
 * `TronWeb` instance whose providers send through the handle's transport.
 *
 * @module crypto-aio/tron
 */
import type { TronWeb } from 'tronweb';

// R37: through the package entry. SDK types appear only here (spec §5.6).
declare module '../../index' {
  interface NativeClientMap {
    tronweb: TronWeb;
  }
}

export { TRON_PEER_DEPENDENCIES } from './plugin';
export {
  DEFAULT_ENERGY_MARGIN_PERCENT,
  DEFAULT_EXPIRATION_MS,
  DEFAULT_MAX_FEE_LIMIT,
  MAX_EXPIRATION_MS,
  MAX_MEMO_BYTES,
  MIN_EXPIRATION_MS,
  TRON_CAPABILITIES,
  TRON_INDEXER_CAPABILITIES,
} from './network';
export type {
  TronExpiryOrdering,
  TronExt,
  TronFeeDetails,
  TronFeeOverride,
  TronResources,
} from './types';
