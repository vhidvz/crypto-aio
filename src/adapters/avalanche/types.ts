/**
 * SDK-free types of the Avalanche family (the X-Chain and the P-Chain): the `ext.avalanche`
 * API, fee details and overrides. Nothing here imports an SDK, so the composition root can
 * export these types. The C-Chain is an EVM chain (`avalanche`, family `evm`), not part of
 * this family.
 */
import type { CallOptions } from '../../core/transport/types';

// R37: augment the registries through the package entry, as users do with 'crypto-aio'.
declare module '../../index' {
  interface ChainRegistry {
    'avalanche-x': { family: 'avalanche'; network: 'mainnet' | 'fuji' };
    'avalanche-p': { family: 'avalanche'; network: 'mainnet' | 'fuji' };
  }
  interface FamilyRegistry {
    avalanche: {
      library: '@avalabs/avalanchejs';
      ext: AvalancheExt;
      fee: AvalancheFeeDetails;
    };
  }
}

/** Which virtual machine a chain runs: the X-Chain's AVM or the P-Chain's PlatformVM. */
export type AvalancheVm = 'avm' | 'pvm';

/**
 * `FeeEstimate.details` of the `avalanche` fee kind. The X-Chain burns a fixed fee per
 * transaction (`static`); the P-Chain prices gas since the Etna upgrade (`dynamic`). Amounts
 * are in nAVAX (9 decimals).
 */
export interface AvalancheFeeDetails {
  readonly model: 'static' | 'dynamic';
  /** X-Chain: the network's fixed fee per transaction. */
  readonly txFee?: bigint;
  /** P-Chain: the gas price paid, in nAVAX per unit of gas. */
  readonly gasPrice?: bigint;
  /** P-Chain: the gas the transaction uses (its complexity weighed by the network). */
  readonly gas?: bigint;
  readonly inputs: number;
  /** Outputs including change. */
  readonly outputs: number;
  /** The change paid back to the sender; `0n` when there is none. */
  readonly change: bigint;
}

/**
 * An explicit P-Chain fee (`TransferIntent.fee`): the gas price in nAVAX per unit of gas,
 * as a bigint or a decimal integer string. The X-Chain's fee is fixed, so it takes the
 * speeds only.
 */
export type AvalancheFeeOverride = { readonly gasPrice: bigint | string };

/** An output an address owns, as `ext.avalanche.listUnspent` reports it. */
export interface AvalancheUnspent {
  /** `txID:outputIndex`, the reservation key of this output. */
  readonly utxoId: string;
  readonly txId: string;
  readonly outputIndex: number;
  /** The asset's id (cb58); AVAX is the network's `avaxAssetId`. */
  readonly assetId: string;
  readonly amount: bigint;
  /** Unix seconds before which the output cannot be spent; `0n` for none. */
  readonly locktime: bigint;
  /** How many of the output's owners must sign. */
  readonly threshold: number;
  /**
   * Whether a transfer from this address may spend it: AVAX in a plain transfer output,
   * not locked, that this address can sign alone (threshold 1).
   */
  readonly spendable: boolean;
}

/** `bc.ext.avalanche`: the Avalanche family extension (spec §5.5). */
export interface AvalancheExt {
  readonly avalanche: {
    /** The outputs an address owns on this chain (the node's UTXO set), largest first. */
    listUnspent(address: string): Promise<readonly AvalancheUnspent[]>;
  };
}

/** The transport tags every Avalanche I/O call carries (R41). */
export type AvalancheCallTags = Pick<
  CallOptions,
  'purpose' | 'retry' | 'quorum' | 'quorumKey' | 'fanout' | 'signal' | 'exactIntegers'
>;
