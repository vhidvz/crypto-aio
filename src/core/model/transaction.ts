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

/** What an Attempt's id is: a transaction hash or txid, a signature (Solana), or a message hash (TON). */
export type AttemptIdKind = 'tx-hash' | 'txid' | 'signature' | 'message-hash';

/** Identity of a signed payload. `canonical: false` = not the final protocol tx hash (TON). */
export interface AttemptRef {
  /** The id, as the chain spells it. */
  readonly id: string;
  readonly idKind: AttemptIdKind;
  /** Whether `id` is the transaction hash the chain reports once it is included. */
  readonly canonical: boolean;
}

/**
 * What the chain shows of a transaction: `unknown`, `pending` (sent or signed, not seen yet), `mempool`,
 * `included`, `final`, `failed`, `dropped` (no longer seen), `replaced` (another
 * transaction took its slot), `expired`, `refused` (a node refused it for now) or
 * `rejected` (never valid). `dropped` and `refused` are never terminal.
 */
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

/**
 * How a status was established: `observed` (one endpoint's current view, which can change)
 * or `proven` (finalized chain data read under the proof quorum).
 */
export type Evidence = 'observed' | 'proven';

/**
 * What failed in an included transaction: `'reverted'` when its execution failed, so
 * nothing moved but the fee, and `'unevidenced'` when it executed but the chain shows no
 * transfer to the recipient (a token that logged none, a jetton sent to a wallet its master
 * does not name): value may have moved, so check the chain before paying again.
 */
export type TxFailure = 'reverted' | 'unevidenced';
/** How settled a transaction is: not in a block, in a block that can still leave, or final. */
export type Finality = 'none' | 'probabilistic' | 'final';

/** A transaction's status. Complete a withdrawal only on `final` with `proven` evidence. */
export interface TxStatus {
  readonly state: TxState;
  readonly evidence: Evidence;
  readonly confirmations: number;
  /** The canonical transaction hash, once seen. */
  readonly txHash?: string;
  readonly blockHash?: string;
  readonly blockHeight?: bigint;
  readonly finality: Finality;
  /**
   * Why the transaction did not go through. Present only with `failed`, `refused` or
   * `rejected`. It is either a broadcast's refusal or rejection text, or the chain
   * driver's text for an on-chain failure. It is a short, fixed text with no addresses,
   * amounts or node detail. It is `sensitive` data, so it never appears in events
   * or logs.
   */
  readonly reason?: string;
  /** With `replaced`: the transaction that took its slot. */
  readonly replacedBy?: string;
}

/**
 * The block a transaction is in. `timestamp` is the block's time as the chain records it,
 * in Unix seconds on every family (Tron's milliseconds are converted).
 */
export interface BlockRef {
  readonly height: bigint;
  readonly hash: string;
  readonly timestamp?: number;
}

/**
 * A block. `timestamp` is its time as the chain records it, in Unix seconds on every
 * family (Tron's milliseconds are converted).
 */
export interface Block {
  readonly height: bigint;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp?: number;
  readonly transactionIds?: readonly string[];
}

/** Where a transfer was read from: the native value, a token's event, or an internal call. */
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
 * A transfer whose asset could not be resolved, for example a token with unusable
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

/**
 * Whether `transfers` lists every movement of value (`complete`), some of them
 * (`partial`: an unresolved asset or a call the family does not decode), or none.
 */
export type Decoding = 'complete' | 'partial' | 'none';

/** A transaction as a handle reads it. */
export interface Transaction {
  readonly id: string;
  readonly chain: string;
  readonly network: string;
  readonly status: TxStatus;
  readonly block?: BlockRef;
  /** What it paid, per asset; absent while unknown. */
  readonly fee?: readonly Amount[];
  readonly transfers: readonly Transfer[];
  readonly decoding: Decoding;
  readonly raw?: RawTx;
  /** Family-specific fields; not covered by semver beyond what each network page documents. */
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * A transaction built and not yet signed: its payload, the signatures it needs, the slot it
 * takes, its fee and what it pays. A driver's `summary` describes exactly what the payload
 * pays: `beforeSign` policies judge the summary, never the bytes.
 */
export interface UnsignedTx {
  readonly payload: RawTx;
  /** Only when identity is fixed before signing (Tron; UTXO with witness-only inputs). */
  readonly expectedRef?: AttemptRef;
  readonly signingRequests: readonly SigningRequest[];
  readonly ordering: OrderingData;
  readonly fee: FeeEstimateDraft;
  readonly summary: IntentSummary;
}

/** A signed transaction: its bytes, and its id as the chain will report it. */
export interface SignedTx {
  readonly raw: RawTx;
  readonly ref: AttemptRef;
}
