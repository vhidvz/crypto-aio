/**
 * SDK-free types of the Tron family: the `ext.tron` API, fee details and overrides, the
 * plain raw-data model the driver builds, and the narrow `TronCodec` strategy that the
 * tronweb module implements (protobuf serialization and the native client only). Nothing
 * here imports an SDK, so the composition root can export these types.
 */
import type { DisposableNativeClient } from '../../core/driver/types';
import type { CallOptions, Transport } from '../../core/transport/types';

// R37: augment the registries through the package entry, as users do with 'crypto-aio'.
declare module '../../index' {
  interface ChainRegistry {
    tron: { family: 'tron'; network: 'mainnet' | 'shasta' | 'nile' };
  }
  interface FamilyRegistry {
    tron: { library: 'tronweb'; ext: TronExt; fee: TronFeeDetails };
  }
}

/** An account's resources (spec §5.5 `ext.tron.getResources`), from `getaccountresource`. */
export interface TronResources {
  /** Whether the account exists on chain (it was activated by a first TRX transfer). */
  readonly activated: boolean;
  /** Free bandwidth left today, in bytes. */
  readonly freeBandwidth: bigint;
  /** Bandwidth left from staked or delegated TRX, in bytes. */
  readonly stakedBandwidth: bigint;
  /** Energy left from staked or delegated TRX. */
  readonly energy: bigint;
}

/** `bc.ext.tron`: the Tron family extension (spec §5.5). */
export interface TronExt {
  readonly tron: {
    /** The account's bandwidth and energy, as the full node reports them now. */
    getResources(address: string): Promise<TronResources>;
  };
}

/**
 * `FeeEstimate.details` of the `tron` fee kind. Sun (1 TRX = 10^6 sun), bytes and energy
 * units. The charges are upper bounds for the account's resources at estimate time.
 */
export interface TronFeeDetails {
  /** Bandwidth the signed transaction consumes, in bytes (its size plus 64). */
  readonly bandwidth: bigint;
  /** The chain's price of one byte of bandwidth, in sun (`getTransactionFee`). */
  readonly bandwidthPrice: bigint;
  /** TRC-20 only: the simulated energy plus the safety margin. */
  readonly energy?: bigint;
  /** TRC-20 only: the chain's price of one energy unit, in sun (`getEnergyFee`). */
  readonly energyPrice?: bigint;
  /**
   * TRC-20 only: `raw_data.fee_limit`, which caps the energy the call may use:
   * min(energy × price, the network's maximum, the handle's `maxFeeLimit`).
   */
  readonly feeLimit?: bigint;
  /** A TRX transfer to an address that is not activated yet pays account creation. */
  readonly activation: boolean;
}

/**
 * An explicit Tron fee (`TransferIntent.fee`): TRC-20 transfers only. `feeLimit` (sun)
 * replaces the estimated fee limit; it may not be lower than the estimated energy cost,
 * because a lower cap makes the transaction fail on chain (`OUT_OF_ENERGY`) and still pay,
 * nor higher than the network's maximum or the handle's `maxFeeLimit` option.
 */
export type TronFeeOverride = { readonly feeLimit: bigint };

/**
 * The expiry ordering a Tron build records (F4-R12, F4-R14, F4-R15): the signed expiration,
 * and the reference block the transaction names for TaPoS. `lastValidHeight` is the height
 * the build-time head claimed plus the TaPoS window (65,536 blocks), so only its low 16 bits
 * are signed (`ref_block_bytes`); `refBlockHash` is the signed `ref_block_hash`. A proof
 * trusts the height only when the solidified block there carries `refBlockHash`; otherwise
 * it searches the heights TaPoS can match. It is a core `expiry` ordering with one more
 * property, which the core stores whole.
 */
export interface TronExpiryOrdering {
  readonly kind: 'expiry';
  /** `raw_data.expiration`, in milliseconds: invalid in a block whose parent is at or past it. */
  readonly expiresAtMs: number;
  /** The reference block's height (as the build-time head claimed it) plus 65,536. */
  readonly lastValidHeight: bigint;
  /** `raw_data.ref_block_hash`: bytes 8..16 of the reference block's id, 16 lower-case hex digits. */
  readonly refBlockHash: string;
}

