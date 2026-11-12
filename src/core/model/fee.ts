import type { Address } from './address';
import type { Amount } from './amount';
import type { AssetId, AssetRef } from './asset';

/** A fee level the family prices from the network's recent fees. */
export type FeeSpeed = 'slow' | 'normal' | 'fast';
/**
 * Family-specific explicit fee parameters (e.g. `{ maxFeePerGas }`, `{ satPerVByte }`). A
 * plain record through 1.x; each family exports the type of the shape it accepts
 * (`EvmFeeOverride`, `UtxoFeeOverride`, ...).
 */
export type FeeOverride = Readonly<Record<string, unknown>>;
/**
 * How the charges relate to what the transaction will pay: `exact`, `expected` (a likely
 * cost that may move), or `upper` (the most it can pay).
 */
export type FeeBound = 'exact' | 'expected' | 'upper';

/** One charge of a driver's estimate: an asset, an amount in base units, and its purpose. */
export interface FeeChargeDraft {
  readonly asset: AssetRef;
  readonly amount: bigint;
  readonly label: string;
}

/** Driver-level fee estimate (asset refs and base units). */
export interface FeeEstimateDraft {
  /** The fee model, such as `evm-1559`. */
  readonly kind: string;
  readonly speed: FeeSpeed | 'custom';
  readonly charges: readonly FeeChargeDraft[];
  readonly bound: FeeBound;
  /** The paying address, in the driver's canonical form, when the family names it. */
  readonly payer?: string;
  /** The family's fee facts; stored with the Attempt, so plain data only. */
  readonly details: Readonly<Record<string, unknown>>;
}

/** One charge of a fee: an amount and its purpose, such as `network` or `l1-data`. */
export interface FeeCharge {
  readonly amount: Amount;
  readonly label: string;
}

/** What a transfer will pay in fees, from `bc.estimateFee` or a built transaction. */
export interface FeeEstimate {
  /** The fee model, such as `evm-1559` or `utxo`. */
  readonly kind: string;
  /** The speed it was priced at, or `custom` for an explicit override. */
  readonly speed: FeeSpeed | 'custom';
  /** A charge per asset and purpose. */
  readonly charges: readonly FeeCharge[];
  readonly bound: FeeBound;
  /** The address that pays the fee, when the family names it (TON: the sending wallet). */
  readonly payer?: Address;
  /**
   * Family-specific facts (`EvmFeeDetails`, `TronFeeDetails`, ...). A plain record through
   * 1.x; each family exports the type of the fields it sets.
   */
  readonly details: Readonly<Record<string, unknown>>;
}

export function isFeeSpeed(value: unknown): value is FeeSpeed {
  return value === 'slow' || value === 'normal' || value === 'fast';
}

/** Sum of all charges in one asset, or `undefined` when nothing is charged in it. */
export function feeTotal(fee: FeeEstimate, asset: AssetId): Amount | undefined {
  let total: Amount | undefined;
  for (const charge of fee.charges) {
    if (charge.amount.asset.id === asset)
      total = total ? total.plus(charge.amount) : charge.amount;
  }
  return total;
}
