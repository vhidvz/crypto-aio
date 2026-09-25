import type { ErrorCode } from '../errors/codes';
import type { SigningRequest } from '../signing/types';
import type { Address } from './address';
import type { Amount } from './amount';
import type { AssetInfo, AssetRef } from './asset';
import type { FeeEstimateDraft } from './fee';
import type { IntentSummary } from './intent';
import type { OrderingData } from './ordering';

/** Protocol data only (bytes or protocol JSON), never SDK objects. */
export interface RawTx {
  readonly encoding: 'hex' | 'base64' | 'json';
  readonly data: string;
}

export type AttemptIdKind = 'tx-hash' | 'txid' | 'signature' | 'message-hash';

/** Identity of a signed payload. `canonical: false` = not the final protocol tx hash (TON). */
export interface AttemptRef {
  readonly id: string;
  readonly idKind: AttemptIdKind;
  readonly canonical: boolean;
}

export type TxState =
  | 'unknown'
  | 'pending'
  | 'mempool'
  | 'included'
  | 'final'
  | 'failed'
  | 'dropped'
  | 'replaced'
  | 'expired'
  | 'refused'
  | 'rejected';

export type Evidence = 'observed' | 'proven';
export type Finality = 'none' | 'probabilistic' | 'final';

export interface TxStatus {
  readonly state: TxState;
  readonly evidence: Evidence;
  readonly confirmations: number;
  readonly txHash?: string;
  readonly blockHash?: string;
  readonly blockHeight?: bigint;
  readonly finality: Finality;
  readonly reason?: string;
  readonly replacedBy?: string;
}

export interface BlockRef {
  readonly height: bigint;
  readonly hash: string;
  readonly timestamp?: number;
}

export interface Block {
  readonly height: bigint;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp?: number;
  readonly transactionIds?: readonly string[];
}

export type TransferSource = 'native' | 'token-event' | 'internal';

interface TransferBase {
  /** Deterministic: `${txId}:${locator}`. */
  readonly id: string;
  readonly from: readonly Address[];
  readonly to: Address;
  readonly source: TransferSource;
  readonly memo?: string;
}

/** A transfer whose asset resolved on this chain and network. */
export interface ResolvedTransfer extends TransferBase {
  readonly asset: AssetInfo;
  readonly amount: Amount;
  readonly unresolved?: undefined;
}

/**
 * R35: a transfer whose asset could not be resolved, for example a token with unusable
 * metadata or a failing decimals call. It has no `asset` and no `amount`: without the
 * asset's decimals there is no `Amount`. `unresolved` keeps the chain's raw data instead,
 * and the transaction's `decoding` is `'partial'`. A read never fails on such a transfer;
 * only a retryable failure fails the read, so it can be retried.
 */
export interface UnresolvedTransfer extends TransferBase {
  readonly asset?: undefined;
  readonly amount?: undefined;
  readonly unresolved: {
    /** The asset as the chain names it. */
    readonly asset: AssetRef;
    /** The amount in base units, never scaled. */
    readonly amount: bigint;
    /** Why the asset did not resolve, e.g. `ASSET_RESOLUTION`. */
    readonly code: ErrorCode;
  };
}

/** Check `unresolved` (or `amount`) before using a transfer's `asset` and `amount`. */
export type Transfer = ResolvedTransfer | UnresolvedTransfer;

export type Decoding = 'complete' | 'partial' | 'none';

export interface Transaction {
  readonly id: string;
  readonly chain: string;
  readonly network: string;
  readonly status: TxStatus;
  readonly block?: BlockRef;
  readonly fee?: readonly Amount[];
  readonly transfers: readonly Transfer[];
  readonly decoding: Decoding;
  readonly raw?: RawTx;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface UnsignedTx {
  readonly payload: RawTx;
  /** Only when identity is fixed before signing (Tron; UTXO with witness-only inputs). */
  readonly expectedRef?: AttemptRef;
  readonly signingRequests: readonly SigningRequest[];
  readonly ordering: OrderingData;
  readonly fee: FeeEstimateDraft;
  readonly summary: IntentSummary;
}

export interface SignedTx {
  readonly raw: RawTx;
  readonly ref: AttemptRef;
}
