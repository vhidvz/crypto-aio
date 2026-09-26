import type { CodesOf } from '../errors/codes';
import type { Logger } from '../events/logger';
import type { AddressFormatter, NormalizedAddress } from '../model/address';
import type { AssetMetadata, AssetRef, TokenRef } from '../model/asset';
import type { Capability } from '../model/capability';
import type { ChainInfo, NetworkInfo } from '../model/chain';
import type { FeeEstimateDraft, FeeOverride, FeeSpeed } from '../model/fee';
import type { DriverIntent } from '../model/intent';
import type { OrderingData, OrderingKind } from '../model/ordering';
import type {
  AttemptRef,
  Decoding,
  RawTx,
  SignedTx,
  TransferSource,
  UnsignedTx,
} from '../model/transaction';
import type { KeyRef, SignatureBundle } from '../signing/types';
import type { Transport } from '../transport/types';
import type { Clock } from '../util/clock';

/** Family-specific wallet settings (e.g. `utxo.addressType`, TON wallet identity). */
export type WalletOptions = Readonly<Record<string, unknown>>;

export interface WalletKey {
  readonly scheme: string;
  readonly publicKey: Uint8Array;
  readonly keyRef?: KeyRef;
}

export interface BuildContext {
  readonly from: string;
  readonly keys: readonly WalletKey[];
  readonly wallet: WalletOptions;
  /** Allocated by the core for `nonce` and `seqno` ordering. */
  readonly ordering?: OrderingData;
  /** Inputs held by other live Operations of this wallet (`inputs` ordering). */
  readonly excludeInputs?: readonly string[];
  readonly signal?: AbortSignal;
}

export type FundsCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly asset: AssetRef;
      readonly required: bigint;
      readonly available: bigint;
    };

/**
 * `refused`: state-dependent (may become valid, or may already be included) — observed only.
 * `rejected`: permanently invalid by construction (malformed, bad signature, wrong chain).
 */
export type BroadcastResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'already-known' }
  | { readonly kind: 'refused'; readonly code: CodesOf<'chain'>; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string };

export interface DriverTxObservation {
  readonly seen: 'none' | 'mempool' | 'block';
  readonly txHash?: string;
  readonly blockHeight?: bigint;
  readonly blockHash?: string;
  /** For included transactions: false when execution failed or reverted. */
  readonly success?: boolean;
  readonly reason?: string;
}

export interface DriverTransfer {
  /** Deterministic within the transaction, e.g. `native`, `log:3`, `vout:1`, `ix:0.2`. */
  readonly locator: string;
  readonly from: readonly string[];
  readonly to: string;
  readonly asset: AssetRef;
  readonly amount: bigint;
  readonly source: TransferSource;
  readonly memo?: string;
}

