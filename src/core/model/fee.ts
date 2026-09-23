import type { Address } from './address';
import type { Amount } from './amount';
import type { AssetId, AssetRef } from './asset';

export type FeeSpeed = 'slow' | 'normal' | 'fast';
/** Family-specific explicit fee parameters (e.g. `{ maxFeePerGas }`, `{ satPerVByte }`). */
export type FeeOverride = Readonly<Record<string, unknown>>;
export type FeeBound = 'exact' | 'expected' | 'upper';

export interface FeeChargeDraft {
  readonly asset: AssetRef;
  readonly amount: bigint;
  readonly label: string;
}

/** Driver-level fee estimate (asset refs and base units). */
export interface FeeEstimateDraft {
  readonly kind: string;
  readonly speed: FeeSpeed | 'custom';
  readonly charges: readonly FeeChargeDraft[];
  readonly bound: FeeBound;
  readonly payer?: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface FeeCharge {
  readonly amount: Amount;
  readonly label: string;
}

export interface FeeEstimate {
  readonly kind: string;
  readonly speed: FeeSpeed | 'custom';
  readonly charges: readonly FeeCharge[];
  readonly bound: FeeBound;
  readonly payer?: Address;
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
