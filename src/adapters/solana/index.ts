/**
 * `crypto-aio/solana`: the SDK-free Solana types, and the `crypto-aio/native` client type:
 * importing this entry types `native(bc, '@solana/web3.js')` as a `Connection` wired to the
 * handle's transport (HTTP JSON-RPC only; subscriptions have no transport bridge).
 *
 * @module crypto-aio/solana
 */
import type { Connection } from '@solana/web3.js';

// Augments the package entry's map. SDK types appear only here, so the main entry's
// typings name no SDK.
declare module '../../index' {
  interface NativeClientMap {
    '@solana/web3.js': Connection;
  }
}

export { SOLANA_PEER_DEPENDENCIES } from './plugin';
export { DEFAULT_MAX_COMPUTE_UNIT_PRICE, SOLANA_CAPABILITIES } from './network';
export type {
  SolanaExpiryOrdering,
  SolanaExt,
  SolanaFeeDetails,
  SolanaFeeOverride,
  SolanaTokenAccount,
} from './types';
