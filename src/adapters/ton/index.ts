/**
 * `crypto-aio/ton`: the SDK-free TON types, the family's peer dependencies and
 * capabilities, and the `crypto-aio/native` client type: importing this entry types
 * `native(bc, '@ton/ton')` as a `TonClient`.
 *
 * @module crypto-aio/ton
 */
import type { TonClient } from '@ton/ton';

// R37: through the package entry. SDK types appear only here (spec §5.6).
declare module '../../index' {
  interface NativeClientMap {
    '@ton/ton': TonClient;
  }
}

export { TON_PEER_DEPENDENCIES } from './plugin';
export { TON_CAPABILITIES, TON_INDEXER_CAPABILITIES } from './network';
export type {
  TonExt,
  TonFeeDetails,
  TonFeeOverride,
  TonWalletIdentity,
  TonWalletVersion,
} from './types';
