/**
 * The Solana fee policy (spec §6.5, §15: base fee plus priority), pure and bigint-only. The
 * priority fee is `ceil(computeUnitPrice × computeUnitLimit / 1_000_000)` lamports, charged
 * on the requested limit (Solana's fee documentation, Plan 5 appendix).
 */
import { ValidationError } from '../../core/errors/error';
import type {
  FeeChargeDraft,
  FeeEstimateDraft,
  FeeOverride,
  FeeSpeed,
} from '../../core/model/fee';
import { DEFAULT_INSTRUCTION_COMPUTE_UNITS, MAX_COMPUTE_UNIT_LIMIT } from './programs';
import { malformed, u64 } from './rpc';
import type { SolanaFeeDetails, SolanaFeeOverride } from './types';

/** Library policy: the percentile of recent prioritization fees each speed pays. */
export const SPEED_PERCENTILE: Readonly<Record<FeeSpeed, number>> = Object.freeze({
  slow: 25,
  normal: 50,
  fast: 75,
});

/** Library policy: the compute-unit limit is the simulated usage plus 20% and 1,000 units. */
export function computeUnitLimitFor(unitsConsumed: bigint): bigint {
  const limit = unitsConsumed + unitsConsumed / 5n + 1_000n;
  return limit > MAX_COMPUTE_UNIT_LIMIT ? MAX_COMPUTE_UNIT_LIMIT : limit;
}

/** The runtime's own default when a simulation cannot measure the transaction. */
export function fallbackComputeUnitLimit(instructions: number): bigint {
  const limit = DEFAULT_INSTRUCTION_COMPUTE_UNITS * BigInt(instructions);
  return limit > MAX_COMPUTE_UNIT_LIMIT ? MAX_COMPUTE_UNIT_LIMIT : limit;
}

/**
 * Build variants (Plan 5 D10): identical intents built on the same blockhash would
 * sign byte-identical messages, so a second Operation would silently share the first one's
 * signature and one payment would be lost. Each estimate therefore adds a variant to the
 * compute-unit limit (0 to 1,023 units) and, for a speed, to the price (0 to 999
 * micro-lamports): at most about one lamport of priority fee per 1,000 compute units.
 */
export const VARIANTS = 1_024 * 1_000;

export function variantOffsets(variant: number): {
  readonly limit: bigint;
  readonly price: bigint;
} {
  return {
    limit: BigInt(variant % 1_024),
    price: BigInt(Math.floor(variant / 1_024) % 1_000),
  };
}

/** A per-driver counter from a random start: distinct in-process, rare across processes. */
export function variantCounter(start: number): () => number {
  let next = start % VARIANTS;
  return () => {
    const variant = next;
    next = (next + 1) % VARIANTS;
    return variant;
  };
}

export function priorityFee(computeUnitPrice: bigint, computeUnitLimit: bigint): bigint {
  return (computeUnitPrice * computeUnitLimit + 999_999n) / 1_000_000n;
}

/**
 * The nearest-rank percentile of `getRecentPrioritizationFees` answers (micro-lamports per
 * compute unit); `0n` when the node reports none. A malformed entry, including one outside
 * the u64 range (lesson 19), is a retryable `PROVIDER_UNAVAILABLE`.
 */
export function priceForSpeed(recent: unknown, speed: FeeSpeed): bigint {
  if (!Array.isArray(recent)) throw malformed('getRecentPrioritizationFees');
  const fees = recent.map((entry: unknown) =>
    u64(
      (entry as { prioritizationFee?: unknown } | null)?.prioritizationFee,
      'getRecentPrioritizationFees',
    ),
  );
  if (fees.length === 0) return 0n;
  fees.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.ceil((SPEED_PERCENTILE[speed] / 100) * fees.length);
  return fees[Math.max(0, rank - 1)] as bigint;
}

/** A validated `SolanaFeeOverride`; anything else is `INVALID_INTENT`. */
export function parseOverride(fee: FeeOverride): SolanaFeeOverride {
  const invalid = (reason: string) =>
    new ValidationError('INVALID_INTENT', `Solana fee override: ${reason}`);
  const keys = Object.keys(fee);
  if (keys.some((key) => key !== 'computeUnitPrice' && key !== 'computeUnitLimit')) {
    throw invalid('only computeUnitPrice and computeUnitLimit are allowed');
  }
  const { computeUnitPrice, computeUnitLimit } = fee;
  if (
    typeof computeUnitPrice !== 'bigint' ||
    computeUnitPrice < 0n ||
    computeUnitPrice >= 2n ** 64n
  ) {
    throw invalid('computeUnitPrice must be a bigint of micro-lamports in the u64 range');
  }
  if (
    computeUnitLimit !== undefined &&
    (typeof computeUnitLimit !== 'bigint' ||
      computeUnitLimit < 1n ||
      computeUnitLimit > MAX_COMPUTE_UNIT_LIMIT)
  ) {
    throw invalid('computeUnitLimit must be a bigint from 1 to 1,400,000');
  }
  return {
    computeUnitPrice,
    ...(computeUnitLimit !== undefined ? { computeUnitLimit } : {}),
  };
}

/**
 * The fee draft: `network` (the signature fee), `priority` and, when the recipient's token
 * account is created, `rent`. The bound is `exact` unless rent is charged: that deposit is
 * skipped when someone else creates the account first, so it is an upper bound.
 */
export function feeDraft(
  speed: FeeSpeed | 'custom',
  details: SolanaFeeDetails,
): FeeEstimateDraft {
  const charges: FeeChargeDraft[] = [
    { asset: 'native', amount: details.baseFee, label: 'network' },
    { asset: 'native', amount: details.priorityFee, label: 'priority' },
  ];
  if (details.createsRecipientAccount) {
    charges.push({ asset: 'native', amount: details.rent, label: 'rent' });
  }
  return {
    kind: 'solana',
    speed,
    charges,
    bound: details.createsRecipientAccount ? 'upper' : 'exact',
    details: { ...details },
  };
}

/** The `SolanaFeeDetails` of a draft this driver made; anything else is `INVALID_INTENT`. */
export function detailsOf(fee: FeeEstimateDraft): SolanaFeeDetails {
  const d = fee.details as Partial<SolanaFeeDetails>;
  if (
    fee.kind !== 'solana' ||
    typeof d.computeUnitLimit !== 'bigint' ||
    typeof d.computeUnitPrice !== 'bigint' ||
    typeof d.baseFee !== 'bigint' ||
    typeof d.priorityFee !== 'bigint' ||
    typeof d.rent !== 'bigint' ||
    typeof d.signatures !== 'number' ||
    typeof d.createsRecipientAccount !== 'boolean'
  ) {
    throw new ValidationError('INVALID_INTENT', 'not a Solana fee estimate');
  }
  return {
    signatures: d.signatures,
    baseFee: d.baseFee,
    computeUnitLimit: d.computeUnitLimit,
    computeUnitPrice: d.computeUnitPrice,
    priorityFee: d.priorityFee,
    rent: d.rent,
    createsRecipientAccount: d.createsRecipientAccount,
  };
}

/** The lamports every fee charge of `fee` adds up to. */
export const lamportsCharged = (fee: FeeEstimateDraft): bigint =>
  fee.charges.reduce((sum, charge) => sum + charge.amount, 0n);
