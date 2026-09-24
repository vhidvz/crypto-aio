import { UnsupportedCapabilityError, ValidationError } from '../errors/error';
import type { Address } from '../model/address';
import { Amount } from '../model/amount';
import { isFeeSpeed } from '../model/fee';
import {
  collectOutputs,
  type NormalizedIntent,
  type TransferIntent,
} from '../model/intent';
import { toAddress, type MappingContext } from '../blockchain/mapping';

export type HandleContext = MappingContext;

/** M8: `fee` is a known `FeeSpeed` or a plain-data `FeeOverride`; a `FeeOverride`'s own
 * values may never be a JS `number` — amounts are `bigint` or a decimal string, like
 * everywhere else in this API. */
function validateFee(fee: TransferIntent['fee']): void {
  if (fee === undefined || isFeeSpeed(fee)) return;
  if (fee === null || typeof fee !== 'object' || Array.isArray(fee)) {
    throw new ValidationError(
      'INVALID_INTENT',
      'fee must be a fee speed or a plain fee override object',
    );
  }
  const proto: unknown = Object.getPrototypeOf(fee);
  if (proto !== Object.prototype && proto !== null) {
    throw new ValidationError('INVALID_INTENT', 'fee override must be a plain object');
  }
  for (const value of Object.values(fee)) {
    if (typeof value === 'number') {
      throw new ValidationError(
        'INVALID_INTENT',
        'fee override amounts must be a bigint or a decimal string, never a number',
      );
    }
  }
}

/** Resolves the asset, normalizes addresses and amounts, and enforces capabilities. */
export async function normalizeIntent(
  ctx: HandleContext,
  intent: TransferIntent,
  from: Address,
): Promise<NormalizedIntent> {
  const outputs = collectOutputs(intent);
  const asset = await ctx.assets.resolve(ctx.selection, ctx.driver, intent.asset);
  const normalized = outputs.map((output) => {
    const amount = Amount.from(output.amount, asset);
    if (amount.isZero())
      throw new ValidationError(
        'INVALID_AMOUNT',
        'transfer amounts must be greater than zero',
      );
    return { to: toAddress(ctx, output.to), amount };
  });
  const caps = ctx.selection.capabilities;
  if (normalized.length > 1 && !caps.has('batch-transfer')) {
    throw new UnsupportedCapabilityError(
      'UNSUPPORTED_CAPABILITY',
      `${ctx.selection.chain.id} does not support batch transfers`,
    );
  }
  if (intent.memo !== undefined) {
    if (typeof intent.memo !== 'string') {
      throw new ValidationError('INVALID_INTENT', 'memo must be a string');
    }
    if (!caps.has('memo')) {
      throw new UnsupportedCapabilityError(
        'UNSUPPORTED_CAPABILITY',
        `${ctx.selection.chain.id} does not support memos`,
      );
    }
  }
  validateFee(intent.fee);
  if (intent.from !== undefined && !toAddress(ctx, intent.from).equals(from)) {
    throw new ValidationError(
      'INVALID_INTENT',
      'intent.from must be the address of the selected wallet',
    );
  }
  return {
    asset,
    outputs: normalized,
    from,
    ...(intent.memo !== undefined ? { memo: intent.memo } : {}),
    fee: intent.fee ?? 'normal',
  };
}
