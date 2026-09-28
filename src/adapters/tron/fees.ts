/**
 * The `tron` fee kind (spec §15), pure: bandwidth, energy, account creation and the memo
 * fee, from the chain's own parameters and the sender's resources. Every charge is in TRX
 * (bigint sun, never a `Number`) and may be 0 (staked or free resources). The rules are
 * java-tron's (Plan 4 appendix; checked against GreatVoyage-v4.8.2.2, `d5c3d1d1`):
 * - bandwidth (`BandwidthProcessor.consume`): the signed size + 64 bytes, from staked
 *   bandwidth, else free bandwidth, else burned at `getTransactionFee` per byte; a transfer
 *   that creates the recipient's account uses staked bandwidth ×
 *   `getCreateNewAccountBandwidthRate`, else burns `getCreateAccountFee`, and pays
 *   `getCreateNewAccountFeeInSystemContract` on top (`TransferActuator`); it never uses
 *   free bandwidth;
 * - energy (`VMActuator.getAccountEnergyLimitWithFixRatio`): `fee_limit / getEnergyFee`
 *   caps the call's energy, staked energy included, so the fee limit covers the whole
 *   simulated energy plus a margin; only the part staked energy does not cover is burned;
 * - a memo pays `getMemoFee` (`Manager.consumeMemoFee`).
 */
import { ConfigError, ValidationError } from '../../core/errors/error';
import {
  isFeeSpeed,
  type FeeChargeDraft,
  type FeeEstimateDraft,
  type FeeOverride,
  type FeeSpeed,
} from '../../core/model/fee';
import type { ChainParameters } from './http';
import type { TronFeeDetails, TronFeeOverride, TronResources } from './types';

export interface TronFeeInput {
  readonly fee: FeeSpeed | FeeOverride;
  readonly params: ChainParameters;
  /** The sender's resources now. */
  readonly resources: TronResources;
  /** Bytes of bandwidth: an upper bound of the signed size, plus 64. */
  readonly bandwidth: bigint;
  /** A TRX transfer to an account that does not exist yet. */
  readonly activation: boolean;
  readonly memo: boolean;
  /** TRC-20 transfers: the simulated energy (`energy_used`, penalty included). */
  readonly energy?: bigint;
  /**
   * Percent added to the simulated energy (dynamic energy can rise before inclusion): the
   * network config's `energyMarginPercent`, an integer from 0 to 1,000.
   */
  readonly marginPercent: number;
}

/**
 * The largest `fee_limit` a transaction can carry: the codec writes this `int64` field from
 * a JS number and refuses anything above 2^53 − 1 (lesson 19). A network whose
 * `getMaxFeeLimit` is higher is capped here, so an estimate is never unbuildable.
 */
const MAX_ENCODABLE_FEE_LIMIT = BigInt(Number.MAX_SAFE_INTEGER);

function invalid(message: string): ValidationError {
  return new ValidationError('INVALID_INTENT', message);
}

/**
 * A validated `{ feeLimit }` override, or `undefined` for a speed. Anything else, including
 * a string that is not a speed or an override with another key, is `INVALID_INTENT`.
 */
export function feeOverrideOf(fee: FeeSpeed | FeeOverride): TronFeeOverride | undefined {
  if (isFeeSpeed(fee)) return undefined;
  const shape = (): ValidationError =>
    invalid('a Tron fee is a speed or { feeLimit: bigint } (sun, positive)');
  if (fee === null || typeof fee !== 'object' || Array.isArray(fee)) throw shape();
  const keys = Object.keys(fee);
  const { feeLimit } = fee as { feeLimit?: unknown };
  if (keys.length !== 1 || typeof feeLimit !== 'bigint' || feeLimit <= 0n) {
    throw shape();
  }
  return { feeLimit };
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

export function tronFee(input: TronFeeInput): FeeEstimateDraft {
  const { params, resources, bandwidth, marginPercent } = input;
  if (!Number.isSafeInteger(marginPercent) || marginPercent < 0) {
    // The network config bounds it (0–1,000); a fraction would throw a RangeError below.
    throw new ConfigError(
      'CONFIG_INVALID',
      'energyMarginPercent must be a non-negative integer',
    );
  }
  // F4-R9: every transaction consumes bandwidth, and a TRC-20 call energy; a zero or negative
  // one would give a fee limit of 0, which fails on chain (out of energy) and still pays.
  if (bandwidth <= 0n) {
    throw invalid('cannot estimate a Tron fee: the bandwidth must be positive');
  }
  if (input.energy !== undefined && input.energy <= 0n) {
    throw invalid('cannot estimate a Tron fee: the simulated energy must be positive');
  }
  const override = feeOverrideOf(input.fee);
  const charges: FeeChargeDraft[] = [];
  const charge = (label: string, amount: bigint) =>
    charges.push({ asset: 'native', amount, label });

  let bandwidthFee: bigint;
  if (input.activation) {
    const cost = bandwidth * params.createNewAccountBandwidthRate;
    bandwidthFee = resources.stakedBandwidth >= cost ? 0n : params.createAccountFee;
  } else if (
    resources.stakedBandwidth >= bandwidth ||
    resources.freeBandwidth >= bandwidth
  ) {
    bandwidthFee = 0n;
  } else {
    bandwidthFee = bandwidth * params.transactionFee;
  }
  charge('bandwidth', bandwidthFee);

  let energyDetails: Pick<TronFeeDetails, 'energy' | 'energyPrice' | 'feeLimit'> = {};
  if (input.energy !== undefined) {
    const need = ceilDiv(input.energy * BigInt(100 + marginPercent), 100n);
    const minimum = need * params.energyFee;
    // VMActuator: `feeLimit must be >= 0 and <= getMaxFeeLimit`; and what the codec encodes.
    const ceiling = min(params.maxFeeLimit, MAX_ENCODABLE_FEE_LIMIT);
    if (minimum > ceiling) {
      throw invalid(
        "the transfer needs more energy than the network's maximum fee limit",
      );
    }
    let feeLimit = minimum;
    if (override) {
      if (override.feeLimit < minimum) {
        throw invalid(
          'feeLimit is below the estimated energy cost; the transaction would fail on chain and still pay',
        );
      }
      if (override.feeLimit > ceiling) {
        throw invalid("feeLimit is above the network's maximum fee limit");
      }
      feeLimit = override.feeLimit;
    }
    const covered = resources.energy * params.energyFee;
    charge('energy', feeLimit > covered ? feeLimit - covered : 0n);
    energyDetails = { energy: need, energyPrice: params.energyFee, feeLimit };
  } else if (override) {
    throw invalid('a Tron fee override applies to TRC-20 transfers only');
  }
  if (input.activation) charge('activation', params.createNewAccountFeeInSystemContract);
  if (input.memo) charge('memo', params.memoFee);

  const details: TronFeeDetails = {
    bandwidth,
    bandwidthPrice: params.transactionFee,
    ...energyDetails,
    activation: input.activation,
  };
  return {
    kind: 'tron',
    speed: override ? 'custom' : (input.fee as FeeSpeed),
    charges,
    bound: 'upper',
    details: { ...details },
  };
}

/** Sum of every charge (all in TRX). */
export const feeSun = (fee: FeeEstimateDraft): bigint =>
  fee.charges.reduce((sum, c) => sum + c.amount, 0n);
