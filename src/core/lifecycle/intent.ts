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

/** Recursively rejects a JS `number` at any depth, and any non-plain value (a class
 * instance such as `Date`) anywhere inside a `FeeOverride` — only plain data is allowed:
 * strings, bigints, booleans, plain objects and arrays. An object field set to `undefined` is
 * treated as omitted. */
function assertFeeData(value: unknown): void {
  if (typeof value === 'number') {
    throw new ValidationError(
      'INVALID_INTENT',
      'fee override amounts must be a bigint or a decimal string, never a number',
    );
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertFeeData(item);
    return;
  }
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new ValidationError('INVALID_INTENT', 'fee override must be plain data');
    }
    // An `undefined` field is an omitted optional field, not a non-plain value.
    for (const v of Object.values(value)) if (v !== undefined) assertFeeData(v);
    return;
  }
  throw new ValidationError('INVALID_INTENT', 'fee override must be plain data');
}

/** `fee` is a known `FeeSpeed` or a plain-data `FeeOverride`, recursively — amounts
 * are `bigint` or a decimal string, like everywhere else in this API, never a JS `number` at
 * any depth, and never a class instance such as `Date`. Also the engine's guard for a
 * replacement fee. */
export function validateFee(fee: TransferIntent['fee']): void {
  if (fee === undefined || isFeeSpeed(fee)) return;
  if (fee === null || typeof fee !== 'object' || Array.isArray(fee)) {
    throw new ValidationError(
      'INVALID_INTENT',
      'fee must be a fee speed or a plain fee override object',
    );
  }
  assertFeeData(fee);
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
