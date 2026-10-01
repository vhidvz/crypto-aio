/**
 * The EVM fee policy (spec §6.5, §15): `evm-1559` or `evm-legacy` per network, an `upper`
 * bound with the `expected` cost in the details, overrides, and replacement bumps. Pure
 * functions over plain data; the driver does the I/O.
 */
import { ProviderError, ValidationError } from '../../core/errors/error';
import type { FeeEstimateDraft, FeeOverride, FeeSpeed } from '../../core/model/fee';
import type { EvmFeeDetails, EvmFeeHistory } from './types';

export type EvmFeeModel = 'evm-1559' | 'evm-legacy';

/** The per-gas prices of one transaction. */
export type EvmFeeParams =
  | {
      readonly type: 'eip1559';
      readonly maxFeePerGas: bigint;
      readonly maxPriorityFeePerGas: bigint;
    }
  | { readonly type: 'legacy'; readonly gasPrice: bigint };

/**
 * `eth_feeHistory` window and priority-fee percentiles for slow, normal and fast: the
 * method the Polygon Gas Station documents (10th, 25th and 50th over the last 15 blocks).
 */
export const FEE_HISTORY_BLOCKS = 15;
export const FEE_PERCENTILES: readonly number[] = [10, 25, 50];
const SPEED_INDEX: Readonly<Record<FeeSpeed, number>> = { slow: 0, normal: 1, fast: 2 };
/** Legacy networks: `eth_gasPrice` scaled per speed, in percent. */
const LEGACY_PERCENT: Readonly<Record<FeeSpeed, bigint>> = {
  slow: 100n,
  normal: 110n,
  fast: 125n,
};
/** A plain transfer to an account without code costs exactly this much gas. */
export const TRANSFER_GAS = 21_000n;
/** Headroom over the node's estimate for anything but a plain transfer, in percent. */
const GAS_HEADROOM_PERCENT = 120n;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** The lower median; `0n` for no values. */
export function median(values: readonly bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor((sorted.length - 1) / 2)] as bigint;
}

const malformedHistory = () =>
  new ProviderError('PROVIDER_UNAVAILABLE', 'malformed fee history');

/**
 * EIP-1559 prices for `speed`: the tip is the median, over the window, of the speed's
 * percentile (at least `minTip`); the cap allows the next base fee to double. The history
 * must answer a request for `FEE_PERCENTILES`: one without the next base fee, without
 * reward rows, or with a reward row shorter than `FEE_PERCENTILES` is a retryable
 * `PROVIDER_UNAVAILABLE`, never a tip of `minTip`.
 */
export function feesFromHistory(
  history: EvmFeeHistory,
  speed: FeeSpeed,
  minTip: bigint,
): { readonly params: EvmFeeParams; readonly baseFeePerGas: bigint } {
  const baseFeePerGas = history.baseFeePerGas[history.baseFeePerGas.length - 1];
  if (baseFeePerGas === undefined || history.reward.length === 0) {
    throw malformedHistory();
  }
  const index = SPEED_INDEX[speed];
  const tips = history.reward.map((row) => {
    const tip = row[index];
    if (row.length < FEE_PERCENTILES.length || tip === undefined)
      throw malformedHistory();
    return tip;
  });
  const tip = max(median(tips), minTip);
  return {
    params: {
      type: 'eip1559',
      maxFeePerGas: 2n * baseFeePerGas + tip,
      maxPriorityFeePerGas: tip,
    },
    baseFeePerGas,
  };
}

export function legacyPrice(gasPrice: bigint, speed: FeeSpeed): EvmFeeParams {
  return { type: 'legacy', gasPrice: ceilDiv(gasPrice * LEGACY_PERCENT[speed], 100n) };
}

/** The node's estimate, with headroom unless it is a plain transfer. */
export function gasLimitFrom(estimate: bigint): bigint {
  return estimate === TRANSFER_GAS
    ? TRANSFER_GAS
    : ceilDiv(estimate * GAS_HEADROOM_PERCENT, 100n);
}

