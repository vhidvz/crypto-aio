/**
 * Fee plans. The X-Chain burns a fixed fee per transaction (`txFee`, 0.001 AVAX
 * on mainnet and Fuji), read under the proof quorum so one endpoint cannot raise it, and
 * every speed pays it. Since Etna the P-Chain prices gas: a transaction's fee is its gas
 * (complexity weighed by the network's weights) times the gas price. The price an endpoint
 * reports moves with load (it can double in about 30 s at full load), so a speed pays it
 * times a margin, library policy: slow 1.1×, normal 1.5×, fast 2× (rounded up). Above
 * `options.maxGasPrice` an endpoint's price decides nothing (retryable), and no fee is ever
 * above `options.maxFee`. The weights only change with network upgrades: they are read under
 * the proof quorum and kept for ten minutes.
 */
import { ValidationError } from '../../core/errors/error';
import { isFeeSpeed, type FeeOverride, type FeeSpeed } from '../../core/model/fee';
import type { FeeWeights } from './api';
import { assertSaneFee, type FeePlan } from './codec';
import { READ, undecided, withSignal, type AvalancheContext } from './context';

/** Each speed's margin over the endpoint's gas price, in basis points. */
export const SPEED_MARGIN_BPS: Readonly<Record<FeeSpeed, bigint>> = Object.freeze({
  slow: 11_000n,
  normal: 15_000n,
  fast: 20_000n,
});

const WEIGHTS_TTL_MS = 600_000;

export interface FeeConfigCache {
  value?: { readonly weights: FeeWeights; readonly minPrice: bigint };
  until?: number;
}

const override = (message: string): ValidationError =>
  new ValidationError('INVALID_INTENT', message);

/** A gas price from `{ gasPrice }`: a bigint or a decimal integer string, nAVAX per gas. */
function gasPriceOf(fee: FeeOverride): bigint {
  const keys = Object.keys(fee);
  if (keys.length !== 1 || keys[0] !== 'gasPrice') {
    throw override('a P-Chain fee is a speed or { gasPrice } (nAVAX per unit of gas)');
  }
  const value = fee.gasPrice;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)) return BigInt(value);
  throw override('gasPrice must be a positive integer (bigint or decimal string)');
}

async function feeConfigOf(
  ctx: AvalancheContext,
  cache: FeeConfigCache,
  signal?: AbortSignal,
): Promise<{ readonly weights: FeeWeights; readonly minPrice: bigint }> {
  const now = ctx.clock.now();
  if (cache.value && cache.until !== undefined && now < cache.until) return cache.value;
  const value = await ctx.node.feeConfig({
    ...withSignal(READ, signal),
    quorum: 'proof',
  });
  cache.value = value;
  cache.until = now + WEIGHTS_TTL_MS;
  return value;
}

/** The fee plan of `fee` on this chain, from the endpoints' current fee data. */
export async function feePlanOf(
  ctx: AvalancheContext,
  fee: FeeSpeed | FeeOverride,
  cache: FeeConfigCache,
  signal?: AbortSignal,
): Promise<FeePlan> {
  const { config, node } = ctx;
  if (config.vm === 'avm') {
    if (!isFeeSpeed(fee)) {
      throw override("the X-Chain fee is fixed; use 'slow', 'normal' or 'fast'");
    }
    const txFee = await node.txFee({ ...withSignal(READ, signal), quorum: 'proof' });
    assertSaneFee(txFee, config);
    return { model: 'static', txFee };
  }
  if (!isFeeSpeed(fee) && (fee === null || typeof fee !== 'object')) {
    throw override('fee must be a speed or { gasPrice }');
  }
  const [state, { weights, minPrice }] = await Promise.all([
    node.feeState(withSignal(READ, signal)),
    feeConfigOf(ctx, cache, signal),
  ]);
  if (state.price < 1n || state.price > config.maxGasPrice) {
    throw undecided("the endpoint's P-Chain gas price is outside 1..options.maxGasPrice");
  }
  let price: bigint;
  if (isFeeSpeed(fee)) {
    const margin = SPEED_MARGIN_BPS[fee];
    price = (state.price * margin + 9_999n) / 10_000n;
  } else {
    price = gasPriceOf(fee);
    if (price < minPrice || price < 1n) {
      throw override("gasPrice is below the P-Chain's minimum gas price");
    }
  }
  if (price > config.maxGasPrice) {
    throw override('the gas price exceeds the configured maximum (options.maxGasPrice)');
  }
  return { model: 'dynamic', price, state, weights };
}

/**
 * The fee plan a stored estimate fixed (`details`), checked: it is our own plain data,
 * read back from the caller's store, which keeps only plain values (`bigint` included).
 */
export function storedPlan(
  details: Readonly<Record<string, unknown>>,
  model: 'static' | 'dynamic',
): { readonly txFee?: bigint; readonly gasPrice?: bigint } {
  if (details.model !== model) {
    throw override('the fee is not an estimate of this chain');
  }
  const value = model === 'static' ? details.txFee : details.gasPrice;
  if (typeof value !== 'bigint' || value < (model === 'static' ? 0n : 1n)) {
    throw override('the fee is not an estimate of this chain');
  }
  return model === 'static' ? { txFee: value } : { gasPrice: value };
}
