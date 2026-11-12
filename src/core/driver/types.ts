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
  TxFailure,
  UnsignedTx,
} from '../model/transaction';
import type { KeyRef, SignatureBundle } from '../signing/types';
import type { Transport } from '../transport/types';
import type { Clock } from '../util/clock';

/**
 * Family-specific wallet settings (e.g. `utxo.addressType`, TON wallet identity). The `hd`
 * key is reserved and core-built: the core sets it to the wallet's `WalletHdOptions` when
 * the wallet has an `xpub`, and a user's or caller's `hd` never reaches a driver, since a
 * driver trusts `hd` to validate change addresses.
 */
export type WalletOptions = Readonly<Record<string, unknown>>;

/** One public key of the sending wallet, with the scheme it signs with. */
export interface WalletKey {
  readonly scheme: string;
  readonly publicKey: Uint8Array;
  /** Where the signer finds the private key, for a signer that holds several. */
  readonly keyRef?: KeyRef;
}

/** What a build needs besides the intent: the sender, its keys and its wallet options. */
export interface BuildContext {
  /** The sending address, as the driver's `normalize` returned it. */
  readonly from: string;
  readonly keys: readonly WalletKey[];
  readonly wallet: WalletOptions;
  /** Allocated by the core for `nonce` and `seqno` ordering. */
  readonly ordering?: OrderingData;
  /** Inputs held by other live Operations of this wallet (`inputs` ordering). */
  readonly excludeInputs?: readonly string[];
  /**
   * The decimals the core scaled the intent's amounts with: the asset's registered
   * metadata, or what the chain gave. Drivers work in base units. One whose transaction
   * signs the decimals (Solana's `transferChecked`) reads them from the chain and must
   * refuse a mismatch with this value (`ASSET_RESOLUTION`): the amounts were then scaled
   * wrong. Absent where no transfer is built (a replacement or a cancel).
   */
  readonly decimals?: number;
  readonly signal?: AbortSignal;
}

/** Whether the sender holds what the transfer and its fee need; when not, the shortfall. */
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
 * The core records one endpoint's `rejected` as proven evidence and fails the Operation
 * with `TX_REJECTED`, after which a caller may pay again, so a driver returns it only once
 * it has checked that the reason holds for its own bytes; anything less certain is
 * `refused`.
 */