export interface DriverTransaction {
  readonly id: string;
  readonly observation: DriverTxObservation;
  readonly fee?: readonly { readonly asset: AssetRef; readonly amount: bigint }[];
  readonly transfers: readonly DriverTransfer[];
  readonly decoding: Decoding;
  readonly raw?: RawTx;
  readonly timestamp?: number;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface DriverBlock {
  readonly height: bigint;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp?: number;
  readonly transactionIds?: readonly string[];
}

export interface AddressCodec {
  validate(address: string): boolean;
  /**
   * Throws `ValidationError('INVALID_ADDRESS')`. The returned `variant` is part of the
   * intent hash: it must hold only JSON scalars (strings, finite numbers, booleans, `null`)
   * and should contain only semantic fields that change what the transfer does (for example
   * TON's `bounceable`), never encoding-only choices, so two spellings of one recipient
   * with the same meaning hash the same.
   */
  normalize(address: string): NormalizedAddress;
  fromPublicKey(publicKey: Uint8Array, wallet?: WalletOptions): NormalizedAddress;
  readonly format?: AddressFormatter;
}

export interface ChainReader {
  getBalance(address: string, asset: AssetRef): Promise<bigint>;
  getBlockHeight(): Promise<bigint>;
  /** Highest block satisfying the network's finality policy. */
  getFinalizedHeight(): Promise<bigint>;
  getBlock(ref: bigint | string): Promise<DriverBlock | null>;
  getTransaction(id: string): Promise<DriverTransaction | null>;
  /**
   * Current view of an Attempt (uses `purpose: 'monitor'` reads). `ordering` and `from` are
   * `undefined` for a transaction the library does not manage (a status lookup by id).
   */
  observe(
    ref: AttemptRef,
    ordering: OrderingData | undefined,
    from: string | undefined,
  ): Promise<DriverTxObservation>;
  getTokenMetadata?(ref: TokenRef): Promise<AssetMetadata>;
  /** Canonicalizes a token contract (e.g. EIP-55); identity for asset ids. */
  normalizeTokenRef?(ref: TokenRef): TokenRef;
}

export interface TxBuilder {
  estimateFee(intent: DriverIntent, ctx: BuildContext): Promise<FeeEstimateDraft>;
  checkFunds(
    intent: DriverIntent,
    fee: FeeEstimateDraft,
    ctx: BuildContext,
  ): Promise<FundsCheck>;
  build(
    intent: DriverIntent,
    fee: FeeEstimateDraft,
    ctx: BuildContext,
  ): Promise<UnsignedTx>;
  assemble(
    unsigned: UnsignedTx,
    signatures: readonly SignatureBundle[],
  ): Promise<SignedTx>;
  /**
   * P3-B (A6): the signatures a payload signed elsewhere carries for `unsigned`'s requests,
   * e.g. a PSBT a cold signer returned. No I/O. Throws `ValidationError('INVALID_INTENT')`
   * when `signed` is not the prepared transaction; one it does not tell apart still fails
   * the core's check with `SIGNATURE_MISMATCH`. Only signature bytes are taken from it: the
   * core verifies each one against its stored request (R9), as for any bundle. A request
   * without a signature in `signed` is left out (a partial set).
   */
  signaturesFrom?(unsigned: UnsignedTx, signed: RawTx): readonly SignatureBundle[];
}

export interface Broadcaster {
  /**
   * Throws (ambiguous) on transport failure; returns a classified result otherwise.
   * `signed.ref.id` is empty for bare broadcasts (`Blockchain.broadcast`); never rely on it.
   */
  broadcast(
    signed: SignedTx,
    options?: { readonly fanout?: number; readonly signal?: AbortSignal },
  ): Promise<BroadcastResult>;
}

export type FinalityLevel = 'latest' | 'finalized';

/**
 * Finalized-state checks behind `proven` verdicts; implementations use quorum reads.
 * Lesson 18: only a definitive negative proof answers "no". Every other RPC error (state or
 * history not available, pruned data, indexing in progress, a non-definitive error) throws
 * a retryable `ProviderError('PROVIDER_UNAVAILABLE')`, which decides nothing.
 */
export interface ProofSource {
  finalizedHead(): Promise<{
    readonly height: bigint;
    readonly hash: string;
    readonly timestamp?: number;
  }>;
  includedFinal(
    ref: AttemptRef,
    ordering: OrderingData,
    from: string,
  ): Promise<
    | { readonly included: false }
    | {
        readonly included: true;
        readonly success: boolean;
        readonly blockHeight: bigint;
        readonly blockHash: string;
        readonly txHash: string;
      }
  >;
  /** Whether the ordering slot (nonce/seqno/an input) is consumed by ANY transaction at `level`. */
  slotConsumed(
    ordering: OrderingData,
    from: string,
    level: FinalityLevel,
  ): Promise<boolean>;
  /** Whether expiry has passed per finalized state (expiry/seqno models; false otherwise). */
  expired(ordering: OrderingData): Promise<boolean>;
  /**
   * R33: the hash of the block at `height` on the chain at `level`, or `null` when there is
   * none yet (above the head, or above the finalized height for `'finalized'`). Confirms
   * the monitor's orphan decisions and the scanner's rollback and TOO_DEEP verdicts.
   */
  blockHash(height: bigint, level: FinalityLevel): Promise<string | null>;
}

export interface SequenceSource {
  /** Next nonce/seqno including pending transactions. */
  pending(address: string): Promise<bigint>;
  /** Next nonce/seqno per the latest block. */
  latest(address: string): Promise<bigint>;
}

export interface ReplacementPolicy {
  readonly replace: boolean;
  readonly cancel: boolean;
  buildReplacement?(
    previous: UnsignedTx,
    fee: FeeSpeed | FeeOverride,
    ctx: BuildContext,
  ): Promise<UnsignedTx>;
  /**
   * A transaction for `previous`'s slot that does not execute the transfer (e.g. a
   * self-transfer). Without `fee` it pays the network's minimum bump over `previous`; with
   * one, that fee, refused (FEE_TOO_LOW) below the bump. `previous` may itself be a cancel
   * (R30: a repeat cancel bumps a stuck one).
   */
  buildCancel?(
    previous: UnsignedTx,
    ctx: BuildContext,
    fee?: FeeSpeed | FeeOverride,
  ): Promise<UnsignedTx>;
}

export interface ScanFilter {
  readonly addresses?: readonly string[];
  readonly assets?: readonly AssetRef[];
}

export interface BlockSource {
  header(height: bigint): Promise<DriverBlock | null>;
  transactions(
    block: DriverBlock,
    filter?: ScanFilter,
  ): Promise<readonly DriverTransaction[]>;
}

export interface AddressHistorySource {
  list(
    address: string,
    options: { readonly cursor?: string; readonly limit: number },
  ): Promise<{ readonly items: readonly DriverTransaction[]; readonly next?: string }>;
}

export interface DriverLimits {
  readonly maxOutputs: number;
}

/**
 * R34: a native SDK client for `crypto-aio/native` and how to release it. `close` frees
 * what the client holds (sockets, timers, workers); the root container's `close()` runs it
 * once, before closing its pooled drivers.
 */
export interface DisposableNativeClient {
  readonly client: unknown;
  close?(): void | Promise<void>;
}

/**
 * The driver port. I4: every method's contract, as the core relies on it. Purpose, retry
 * class and quorum are the `CallOptions` a driver passes to its `Transport` (defaults:
 * purpose `read`, retry `safe`, no quorum). A `monitor` or `proof` read only goes to
 * endpoints that are not lagging.
 *
 * | Method | Purpose | Retry | Quorum | Returns / throws |
 * | --- | --- | --- | --- | --- |
 * | `reader.getBalance`, `getBlock`, `getTransaction` | `read` | `safe` | none | `null` when not found; provider errors propagate |
 * | `reader.getTokenMetadata` | `read` | `safe` | none (a driver may use a quorum) | N6: a token's own unusable metadata (no contract, a reverting or malformed `decimals`/`symbol`) throws `ValidationError('ASSET_RESOLUTION')`, which the core caches per container (R53: only a non-retryable `ASSET_RESOLUTION` is cached); every other failure, e.g. a transient provider failure (propagated retryable) or any other provider error, is not cached and the next lookup queries again. Stricter than this minimum, the EVM driver reads `decimals()` and `symbol()` under `quorum: 'proof'` (M4): the metadata is cached for the container's life, and one endpoint's wrong `decimals` would mis-scale every amount; endpoints that disagree throw retryable `PROVIDER_INCONSISTENT`, which is not cached |
 * | `reader.getBlockHeight`, `getFinalizedHeight` | `monitor` | `safe` | none | propagate; they feed the stale-view guards and confirmation depths |
 * | `reader.observe(ref, ordering, from)` | `monitor` | `safe` | none | `{ seen: 'none' }` when not visible; `ordering` and `from` are `undefined` for a transaction the library does not manage |
 * | `sequence.pending`, `sequence.latest` | `monitor` | `safe` | none | propagate |
 * | `proofs.*` (`finalizedHead`, `includedFinal`, `slotConsumed`, `expired`, `blockHash`) | `proof` | `safe` | `'proof'` | endpoints that disagree throw retryable `PROVIDER_INCONSISTENT`, and the core then decides nothing. Lesson 18: only a definitive negative proof answers "no"; every other RPC error throws retryable `PROVIDER_UNAVAILABLE`, which decides nothing (see below). Only `slotConsumed(…, 'latest')` may be a single `monitor` read: the core records it as observed evidence |
 * | `broadcaster.broadcast` | `broadcast` | `ambiguous-on-failure` | none (passes `fanout` and `signal` through) | classifies a definitive `RPC_ERROR` into a `BroadcastResult`; rethrows an ambiguous one (`error.ambiguous`) and every other failure unclassified |
 * | `builder.estimateFee`, `checkFunds`, `build` | `read` | `safe` | none | `ValidationError` / `UnsupportedCapabilityError` for an intent it cannot build |
 * | `builder.assemble` | no I/O | – | – | `SigningError('SIGNING_FAILED')` when a signature is missing |
 * | `builder.signaturesFrom` (optional) | no I/O | – | – | `ValidationError('INVALID_INTENT')` when the signed payload is not the prepared transaction |
 * | `replacement.buildReplacement`, `buildCancel` | `read` | `safe` | none | `ChainError('FEE_TOO_LOW')` below the network's bump; `buildCancel` honours a given `fee` and never substitutes its own |
 * | `blocks.header` | `monitor` | `safe` | none | `null` while the height is not visible |
 * | `blocks.transactions` | `monitor` | `safe` | none | retryable `PROVIDER_INCONSISTENT` when the block at `block.height` no longer has `block.hash` |
 * | `history.list` | `read` (indexer transport when configured) | `safe` | none | propagate |
 * | `createNativeClient` | no I/O | – | – | a fresh SDK instance on every call, never the pooled one |
 *
 * Further rules:
 * - Lesson 18, widened: on a proof path (`proofs.*`), only a definitive negative proof may
 *   answer "no" (`included: false`, a slot not consumed, a `null` block hash). Every other
 *   RPC error, including state or history not available, pruned data, an index still being
 *   built ("transaction indexing is in progress"), or an endpoint's non-definitive error,
 *   must surface as a retryable `ProviderError('PROVIDER_UNAVAILABLE')`, which decides
 *   nothing: the core looks again later and never takes it for an answer.
 * - `BlockSource` heights are dense: every height up to the head has one block, and
 *   `header(h)` is `null` only while `h` is not visible, never for a skipped slot.
 * - A provider must serve headers at least about 2 × `reorgWindow` below the head. A new
 *   cursor loads `reorgWindow` blocks below its start, and a rollback refills its window
 *   below the common ancestor.
 * - `ScanFilter.addresses`: when non-empty, return at least every transaction with a transfer
 *   from or to one of them; empty (`[]`) or absent means no filter. `ScanFilter.assets` is a
 *   hint only: a driver may narrow by it or ignore it, and the core does not filter again.
 * - `fee.details.requestedFee` is reserved. On replacements the core records the requested
 *   fee spec there (R30), so a driver never sets or reads it.
 * - M10 (open; Plan 4 decides): `DriverContext` has no asset resolver and `DriverIntent`
 *   carries no decimals. Amounts reach drivers in base units only.
 */
export interface ChainDriver {
  readonly ordering: OrderingKind;
  readonly capabilities: ReadonlySet<Capability>;
  readonly address: AddressCodec;
  readonly reader: ChainReader;
  readonly builder: TxBuilder;
  readonly broadcaster: Broadcaster;
  readonly proofs: ProofSource;
  readonly sequence?: SequenceSource;
  readonly replacement?: ReplacementPolicy;
  readonly blocks?: BlockSource;
  readonly history?: AddressHistorySource;
  /** Two-level, capability-gated family API: `ext.<family>.<method>(...) → Promise`. */
  readonly ext?: Readonly<
    Record<string, Readonly<Record<string, (...args: never[]) => Promise<unknown>>>>
  >;
  limits?(wallet: WalletOptions): DriverLimits;
  /**
   * A fresh, caller-owned SDK client for `crypto-aio/native`: a new SDK instance on every
   * call, never the pooled one.
   */
  createNativeClient?(): DisposableNativeClient;
  close?(): Promise<void>;
}

/**
 * M12: a factory's `create()` must call `transport.setProbes(...)` exactly once, before any
 * other traffic, on every `Transport` it receives here — including `indexer`, when present.
 * `setProbes` resets health/identity state, so calling it again later, or skipping it on one
 * of the two transports, leaves that transport's health checks silently unconfigured.
 *
 * M10 (open; Plan 4 decides): there is no asset resolver here, and `DriverIntent` carries no
 * decimals.
 */
export interface DriverContext {
  readonly chain: ChainInfo;
  readonly network: NetworkInfo;
  readonly library: string;
  readonly transport: Transport;
  readonly indexer?: Transport;
  readonly clock: Clock;
  readonly log: Logger;
  readonly options: Readonly<Record<string, unknown>>;
}

export interface DriverFactory {
  create(ctx: DriverContext): Promise<ChainDriver>;
}

export interface PeerDependency {
  readonly name: string;
  readonly range: string;
}

/** Static metadata (no SDK import) plus a lazy `load()` that `require()`s the driver module. */
export interface AdapterManifest {
  readonly family: string;
  readonly library: string;
  readonly chains: readonly string[];
  readonly capabilities: readonly Capability[];
  readonly indexerCapabilities?: readonly Capability[];
  readonly requiresIndexer?: boolean;
  readonly peerDependencies: readonly PeerDependency[];
  load(): Promise<DriverFactory>;
}
