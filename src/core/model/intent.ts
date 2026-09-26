import { ValidationError } from '../errors/error';
import { canonicalJson, sha256Hex } from '../util/json';
import type { Address } from './address';
import type { Amount, AmountInput } from './amount';
import type { AssetId, AssetInfo, AssetRef } from './asset';
import type { FeeOverride, FeeSpeed } from './fee';

export interface TransferOutputInput {
  readonly to: string;
  readonly amount: AmountInput;
}

export interface TransferIntent {
  readonly to?: string;
  readonly amount?: AmountInput;
  readonly outputs?: readonly TransferOutputInput[];
  /** `'native'`, a token ref, an asset id, or an alias registered for this chain/network. */
  readonly asset?: AssetRef | string;
  readonly from?: string;
  readonly memo?: string;
  readonly fee?: FeeSpeed | FeeOverride;
}

export interface NormalizedOutput {
  readonly to: Address;
  readonly amount: Amount;
}

export interface NormalizedIntent {
  readonly asset: AssetInfo;
  readonly outputs: readonly NormalizedOutput[];
  readonly from: Address;
  readonly memo?: string;
  readonly fee: FeeSpeed | FeeOverride;
}

/**
 * One output as drivers receive it. `variant` is the recipient address's chain-specific
 * meaning (`Address.variant`), present only when its chain has one, e.g. TON's
 * `bounceable` flag (spec §6.4: the intent's `to` variant decides bounce behaviour).
 */
export interface DriverOutput {
  readonly to: string;
  readonly amount: bigint;
  readonly variant?: Readonly<Record<string, unknown>>;
}

/** What drivers receive: canonical strings and base units only. */
export interface DriverIntent {
  readonly asset: AssetRef;
  readonly outputs: readonly DriverOutput[];
  readonly from: string;
  readonly memo?: string;
  readonly fee: FeeSpeed | FeeOverride;
}

export interface StoredIntent extends DriverIntent {
  readonly assetId: AssetId;
}

export interface IntentSummary {
  readonly asset: AssetId;
  readonly outputs: readonly { readonly to: string; readonly amount: string }[];
  readonly memo?: string;
}

export function collectOutputs(intent: TransferIntent): readonly TransferOutputInput[] {
  const shorthand = intent.to !== undefined || intent.amount !== undefined;
  if (shorthand && intent.outputs !== undefined) {
    throw new ValidationError(
      'INVALID_INTENT',
      'use either { to, amount } or outputs, not both',
    );
  }
  if (shorthand) {
    if (intent.to === undefined || intent.amount === undefined) {
      throw new ValidationError('INVALID_INTENT', 'both to and amount are required');
    }
    return [{ to: intent.to, amount: intent.amount }];
  }
  if (!intent.outputs || intent.outputs.length === 0) {
    throw new ValidationError('INVALID_INTENT', 'at least one output is required');
  }
  return intent.outputs;
}

export function toStoredIntent(intent: NormalizedIntent): StoredIntent {
  return {
    assetId: intent.asset.id,
    asset: intent.asset.ref,
    // P6-1: a variant is kept (and so hashed) only when the address has one, so intents of
    // chains without variants hash exactly as before.
    outputs: intent.outputs.map((o) => ({
      to: o.to.canonical,
      amount: o.amount.base,
      ...(o.to.variant ? { variant: plainVariant(o.to.variant) } : {}),
    })),
    from: intent.from.canonical,
    ...(intent.memo !== undefined ? { memo: intent.memo } : {}),
    fee: intent.fee,
  };
}

export function summarizeIntent(intent: StoredIntent): IntentSummary {
  return {
    asset: intent.assetId,
    outputs: intent.outputs.map((o) => ({ to: o.to, amount: o.amount.toString() })),
    ...(intent.memo !== undefined ? { memo: intent.memo } : {}),
  };
}

/** Stable hash of the normalized intent: equal intents in different input forms collide. */
export function intentHash(chain: string, network: string, intent: StoredIntent): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      chain,
      network,
      asset: intent.assetId,
      outputs: intent.outputs,
      from: intent.from,
      memo: intent.memo ?? null,
      fee: intent.fee,
    }),
  );
}

/**
 * M11: a copy of an address variant that holds plain JSON values only (strings, finite
 * numbers, booleans, null), so the stored intent stays plain data (R11) and hashes stably.
 * The message names no address.
 */
function plainVariant(
  variant: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  for (const value of Object.values(variant)) {
    const plain =
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value));
    if (!plain) {
      throw new ValidationError(
        'INVALID_ADDRESS',
        'an address variant may hold only strings, finite numbers, booleans and null',
      );
    }
  }
  return { ...variant };
}