export type BroadcastResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'already-known' }
  | { readonly kind: 'refused'; readonly code: CodesOf<'chain'>; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/** What one read shows of a transaction: nothing yet, a mempool entry, or a block. */
export interface DriverTxObservation {
  readonly seen: 'none' | 'mempool' | 'block';
  /** The canonical hash the chain reports for the transaction, once seen. */
  readonly txHash?: string;
  readonly blockHeight?: bigint;
  readonly blockHash?: string;
  /** For included transactions: false when execution failed or reverted. */
  readonly success?: boolean;
  /**
   * With `success: false`, why, as a short fixed text: no addresses, amounts or node
   * text, which can carry either. The monitor records it on the observation
   * (`TxStatus.reason`).
   */
  readonly reason?: string;
  /**
   * With `success: false`, what failed (`TxFailure`). Absent is `'reverted'`; a driver sets
   * `'unevidenced'` when the transaction executed but shows no transfer to the recipient.
   */
  readonly failure?: TxFailure;
}

/** One movement of value a transaction makes, in base units. */
export interface DriverTransfer {
  /**
   * Deterministic within the transaction, e.g. `native`, `log:3`, `vout:1`, `ix:0.2`. A
   * deposit's id is `${txId}:${locator}`, which callers credit once by, so a driver gives a
   * transfer the same locator from the scanner, `getTransaction` and `history`, from every
   * provider, and in every later version of the driver.
   */
  readonly locator: string;
  /** The senders, as the driver's `normalize` returns them. */
  readonly from: readonly string[];
  readonly to: string;
  readonly asset: AssetRef;
  readonly amount: bigint;
  /** Where the transfer was read from, such as the native value or a token event. */
  readonly source: TransferSource;
  readonly memo?: string;
}

/** A transaction as a driver decodes it. */
export interface DriverTransaction {
  readonly id: string;
  readonly observation: DriverTxObservation;
  /** What the transaction paid, per asset; absent while unknown. */
  readonly fee?: readonly { readonly asset: AssetRef; readonly amount: bigint }[];
  readonly transfers: readonly DriverTransfer[];
  /** Whether `transfers` lists every movement the transaction makes. */
  readonly decoding: Decoding;
  readonly raw?: RawTx;
  /** The block's time, as the chain reports it. */
  readonly timestamp?: number;
  /** Family-specific fields, passed through to `Transaction.details`. */
  readonly details: Readonly<Record<string, unknown>>;
}

/** A block header as a driver reads it, with its transaction ids when the read has them. */
export interface DriverBlock {
  readonly height: bigint;
  readonly hash: string;
  readonly parentHash: string;
  /** The block's time, as the chain reports it. */
  readonly timestamp?: number;
  readonly transactionIds?: readonly string[];
}

/** The chain's address rules: validation, the canonical form, and derivation from a key. */
export interface AddressCodec {
  /** Whether `address` is valid on the network; never throws. */
  validate(address: string): boolean;
  /**
   * Throws `ValidationError('INVALID_ADDRESS')`. The returned `variant` is part of the
   * intent hash: it must hold only JSON scalars (strings, finite numbers, booleans, `null`)
   * and should contain only semantic fields that change what the transfer does (for example
   * TON's `bounceable`), never encoding-only choices, so two spellings of one recipient
   * with the same meaning hash the same.
   *
   * Its output feeds the intent hash behind idempotency keys and the sequence keys of
   * nonce state, both of which a store keeps across upgrades: a later version of the
   * driver returns the same `canonical` and `variant` for the same input.
   */
  normalize(address: string): NormalizedAddress;
  /** The wallet's address for `publicKey`, under the wallet's options (address type, ...). */
  fromPublicKey(publicKey: Uint8Array, wallet?: WalletOptions): NormalizedAddress;
  /** Formats an address for display, such as a checksummed or user-friendly form. */
  readonly format?: AddressFormatter;
}

/** Reads of chain state; the contract table on `ChainDriver` gives each one's call tags. */
export interface ChainReader {
  /** The balance of `asset` at `address`, in base units. */
  getBalance(address: string, asset: AssetRef): Promise<bigint>;
  /** The head's height. */
  getBlockHeight(): Promise<bigint>;
  /**
   * Highest block satisfying the network's finality policy: the chain's own finality
   * where it has one, else the head less the confirmations the network requires.
   */
  getFinalizedHeight(): Promise<bigint>;
  /** A block by height or hash, or `null` when there is none. */
  getBlock(ref: bigint | string): Promise<DriverBlock | null>;
  /** A transaction by id, decoded, or `null` when the chain does not have it. */
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
  /** A token's symbol and decimals, read from the chain (the `tokens` capability). */
  getTokenMetadata?(ref: TokenRef): Promise<AssetMetadata>;
  /**
   * Canonicalizes a token contract (e.g. EIP-55); identity for asset ids. Asset ids feed
   * the intent hash, so a later version of the driver keeps the same canonical form.
   */
  normalizeTokenRef?(ref: TokenRef): TokenRef;
}

/** Builds transactions; the contract table on `ChainDriver` gives each one's call tags. */
export interface TxBuilder {
  /** The fee the intent's transaction would pay at the intent's speed or override. */
  estimateFee(intent: DriverIntent, ctx: BuildContext): Promise<FeeEstimateDraft>;
  /** Whether the sender can pay the transfer and `fee`. */
  checkFunds(
    intent: DriverIntent,
    fee: FeeEstimateDraft,
    ctx: BuildContext,
  ): Promise<FundsCheck>;
  /**
   * The unsigned transaction. Its `summary` must describe exactly what its payload pays
   * (asset, outputs, memo): `beforeSign` policies judge the summary, never the bytes.
   */
  build(
    intent: DriverIntent,
    fee: FeeEstimateDraft,
    ctx: BuildContext,
  ): Promise<UnsignedTx>;
  /**
   * The signed transaction from `unsigned` and its signatures. Its `ref` is the id the
   * chain will report for it.
   *
   * `unsigned` may have been stored by an earlier version of the driver: a driver keeps
   * assembling, replacing and cancelling every `UnsignedTx` and `OrderingData` it ever
   * stored, since recovery resumes them after an upgrade.
   */
  assemble(
    unsigned: UnsignedTx,
    signatures: readonly SignatureBundle[],
  ): Promise<SignedTx>;
  /**
   * The signatures a payload signed elsewhere carries for `unsigned`'s requests,
   * e.g. a PSBT a cold signer returned. No I/O. Throws `ValidationError('INVALID_INTENT')`
   * when `signed` is not the prepared transaction; one it does not tell apart still fails
   * the core's check with `SIGNATURE_MISMATCH`. Only signature bytes are taken from it: the
   * core verifies each one against its stored request, as for any bundle. A request
   * without a signature in `signed` is left out (a partial set).
   */
  signaturesFrom?(unsigned: UnsignedTx, signed: RawTx): readonly SignatureBundle[];
}

/** Sends signed transactions to the network. */
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

/** The chain state a proof reads: the head, or the finalized part of the chain. */
export type FinalityLevel = 'latest' | 'finalized';

/**
 * Finalized-state checks behind `proven` verdicts; implementations use quorum reads.
 * Only a definitive negative proof answers "no". Every other RPC error (state or
 * history not available, pruned data, indexing in progress, a non-definitive error) throws
 * a retryable `ProviderError('PROVIDER_UNAVAILABLE')`, which decides nothing.
 */
export interface ProofSource {
  /** The finalized block the proof reads stand on. */
  finalizedHead(): Promise<{
    readonly height: bigint;
    readonly hash: string;
    readonly timestamp?: number;
  }>;
  /** Whether the Attempt's transaction is in a finalized block, and how it executed. */
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
        /**
         * With `success: false`, a short fixed text, never node text. It is recorded as
         * proven.
         */
        readonly reason?: string;
        /** With `success: false`, what failed, as `DriverTxObservation.failure`. */
        readonly failure?: TxFailure;
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
   * The hash of the block at `height` on the chain at `level`, or `null` when there is
   * none yet (above the head, or above the finalized height for `'finalized'`). Confirms
   * the monitor's orphan decisions and the scanner's rollback and TOO_DEEP verdicts.
   */
  blockHash(height: bigint, level: FinalityLevel): Promise<string | null>;
}

/** The chain's view of an address's next nonce or seqno (`nonce` and `seqno` ordering). */
export interface SequenceSource {
  /** Next nonce/seqno including pending transactions. */
  pending(address: string): Promise<bigint>;
  /** Next nonce/seqno per the latest block. */
  latest(address: string): Promise<bigint>;
}

/** Whether and how an Attempt's slot can be taken by another transaction. */
export interface ReplacementPolicy {
  /** Whether a pending transfer can be replaced at a higher fee (`replace-fee`). */
  readonly replace: boolean;
  /** Whether a pending transfer can be cancelled (`cancel`). */
  readonly cancel: boolean;
  /** `previous`'s transfer again, in its slot, at `fee`; `FEE_TOO_LOW` below the bump. */
  buildReplacement?(
    previous: UnsignedTx,
    fee: FeeSpeed | FeeOverride,
    ctx: BuildContext,
  ): Promise<UnsignedTx>;
  /**
   * A transaction for `previous`'s slot that does not execute the transfer (e.g. a
   * self-transfer). Without `fee` it pays the network's minimum bump over `previous`; with
   * one, that fee, refused (FEE_TOO_LOW) below the bump. `previous` may itself be a cancel
   * (a repeat cancel bumps a stuck one).
   */
  buildCancel?(
    previous: UnsignedTx,
    ctx: BuildContext,
    fee?: FeeSpeed | FeeOverride,
  ): Promise<UnsignedTx>;
  /**
   * Orders two transactions of one slot by the price a node compares when one replaces
   * the other: negative when `a` pays less, positive when it pays more, `0` when neither
   * does. A repeat cancel bumps from the highest earlier cancel by this order; without it,
   * the core compares their total charges, which a gas limit can skew.
   */
  comparePrice?(a: UnsignedTx, b: UnsignedTx): number;
}

/** What a scan watches; the rules are on `ChainDriver`. */
export interface ScanFilter {
  readonly addresses?: readonly string[];
  readonly assets?: readonly AssetRef[];
}

/** Blocks for the scanner (`block-scan`); heights are dense, as `ChainDriver` says. */
export interface BlockSource {
  /** The block at `height`, or `null` while it is not visible. */
  header(height: bigint): Promise<DriverBlock | null>;
  /** The decoded transactions of `block`, narrowed by `filter`. */
  transactions(
    block: DriverBlock,
    filter?: ScanFilter,
  ): Promise<readonly DriverTransaction[]>;
}

/** An address's transactions, newest first, a page at a time (`address-history`). */
export interface AddressHistorySource {
  /** A page of at most `limit` transactions after `cursor`, and the cursor of the next. */
  list(
    address: string,
    options: { readonly cursor?: string; readonly limit: number },
  ): Promise<{ readonly items: readonly DriverTransaction[]; readonly next?: string }>;
}

/** What one transaction of a wallet can hold. */
export interface DriverLimits {
  /** The most outputs one transfer may pay. */
  readonly maxOutputs: number;
}

/**
 * A native SDK client for `crypto-aio/native` and how to release it. `close` frees
 * what the client holds (sockets, timers, workers); the root container's `close()` runs it
 * once, before closing its pooled drivers.
 */
export interface DisposableNativeClient {
  readonly client: unknown;
  close?(): void | Promise<void>;
}

/**
 * The driver port: every method's contract, as the core relies on it. Purpose, retry
 * class and quorum are the `CallOptions` a driver passes to its `Transport` (defaults:
 * purpose `read`, retry `safe`, no quorum). A `monitor` or `proof` read only goes to
 * endpoints that are not lagging.
 *
 * | Method | Purpose | Retry | Quorum | Returns / throws |
 * | --- | --- | --- | --- | --- |
 * | `reader.getBalance`, `getBlock`, `getTransaction` | `read` | `safe` | none | `null` when not found; provider errors propagate |
 * | `reader.getTokenMetadata` | `read` | `safe` | none (a driver may use a quorum) | A token's own unusable metadata (no contract, a reverting or malformed `decimals`/`symbol`) throws `ValidationError('ASSET_RESOLUTION')`, which the core caches per container (only a non-retryable `ASSET_RESOLUTION` is cached); every other failure, e.g. a transient provider failure (propagated retryable) or any other provider error, is not cached and the next lookup queries again. Stricter than this minimum, the EVM driver reads `decimals()` and `symbol()` under `quorum: 'proof'`: the metadata is cached for the container's life, and one endpoint's wrong `decimals` would mis-scale every amount; endpoints that disagree throw retryable `PROVIDER_INCONSISTENT`, which is not cached |
 * | `reader.getBlockHeight`, `getFinalizedHeight` | `monitor` | `safe` | none | propagate; they feed the stale-view guards and confirmation depths |
 * | `reader.observe(ref, ordering, from)` | `monitor` | `safe` | none | `{ seen: 'none' }` when not visible; `ordering` and `from` are `undefined` for a transaction the library does not manage |
 * | `sequence.pending`, `sequence.latest` | `monitor` | `safe` | none | propagate |
 * | `proofs.*` (`finalizedHead`, `includedFinal`, `slotConsumed`, `expired`, `blockHash`) | `proof` | `safe` | `'proof'` | endpoints that disagree throw retryable `PROVIDER_INCONSISTENT`, and the core then decides nothing. Only a definitive negative proof answers "no"; every other RPC error throws retryable `PROVIDER_UNAVAILABLE`, which decides nothing (see below). Only `slotConsumed(…, 'latest')` may be a single `monitor` read: the core records it as observed evidence |
 * | `broadcaster.broadcast` | `broadcast` | `ambiguous-on-failure` | none (passes `fanout` and `signal` through) | classifies a definitive `RPC_ERROR` into a `BroadcastResult`; rethrows an ambiguous one (`error.ambiguous`) and every other failure unclassified |
 * | `builder.estimateFee`, `checkFunds`, `build` | `read` | `safe` | none | `ValidationError` / `UnsupportedCapabilityError` for an intent it cannot build |
 * | `builder.assemble` | no I/O | – | – | `SigningError('SIGNING_FAILED')` when a signature is missing |
 * | `builder.signaturesFrom` (optional) | no I/O | – | – | `ValidationError('INVALID_INTENT')` when the signed payload is not the prepared transaction |
 * | `replacement.buildReplacement`, `buildCancel` | `read` | `safe` | none | `ChainError('FEE_TOO_LOW')` below the network's bump; `buildCancel` honours a given `fee` and never substitutes its own |
 * | `blocks.header` | `monitor` | `safe` | none | `null` while the height is not visible |
 * | `blocks.transactions` | `monitor` | `safe` | none | retryable `PROVIDER_INCONSISTENT` when the block at `block.height` no longer has `block.hash` |
 * | `history.list` | `read` (indexer transport when configured) | `safe` | none | propagate |
 * | `createNativeClient` | no I/O | – | – | a fresh SDK instance on every call, never the pooled one |
 * | `signingSchemes` (optional) | no I/O | – | – | `ConfigError('CONFIG_INVALID')` for wallet options it refuses |
 *
 * Further rules:
 * - On a proof path (`proofs.*`), only a definitive negative proof may
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
 *   fee spec there, so a driver never sets or reads it.
 * - `DriverContext` has no asset resolver and `DriverIntent` carries no decimals. Amounts
 *   reach drivers in base units only; `BuildContext.decimals` says which decimals the core
 *   scaled them with, and a driver whose transaction signs decimals (Solana's
 *   `transferChecked`) refuses a mismatch with the chain's.
 * - What a driver gave the core stays readable: deposit locators, `normalize` output and
 *   canonical token refs stay the same, and every `UnsignedTx` and `OrderingData` an earlier
 *   version stored can still be assembled, replaced, cancelled and proven.
 */
export interface ChainDriver {
  /** How Attempts claim a slot; it must be the chain's `ChainInfo.ordering`. */
  readonly ordering: OrderingKind;
  /**
   * The capabilities the driver implements. When the pool creates a driver it refuses
   * (`CONFIG_INVALID`) one that lacks a capability its handle grants (the manifest's, the
   * indexer's when one is configured, and the network's additions) or whose `ordering` is
   * not the chain's. Each optional port backs one: `block-scan` needs `blocks`,
   * `address-history` needs `history`, `replace-fee` and `cancel` need `replacement`,
   * `expiry` needs `proofs.expired`, `tokens` needs `reader.getTokenMetadata`.
   */
  readonly capabilities: ReadonlySet<Capability>;
  readonly address: AddressCodec;
  readonly reader: ChainReader;
  readonly builder: TxBuilder;
  readonly broadcaster: Broadcaster;
  readonly proofs: ProofSource;
  /** Required for `nonce` and `seqno` ordering. */
  readonly sequence?: SequenceSource;
  readonly replacement?: ReplacementPolicy;
  readonly blocks?: BlockSource;
  readonly history?: AddressHistorySource;
  /**
   * Two-level family API: `ext.<family>.<method>(...) → Promise`. `bc.ext` calls a method the
   * driver has and refuses any other with `UNSUPPORTED_CAPABILITY`; no capability gates it.
   */
  readonly ext?: Readonly<
    Record<string, Readonly<Record<string, (...args: never[]) => Promise<unknown>>>>
  >;
  /** What one transaction of a wallet with these options can hold. */
  limits?(wallet: WalletOptions): DriverLimits;
  /**
   * The signature schemes a wallet with these options signs with, when its options narrow
   * the chain's `schemes` (a Bitcoin `p2tr` wallet signs with `secp256k1-schnorr` only). No
   * I/O; it throws `CONFIG_INVALID` for options the driver refuses. When the core resolves
   * a wallet that has a signer, it refuses (`CONFIG_INVALID`) one that does not declare each
   * of them, before reading any key: the transfer would otherwise be built, reserved and
   * fail only at signing. Without this method, a signer needs one of the chain's schemes.
   * A watch-only wallet is not checked.
   */
  signingSchemes?(wallet: WalletOptions): readonly string[];
  /**
   * A fresh, caller-owned SDK client for `crypto-aio/native`: a new SDK instance on every
   * call, never the pooled one.
   */
  createNativeClient?(): DisposableNativeClient;
  /** Releases what the driver holds; the root container's `close()` calls it once. */
  close?(): Promise<void>;
}

/**
 * A factory's `create()` must call `transport.setProbes(...)` exactly once, before any
 * other traffic, on every `Transport` it receives here — including `indexer`, when present.
 * `setProbes` resets health/identity state, so calling it again later, or skipping it on one
 * of the two transports, leaves that transport's health checks silently unconfigured.
 *
 * There is no asset resolver here, and `DriverIntent` carries no decimals: drivers work
 * in base units only (`BuildContext.decimals` says how the core scaled them).
 */
export interface DriverContext {
  readonly chain: ChainInfo;
  readonly network: NetworkInfo;
  /** The SDK library the handle selected, such as `ethers`. */
  readonly library: string;
  /** The `provider` endpoints. */
  readonly transport: Transport;
  /** The `indexer` endpoints, when the handle has any. */
  readonly indexer?: Transport;
  readonly clock: Clock;
  readonly log: Logger;
  /** The driver options: the chain config's `options` with the handle's over them. */
  readonly options: Readonly<Record<string, unknown>>;
}

/** What a manifest's `load()` returns: makes one driver per pooled selection. */
export interface DriverFactory {
  create(ctx: DriverContext): Promise<ChainDriver>;
}

/** An SDK package a library needs installed, with the version range it supports. */
export interface PeerDependency {
  readonly name: string;
  readonly range: string;
}

/** Static metadata (no SDK import) plus a lazy `load()` that `require()`s the driver module. */
export interface AdapterManifest {
  /**
   * The chain family, and the key the manifest registers under. A plugin chain of a
   * built-in family registers its own, such as `evm:<name>`.
   */
  readonly family: string;
  /** The SDK library; the first manifest registered for a chain is its default library. */
  readonly library: string;
  /** The chain ids it serves. */
  readonly chains: readonly string[];
  /** The capabilities a handle on it has, before the network adds or removes any. */
  readonly capabilities: readonly Capability[];
  /** Further capabilities a handle has when it has an `indexer` provider. */
  readonly indexerCapabilities?: readonly Capability[];
  /**
   * Whether a handle needs an `indexer` provider; without one it falls back to the
   * `public` preset, or fails with `CONFIG_INVALID` when the network has none.
   */
  readonly requiresIndexer?: boolean;
  /** Checked when `load()` runs: a missing package fails with `DEPENDENCY_MISSING`. */
  readonly peerDependencies: readonly PeerDependency[];
  /** Loads the driver module (and its SDK) on first use. */
  load(): Promise<DriverFactory>;
}
