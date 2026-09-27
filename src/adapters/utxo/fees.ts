/**
 * UTXO fee policy (pure): fee rates from Esplora estimates or an override, the fee of a
 * size, the absurd-fee guard, and the replacement rules every Bitcoin Core release since
 * v28 enforces (doc/policy/mempool-replacements.md): the replacement pays at least the
 * replaced fee plus the incremental relay fee for its own size (rules 3 and 4), and a
 * strictly higher fee rate (the pre-v31 rule 6, which a single-transaction conflict still
 * needs for the v31 feerate diagram). Rates are sat/kvB bigints; nothing here floats except
 * the parsing of Esplora's sat/vB numbers.
 */
import { ChainError, ProviderError, ValidationError } from '../../core/errors/error';
import type { FeeOverride, FeeSpeed } from '../../core/model/fee';
import type { UtxoNetworkConfig } from './network';

/** Confirmation targets (blocks) per speed: library policy (Plan 3 D-decisions). */
export const SPEED_TARGETS: Readonly<Record<FeeSpeed, number>> = Object.freeze({
  fast: 2,
  normal: 6,
  slow: 144,
});

type FeePolicy = Pick<
  UtxoNetworkConfig,
  'minRelayFee' | 'feeFallback' | 'maxFeeRate' | 'maxFee' | 'maxEstimatedFeeRate'
>;

/** Esplora's sat/vB float as sat/kvB, rounded up after removing float noise. */
export function satPerKvB(satPerVByte: number): bigint {
  const micro = Math.round(satPerVByte * 1_000_000);
  return BigInt(Math.ceil(micro / 1_000));
}

const outOfRange = (): ProviderError =>
  new ProviderError('PROVIDER_UNAVAILABLE', 'the fee estimate is out of range');

/**
 * The largest sat/vB an estimate may carry before it is converted (Task 7's parser bound);
 * above about 1.8e302, `satPerKvB`'s `x × 1e6` overflows to Infinity.
 */
const MAX_ESTIMATE = 1e7;

/**
 * The rate for a speed: the estimate at its target, else at the nearest faster target the
 * endpoint has; never below the minimum relay fee. With no usable estimate, a test
 * network's `feeFallback`, else a retryable `PROVIDER_UNAVAILABLE` (nothing is guessed).
 * The relay floor clamps the fallback too: it is registry data, never checked against
 * `minRelayFee`.
 */
export function rateForSpeed(
  estimates: ReadonlyMap<number, number>,
  speed: FeeSpeed,
  policy: FeePolicy,
): bigint {
  const target = SPEED_TARGETS[speed];
  let best: number | undefined;
  for (const available of estimates.keys()) {
    if (available <= target && (best === undefined || available > best)) best = available;
  }
  let rate: bigint;
  if (best !== undefined) {
    const estimate = estimates.get(best) as number;
    // M3: one endpoint's estimate never sets an absurd rate (an explicit override may), and a
    // malformed one (negative, not finite or beyond any real rate) decides nothing either;
    // the negated range test also refuses NaN.
    if (!(estimate >= 0 && estimate <= MAX_ESTIMATE)) throw outOfRange();
    rate = satPerKvB(estimate);
    if (rate > policy.maxEstimatedFeeRate) throw outOfRange();
  } else if (policy.feeFallback !== undefined) rate = policy.feeFallback;
  else {
    throw new ProviderError(
      'PROVIDER_UNAVAILABLE',
      'the endpoint has no fee estimate for this confirmation target',
    );
  }
  return rate < policy.minRelayFee ? policy.minRelayFee : rate;
}

const DECIMAL = /^(0|[1-9][0-9]{0,6})(\.[0-9]{1,3})?$/;

/** `{ satPerVByte }` as sat/kvB. `INVALID_INTENT` when malformed, `FEE_TOO_LOW` below relay. */
export function rateFromOverride(override: FeeOverride, policy: FeePolicy): bigint {
  const keys = Object.keys(override);
  const value = override.satPerVByte;
  if (keys.length !== 1 || keys[0] !== 'satPerVByte') {
    throw new ValidationError(
      'INVALID_INTENT',
      'a UTXO fee override is { satPerVByte: bigint | decimal string }',
    );
  }
  let rate: bigint;
  if (typeof value === 'bigint') {
    if (value < 0n)
      throw new ValidationError('INVALID_INTENT', 'satPerVByte must be >= 0');
    rate = value * 1_000n;
  } else if (typeof value === 'string' && DECIMAL.test(value)) {
    const [whole, fraction = ''] = value.split('.') as [string, string?];
    rate = BigInt(whole) * 1_000n + BigInt(fraction.padEnd(3, '0'));
  } else {
    throw new ValidationError(
      'INVALID_INTENT',
      'satPerVByte must be a bigint or a decimal string with at most 3 fractional digits',
    );
  }
  if (rate < policy.minRelayFee) {
    throw new ChainError('FEE_TOO_LOW', 'the fee rate is below the minimum relay fee');
  }
  return rate;
}

/** Bitcoin Core's `CFeeRate::GetFee`: `rate × vsize / 1000`, rounded up. */
export function feeAt(rate: bigint, vsize: number): bigint {
  return (rate * BigInt(vsize) + 999n) / 1_000n;
}

/**
 * The absurd-fee guard (a burn of funds by a fee bug or a fat-fingered override): refuses
 * a fee above `maxFee` or a rate above `maxFeeRate` before anything is signed.
 */
export function assertSaneFee(fee: bigint, vsize: number, policy: FeePolicy): void {
  if (fee > policy.maxFee || fee * 1_000n > policy.maxFeeRate * BigInt(vsize)) {
    throw new ValidationError(
      'INVALID_INTENT',
      'the fee exceeds the configured maximum (options.maxFee / options.maxFeeRate)',
    );
  }
}

export interface PaidFee {
  readonly fee: bigint;
  /** Estimated with worst-case signatures (an upper bound of the real size). */
  readonly vsize: number;
  /** A lower bound of the real size (M1); default `vsize`. */
  readonly minVsize?: number;
}

/**
 * The least fee a replacement of `vsize` may pay over `previous` (rules 3, 4 and 6). It does
 * not count descendants of the replaced transaction (a recipient's CPFP): a node then refuses
 * with `FEE_TOO_LOW`, and a higher explicit fee resolves it.
 */
export function replacementFloor(
  previous: PaidFee,
  vsize: number,
  incrementalRelayFee: bigint,
): bigint {
  const byBandwidth = previous.fee + feeAt(incrementalRelayFee, vsize);
  // M1: the replaced rate at its smallest possible size, rounded up to sat/kvB, plus one:
  // strictly higher both exactly (v30) and truncated to sat/kvB (v28, v29).
  const smallest = BigInt(previous.minVsize ?? previous.vsize);
  const oldRate = (previous.fee * 1_000n + smallest - 1n) / smallest;
  const byRate = ((oldRate + 1n) * BigInt(vsize) + 999n) / 1_000n;
  return byBandwidth > byRate ? byBandwidth : byRate;
}
