/**
 * SDK-free types of the TON family: the wallet identity (spec §9), the `ext.ton` API, fee
 * details and overrides, and the transport tags. Nothing here imports an SDK, so the
 * composition root can export these types.
 */
import type { CallOptions } from '../../core/transport/types';

// R37: augment the registries through the package entry, as users do with 'crypto-aio'.
declare module '../../index' {
  interface ChainRegistry {
    ton: { family: 'ton'; network: 'mainnet' | 'testnet' };
  }
  interface FamilyRegistry {
    ton: { library: '@ton/ton'; ext: TonExt; fee: TonFeeDetails };
  }
}

export type TonWalletVersion = 'v4r2' | 'v5r1';

/**
 * The wallet contract behind a TON address (spec §9). Every field determines the address,
 * so it is wallet config (`wallets.<name>.ton`), never a per-call option.
 * - v4r2: `subwalletId` defaults to `698983191 + workchain`.
 * - v5r1: `subwalletNumber` defaults to 0 (15 bits); `networkGlobalId` defaults to the
 *   network's global id (-239 mainnet, -3 testnet) and must equal it.
 */
export type TonWalletIdentity =
  | {
      readonly version: 'v4r2';
      readonly workchain?: 0 | -1;
      readonly subwalletId?: number;
    }
  | {
      readonly version: 'v5r1';
      readonly workchain?: 0 | -1;
      readonly subwalletNumber?: number;
      readonly networkGlobalId?: number;
    };

/** `bc.ext.ton`: the TON family extension (spec §5.5). */
export interface TonExt {
  readonly ton: {
    /** The wallet's seqno at the latest masterchain block; 0 while it is not deployed. */
    getSeqno(address: string): Promise<bigint>;
    /** The jetton wallet that `owner` holds for the jetton `master` (raw form). */
    jettonWallet(owner: string, master: string): Promise<string>;
  };
}

/**
 * `FeeEstimate.details` of the `ton` fee kind, in nanograms. The `network` charge is
 * `importFee + gasFee + storageFee + forwardFee`; a jetton transfer adds an `attached`
 * charge (`attached` per output), whose unspent part the jetton wallet refunds.
 */
export interface TonFeeDetails {
  /** The inbound external message's import fee. */
  readonly importFee: bigint;
  /** The wallet's compute phase, from the endpoint's emulation. */
  readonly gasFee: bigint;
  readonly storageFee: bigint;
  /** The forward fees of every outgoing internal message (full `fwd_fee`), counted once. */
  readonly forwardFee: bigint;
  /**
   * Where `forwardFee` comes from (I3): the endpoint's emulation (`fwd_fee`, which follows
   * the real action list), or, when it reports none, config params 24/25.
   */
  readonly forwardFeeSource: 'emulated' | 'computed';
  /** Jetton transfers: the value attached to each jetton wallet message. */
  readonly attached?: bigint;
  /** Jetton transfers: `forward_ton_amount`, which pays for the recipient's notification. */
  readonly forwardAmount?: bigint;
  /** Whether the message deploys the wallet (its first send carries the `StateInit`). */
  readonly deploy: boolean;
}

/**
 * An explicit TON fee (`TransferIntent.fee`). TON fees are fixed by the network config, so
 * there is nothing to bid; a jetton transfer may change the value attached to each jetton
 * wallet message (default: the network's `jettonAttached`).
 */
export interface TonFeeOverride {
  readonly attached?: bigint;
}

/**
 * The transport tags every TON I/O call carries (R41). A caller's `quorumKey` replaces the
 * call's default consensus key (lesson 17): proofs attest a monotone predicate, such as
 * "my seqno is above n", instead of comparing data read at a moving head.
 */
export type TonCallTags = Pick<
  CallOptions,
  'purpose' | 'retry' | 'quorum' | 'quorumKey' | 'fanout' | 'signal'
>;
