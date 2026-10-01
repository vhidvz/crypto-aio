/**
 * `crypto-aio/ton`: the SDK-free TON types, the family's peer dependencies and
 * capabilities, and the `crypto-aio/native` client type: importing this entry types
 * `native(bc, '@ton/ton')` as a `TonClient`.
 *
 * @module crypto-aio/ton
 */
import type { TonClient } from '@ton/ton';

// Through the package entry, as users augment 'crypto-aio'. SDK types appear only here.
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
  TonSeqnoOrdering,
  TonWalletIdentity,
  TonWalletVersion,
} from './types';