const invalid = (reason: string) => new ValidationError('INVALID_INTENT', reason);

/**
 * Plan 7 D6 (F4-R28's shape): the default `maxFeePerGas`, the highest price per gas an EVM
 * transaction signs, 1,000 gwei. It bounds a plain transfer at 0.021 and a 65,000-gas token
 * transfer at 0.065 of the native coin, however an endpoint prices the fee.
 */
export const DEFAULT_MAX_FEE_PER_GAS = 1_000_000_000_000n;

/** The highest price per gas `params` may pay: the fee cap, or the legacy gas price. */
export function priceCap(params: EvmFeeParams): bigint {
  return params.type === 'eip1559' ? params.maxFeePerGas : params.gasPrice;
}

/**
 * A node's suggestion within the ceiling (D6): the fee cap or gas price at most `ceiling`,
 * and the tip at most the fee cap. No endpoint can raise what a transfer signs.
 */
export function capPrice(params: EvmFeeParams, ceiling: bigint): EvmFeeParams {
  if (params.type === 'legacy')
    return { type: 'legacy', gasPrice: min(params.gasPrice, ceiling) };
  const maxFeePerGas = min(params.maxFeePerGas, ceiling);
  return {
    type: 'eip1559',
    maxFeePerGas,
    maxPriorityFeePerGas: min(params.maxPriorityFeePerGas, maxFeePerGas),
  };
}

/**
 * Refuses, before anything is signed, a fee whose price per gas is above `ceiling` (the
 * handle's `maxFeePerGas`), whatever produced it: an explicit override, a stored fee, or a
 * cancel's least bump. The details carry the price and the bound as decimal strings.
 */
export function assertWithinCeiling(params: EvmFeeParams, ceiling: bigint): void {
  const price = priceCap(params);
  if (price <= ceiling) return;
  throw new ValidationError(
    'INVALID_INTENT',
    'the fee is above maxFeePerGas, the EVM handle option that bounds it (wei per gas)',
    { details: { required: price.toString(), maxFeePerGas: ceiling.toString() } },
  );
}

/** Validates an `EvmFeeOverride` against the network's fee model. */
export function parseFeeOverride(
  override: FeeOverride,
  model: EvmFeeModel,
): { readonly params: EvmFeeParams; readonly gasLimit?: bigint } {
  const allowed =
    model === 'evm-1559'
      ? ['maxFeePerGas', 'maxPriorityFeePerGas', 'gasLimit']
      : ['gasPrice', 'gasLimit'];
  const shape =
    model === 'evm-1559'
      ? '{ maxFeePerGas, maxPriorityFeePerGas, gasLimit? }'
      : '{ gasPrice, gasLimit? }';
  const keys = Object.keys(override);
  if (keys.some((key) => !allowed.includes(key))) {
    throw invalid(`${model} fee overrides look like ${shape}`);
  }
  const amount = (key: string, min: bigint): bigint => {
    const value = override[key];
    if (typeof value !== 'bigint' || value < min) {
      throw invalid(`fee override '${key}' must be a bigint of at least ${min}`);
    }
    return value;
  };
  const gasLimit =
    override.gasLimit === undefined ? undefined : amount('gasLimit', TRANSFER_GAS);
  const limit = gasLimit !== undefined ? { gasLimit } : {};
  if (model === 'evm-legacy') {
    return { params: { type: 'legacy', gasPrice: amount('gasPrice', 1n) }, ...limit };
  }
  const maxFeePerGas = amount('maxFeePerGas', 1n);
  const maxPriorityFeePerGas = amount('maxPriorityFeePerGas', 0n);
  if (maxPriorityFeePerGas > maxFeePerGas) {
    throw invalid('maxPriorityFeePerGas must not exceed maxFeePerGas');
  }
  return { params: { type: 'eip1559', maxFeePerGas, maxPriorityFeePerGas }, ...limit };
}

