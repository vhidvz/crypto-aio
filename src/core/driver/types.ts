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
  /** Throws `ValidationError('INVALID_ADDRESS')`. */
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
  /** Current view of an Attempt (uses `purpose: 'monitor'` reads). */
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

/** Finalized-state checks behind `proven` verdicts; implementations use quorum reads. */
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
  /** A fresh, caller-owned SDK client for `crypto-aio/native`; never the pooled one. */
  createNativeClient?(): unknown;
  close?(): Promise<void>;
}

/**
 * M12: a factory's `create()` must call `transport.setProbes(...)` exactly once, before any
 * other traffic, on every `Transport` it receives here — including `indexer`, when present.
 * `setProbes` resets health/identity state, so calling it again later, or skipping it on one
 * of the two transports, leaves that transport's health checks silently unconfigured.
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