/**
 * The transport tags every Tron I/O call carries (R41): purpose, retry, quorum, fanout,
 * signal, an optional caller `quorumKey` that replaces the path's default consensus key
 * (lesson 17: a monotone predicate attested at its own height), and `exactIntegers` (A12),
 * which `TronApi` always sets: java-tron answers sun and energy as JSON numbers.
 */
export type TronCallTags = Pick<
  CallOptions,
  'purpose' | 'retry' | 'quorum' | 'quorumKey' | 'exactIntegers' | 'fanout' | 'signal'
>;

/** A TRX transfer (`TransferContract`); addresses are 21-byte hex with the `41` prefix. */
export interface TronTransferContract {
  readonly type: 'TransferContract';
  readonly owner: string;
  readonly to: string;
  /** Sun; at most `Number.MAX_SAFE_INTEGER` (the codec refuses more). */
  readonly amount: bigint;
}

/**
 * A contract call (`TriggerSmartContract`), e.g. a TRC-20 `transfer`. The driver builds calls
 * without value; a chain call may also send TRX or a TRC-10 token, which `readRaw` reports
 * (exactly, and only when non-zero) and `encodeRaw` refuses.
 */
export interface TronTriggerContract {
  readonly type: 'TriggerSmartContract';
  readonly owner: string;
  readonly contract: string;
  /** ABI call data, lower-case hex without `0x`. */
  readonly data: string;
  /** Read only: TRX sent to the contract with the call (`call_value`), in sun. */
  readonly callValue?: bigint;
  /** Read only: a TRC-10 amount sent with the call (`call_token_value`). */
  readonly callTokenValue?: bigint;
  /** Read only: the TRC-10 token id of `callTokenValue` (`token_id`). */
  readonly tokenId?: bigint;
}

export type TronContract = TronTransferContract | TronTriggerContract;

/** `Transaction.raw` as plain data: what the driver builds and the signer's txID covers. */
export interface TronRawData {
  /** Bytes 6..8 of the reference block's id (4 hex digits). */
  readonly refBlockBytes: string;
  /** Bytes 8..16 of the reference block's id (16 hex digits). */
  readonly refBlockHash: string;
  /** Milliseconds since the epoch; the transaction is invalid in a block whose parent is at or past it. */
  readonly expiration: number;
  /** Milliseconds since the epoch, informational. */
  readonly timestamp: number;
  /** TRC-20 calls: the energy cap in sun. */
  readonly feeLimit?: number;
  /** The memo bytes, lower-case hex; absent when there is no memo. */
  readonly data?: string;
  readonly contract: TronContract;
}

/**
 * The SDK part of the Tron driver (spec §15): protobuf work and the native client. Codec
 * methods are synchronous and pure; they never perform I/O.
 */
export interface TronCodec {
  readonly library: 'tronweb';
  /** `Transaction.raw` protobuf bytes as lower-case hex. Throws `ValidationError` on out-of-range values. */
  encodeRaw(raw: TronRawData): string;
  /**
   * Decodes `Transaction.raw` bytes holding exactly one Transfer or TriggerSmartContract.
   * Throws `ValidationError('INVALID_INTENT')` for anything else.
   */
  decodeRaw(hex: string): TronRawData;
  /**
   * Lenient reading of any chain transaction's raw bytes (already bound to its txID): the
   * contract of a Transfer or TriggerSmartContract even with fields this model does not
   * carry (a call's TRX or TRC-10 value is reported), or `null` for other contract types and
   * anything unreadable. Display only: `timestamp` (client-set, so it may be rounded or
   * negative), and `feeLimit` (left out when a number cannot hold it exactly). Never throws.
   */
  readRaw(hex: string): TronRawData | null;
  /** A fresh TronWeb instance whose providers send through `transport` (R34). */
  createNative(transport: Transport): DisposableNativeClient;
}
