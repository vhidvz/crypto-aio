/**
 * SDK-free types of the UTXO family: the `ext.utxo` API, fee details and overrides, wallet
 * options, and the Esplora wire types the driver reads (spec §15). Nothing here imports an
 * SDK, so the composition root can export these types.
 */
import type { FeeSpeed } from '../../core/model/fee';
import type { CallOptions } from '../../core/transport/types';

// R37: augment the registries through the package entry, as users do with 'crypto-aio'.
declare module '../../index' {
  interface ChainRegistry {
    bitcoin: {
      family: 'utxo';
      network: 'mainnet' | 'testnet' | 'testnet4' | 'signet' | 'regtest';
    };
  }
  interface FamilyRegistry {
    utxo: { library: 'bitcoinjs-lib'; ext: UtxoExt; fee: UtxoFeeDetails };
  }
}

/** A network's address encoding: the bech32 human-readable part and base58 version bytes. */
export interface AddressParams {
  readonly bech32: string;
  readonly pubKeyHash: number;
  readonly scriptHash: number;
}

/** The address (and so the input) type of a UTXO wallet; `p2wpkh` is the default. */
export type UtxoAddressType = 'p2wpkh' | 'p2sh-p2wpkh' | 'p2pkh' | 'p2tr';

/** Every standard output type a UTXO transfer may pay to (spec §6.4 variants). */
export type UtxoOutputType = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr';

/** `WalletConfig.utxo` (spec §9). */
export interface UtxoWalletOptions {
  readonly addressType?: UtxoAddressType;
  /**
   * Where change goes; default: the wallet's own address. It must be derivable from the
   * wallet's key (any of the four address types), unless `allowExternalChangeAddress` is set.
   */
  readonly changeAddress?: string;
  /**
   * A19: send change to a `changeAddress` the wallet's key does not derive (default `false`).
   * An additive deviation from spec §9: without it, a valid but mistyped address is refused.
   */
  readonly allowExternalChangeAddress?: boolean;
}

/** `FeeEstimate.details` of the `utxo` fee kind. */
export interface UtxoFeeDetails {
  /** The fee rate in satoshis per 1,000 virtual bytes (Bitcoin Core's unit). */
  readonly satPerKvB: bigint;
  /** Virtual size of the transaction, counting worst-case (72-byte) ECDSA signatures. */
  readonly vsize: number;
  readonly inputs: number;
  /** Outputs including change. */
  readonly outputs: number;
  /** The change amount; `0n` when there is no change output. */
  readonly change: bigint;
  /** Index of the change output, or `-1` when there is none. */
  readonly changeIndex: number;
}

/**
 * An explicit UTXO fee (`TransferIntent.fee`): satoshis per virtual byte, as a bigint or a
 * decimal string with at most three fractional digits (e.g. `'1.5'`).
 */
export type UtxoFeeOverride = { readonly satPerVByte: bigint | string };

/** An unspent output of an address, as `ext.utxo.listUnspent` reports it. */
export interface UtxoUnspent {
  /** `txid:vout`, the reservation key of this output. */
  readonly outpoint: string;
  readonly txid: string;
  readonly vout: number;
  readonly value: bigint;
  readonly confirmed: boolean;
  readonly blockHeight?: bigint;
}

export interface UtxoSelectionRequest {
  readonly from: string;
  readonly outputs: readonly { readonly to: string; readonly amount: bigint }[];
  readonly fee?: FeeSpeed | UtxoFeeOverride;
  /** Outpoints to leave out (e.g. those held by live Operations). */
  readonly exclude?: readonly string[];
}

/** A dry run of the configured coin selection. */
export interface UtxoSelectionPreview {
  /** The outputs it would spend (every eligible one when `sufficient` is `false`). */
  readonly inputs: readonly { readonly outpoint: string; readonly value: bigint }[];
  readonly fee: bigint;
  readonly satPerKvB: bigint;
  readonly vsize: number;
  readonly change: bigint;
  /** `false` when the eligible outputs cannot pay for the outputs and the fee. */
  readonly sufficient: boolean;
}

/** `bc.ext.utxo`: the UTXO family extension (spec §5.5). */
export interface UtxoExt {
  readonly utxo: {
    /** Unspent outputs of an address (indexer), confirmed first, oldest first. */
    listUnspent(address: string): Promise<readonly UtxoUnspent[]>;
    /** What the configured coin selection would pick for these outputs. Signs nothing. */
    coinSelection(request: UtxoSelectionRequest): Promise<UtxoSelectionPreview>;
  };
}

/** The transport tags every UTXO I/O call carries (R41). */
export type UtxoCallTags = Pick<
  CallOptions,
  'purpose' | 'retry' | 'quorum' | 'quorumKey' | 'fanout' | 'signal'
>;

/** Esplora's `status` object of a transaction or of a spending transaction. */
export interface EsploraStatus {
  readonly confirmed: boolean;
  readonly blockHeight?: bigint;
  readonly blockHash?: string;
  readonly blockTime?: number;
}

export interface EsploraOutput {
  readonly script: string;
  readonly type: string;
  readonly address?: string;
  readonly value: bigint;
}

export interface EsploraInput {
  readonly txid: string;
  readonly vout: number;
  readonly coinbase: boolean;
  readonly sequence: number;
  /** `undefined` for a coinbase input. */
  readonly prevout?: EsploraOutput;
}

export interface EsploraTx {
  readonly txid: string;
  readonly version: number;
  readonly locktime: number;
  readonly weight: number;
  readonly fee: bigint;
  readonly vin: readonly EsploraInput[];
  readonly vout: readonly EsploraOutput[];
  readonly status: EsploraStatus;
}

export interface EsploraBlock {
  readonly hash: string;
  readonly height: bigint;
  readonly parentHash: string;
  readonly timestamp: number;
  readonly txCount: number;
}

export interface EsploraOutspend {
  readonly spent: boolean;
  readonly txid?: string;
  readonly vin?: number;
  readonly status?: EsploraStatus;
}

export interface EsploraUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly value: bigint;
  readonly status: EsploraStatus;
}

export interface EsploraAddressStats {
  readonly funded: bigint;
  readonly spent: bigint;
}
