import { UnsupportedCapabilityError, ValidationError } from '../errors/error';
import type { Address } from '../model/address';
import { Amount } from '../model/amount';
import {
  collectOutputs,
  type NormalizedIntent,
  type TransferIntent,
} from '../model/intent';
import { toAddress, type MappingContext } from '../blockchain/mapping';

export type HandleContext = MappingContext;

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
  if (intent.memo !== undefined && !caps.has('memo')) {
    throw new UnsupportedCapabilityError(
      'UNSUPPORTED_CAPABILITY',
      `${ctx.selection.chain.id} does not support memos`,
    );
  }
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
