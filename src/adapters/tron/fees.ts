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
import { malformed, type ChainParameters } from './http';
import { MAX_ENCODABLE_FEE_LIMIT } from './network';
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
  /**
   * The handle's fee-limit bound in sun (`TronNetworkConfig.maxFeeLimit`, F4-R28): from 1 to
   * 2^53 − 1, the largest `fee_limit` the codec writes exactly (lesson 19).
   */
  readonly maxFeeLimit: bigint;
}

/** The fee-limit ceiling, and which bound sets it. */
export interface FeeLimitCeiling {
  readonly value: bigint;
  /** `network`: `getMaxFeeLimit`, which no option can lift; `option`: the handle's bound. */
  readonly bound: 'network' | 'option';
}

function invalid(message: string): ValidationError {
  return new ValidationError('INVALID_INTENT', message);
}

/**
 * The largest fee limit a TRC-20 transfer may carry (F4-R28; one function for the estimate and
 * its size bound, F4-R12 M4): the network's `getMaxFeeLimit` (VMActuator refuses more) and the
 * handle's `maxFeeLimit`. The node reports its maximum, as it reports the energy price and the
 * simulated energy, so only the handle's bound is the operator's own. That bound is at most
 * 2^53 − 1, so the ceiling is always encodable; on a tie the network is named, since raising
 * the option would not help.
 */
export function feeLimitCeiling(
  params: Pick<ChainParameters, 'maxFeeLimit'>,
  maxFeeLimit: bigint,
): FeeLimitCeiling {
  if (
    typeof maxFeeLimit !== 'bigint' ||
    maxFeeLimit < 1n ||
    maxFeeLimit > MAX_ENCODABLE_FEE_LIMIT
  ) {
    // The network config bounds it; anything else is a driver bug, never the caller's intent.
    throw new ConfigError(
      'CONFIG_INVALID',
      'maxFeeLimit must be a bigint of sun from 1 to 2^53 − 1',
    );
  }
  return params.maxFeeLimit <= maxFeeLimit
    ? { value: params.maxFeeLimit, bound: 'network' }
    : { value: maxFeeLimit, bound: 'option' };
}

/**
 * What exceeds the ceiling, named after the bound that sets it. A need above the handle's
 * bound carries it and the need (decimal strings), so the caller sees what to allow.
 */
function aboveCeiling(ceiling: FeeLimitCeiling, need?: bigint): ValidationError {
  if (ceiling.bound === 'network') {
    return invalid(
      need !== undefined
        ? "the transfer needs more energy than the network's maximum fee limit"
        : "feeLimit is above the network's maximum fee limit",
    );
  }
  if (need === undefined) {
    return invalid(
      'feeLimit is above maxFeeLimit, the Tron handle option that bounds it (in sun)',
    );
  }
  return new ValidationError(
    'INVALID_INTENT',
    'the transfer needs more energy than maxFeeLimit allows (a Tron handle option, in sun)',
    { details: { required: need.toString(), maxFeeLimit: ceiling.value.toString() } },
  );
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
  // F4-R10 M4: the bandwidth is the driver's own measure of the bytes it built (at least 133
  // bytes, `bandwidthOf`), so a non-positive one is a driver bug: an internal, non-retryable
  // CryptoAioError that fails the transfer before signing, never a foreign error (lesson 6).
  // The energy is the node's simulation, so a non-positive one is a malformed answer
  // (retryable).
  if (bandwidth <= 0n) {
    throw invalid('cannot estimate a Tron fee: the measured bandwidth is not positive');
  }
  if (input.energy !== undefined && input.energy <= 0n) throw malformed('energy used');
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
    // F4-R28: fee limit = min(estimate × margin, network maximum, maxFeeLimit). The ceiling
    // caps the margin, never the simulated energy itself: a fee limit below that fails on
    // chain (out of energy) and still pays, so a need above the ceiling is refused before
    // anything is signed.
    const ceiling = feeLimitCeiling(params, input.maxFeeLimit);
    const cost = input.energy * params.energyFee;
    if (cost > ceiling.value) throw aboveCeiling(ceiling, cost);
    const estimate = min(need * params.energyFee, ceiling.value);
    let feeLimit = estimate;
    if (override) {
      if (override.feeLimit < estimate) {
        throw invalid(
          'feeLimit is below the estimated energy cost; the transaction would fail on chain and still pay',
        );
      }
      if (override.feeLimit > ceiling.value) throw aboveCeiling(ceiling);
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