/** The fee draft for a transaction of `gasLimit` at `params`. */
export function feeDraft(
  speed: FeeSpeed | 'custom',
  gasLimit: bigint,
  params: EvmFeeParams,
  extra: { readonly baseFeePerGas?: bigint; readonly l1Fee?: bigint } = {},
): FeeEstimateDraft {
  const cap = params.type === 'eip1559' ? params.maxFeePerGas : params.gasPrice;
  const expectedPrice =
    params.type === 'eip1559' && extra.baseFeePerGas !== undefined
      ? min(params.maxFeePerGas, extra.baseFeePerGas + params.maxPriorityFeePerGas)
      : cap;
  // `satisfies` checks the shape and keeps a literal type the draft's record accepts.
  const details = {
    gasLimit,
    ...(params.type === 'eip1559'
      ? {
          maxFeePerGas: params.maxFeePerGas,
          maxPriorityFeePerGas: params.maxPriorityFeePerGas,
          ...(extra.baseFeePerGas !== undefined
            ? { baseFeePerGas: extra.baseFeePerGas }
            : {}),
        }
      : { gasPrice: params.gasPrice }),
    ...(extra.l1Fee !== undefined ? { l1Fee: extra.l1Fee } : {}),
    expected: gasLimit * expectedPrice + (extra.l1Fee ?? 0n),
  } satisfies EvmFeeDetails;
  return {
    kind: params.type === 'eip1559' ? 'evm-1559' : 'evm-legacy',
    speed,
    charges: [
      { asset: 'native', amount: gasLimit * cap, label: 'network' },
      ...(extra.l1Fee !== undefined
        ? [{ asset: 'native' as const, amount: extra.l1Fee, label: 'l1-data' }]
        : []),
    ],
    // The L1 data fee moves with L1 prices until inclusion, so it is only expected.
    bound: extra.l1Fee !== undefined ? 'expected' : 'upper',
    details,
  };
}

/** The gas limit and prices a fee draft's details hold. */
export function feeOf(details: Readonly<Record<string, unknown>>): {
  readonly gasLimit: bigint;
  readonly params: EvmFeeParams;
} {
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasPrice } = details;
  if (typeof gasLimit !== 'bigint') throw invalid('the fee holds no EVM gas limit');
  if (typeof maxFeePerGas === 'bigint' && typeof maxPriorityFeePerGas === 'bigint') {
    return { gasLimit, params: { type: 'eip1559', maxFeePerGas, maxPriorityFeePerGas } };
  }
  if (typeof gasPrice === 'bigint')
    return { gasLimit, params: { type: 'legacy', gasPrice } };
  throw invalid('the fee holds no EVM gas prices');
}

/**
 * Whether `next` may replace `previous` under a txpool's `percent` price bump: each price
 * strictly higher, and at least `percent` higher (geth), so a zero tip must still rise.
 */
export function meetsBump(
  previous: EvmFeeParams,
  next: EvmFeeParams,
  percent: number,
): boolean {
  const factor = BigInt(100 + percent);
  const bumped = (before: bigint, after: bigint) =>
    after > before && after * 100n >= before * factor;
  if (previous.type === 'eip1559' && next.type === 'eip1559') {
    return (
      bumped(previous.maxFeePerGas, next.maxFeePerGas) &&
      bumped(previous.maxPriorityFeePerGas, next.maxPriorityFeePerGas)
    );
  }
  if (previous.type === 'legacy' && next.type === 'legacy') {
    return bumped(previous.gasPrice, next.gasPrice);
  }
  return false;
}

/** The smallest prices that meet the bump over `previous`: each strictly higher (geth). */
export function minimumBump(previous: EvmFeeParams, percent: number): EvmFeeParams {
  const up = (value: bigint) => {
    const bumped = ceilDiv(value * BigInt(100 + percent), 100n);
    return bumped > value ? bumped : value + 1n;
  };
  return previous.type === 'eip1559'
    ? {
        type: 'eip1559',
        maxFeePerGas: up(previous.maxFeePerGas),
        maxPriorityFeePerGas: up(previous.maxPriorityFeePerGas),
      }
    : { type: 'legacy', gasPrice: up(previous.gasPrice) };
}
