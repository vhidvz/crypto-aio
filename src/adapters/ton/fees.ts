/**
 * The `ton` fee kind, pure: the `network` charge (import, gas and
 * storage from the endpoint's emulation, plus every outgoing message's forward fee) and,
 * for jettons, the `attached` charge whose unspent part the jetton wallet refunds. TON fees
 * are fixed by the network config, so a speed changes nothing; the only override is the
 * jetton `attached` value. Every amount is a bigint in nanograms, so no sum or product
 * rounds. SDK-free.
 */
import { ValidationError } from '../../core/errors/error';
import {
  isFeeSpeed,
  type FeeEstimateDraft,
  type FeeOverride,
  type FeeSpeed,
} from '../../core/model/fee';
import type { TonFeeDetails } from './types';

/** The largest `Coins` value (TL-B `VarUInteger 16`): every nanogram amount on the wire. */
export const MAX_COINS = (1n << 120n) - 1n;

const isCoins = (value: unknown): value is bigint =>
  typeof value === 'bigint' && value >= 0n && value <= MAX_COINS;

export interface FeeRequest {
  readonly speed: FeeSpeed | 'custom';
  /** Jettons only: the override, or `undefined` for the network's default. */
  readonly attached?: bigint;
}

/** Validates `TransferIntent.fee` for TON. */
export function feeRequest(fee: FeeSpeed | FeeOverride, jetton: boolean): FeeRequest {
  if (isFeeSpeed(fee)) return { speed: fee };
  if (typeof fee !== 'object' || fee === null) {
    throw new ValidationError(
      'INVALID_INTENT',
      `a TON fee is a speed or an override object`,
    );
  }
  const keys = Object.keys(fee).filter((key) => fee[key] !== undefined);
  if (keys.some((key) => key !== 'attached')) {
    throw new ValidationError(
      'INVALID_INTENT',
      `a TON fee override takes only 'attached' (jetton transfers)`,
    );
  }
  const attached = Object.hasOwn(fee, 'attached') ? fee.attached : undefined;
  if (attached === undefined) return { speed: 'custom' };
  if (!jetton) {
    throw new ValidationError(
      'INVALID_INTENT',
      `'attached' applies to jetton transfers only`,
    );
  }
  // Encoded as Coins in each jetton wallet message: range-checked here with a fixed text,
  // never left to the encoder to wrap or throw.
  if (!isCoins(attached) || attached === 0n) {
    throw new ValidationError(
      'INVALID_INTENT',
      `'attached' must be a bigint in [1, 2^120 - 1] (nanograms)`,
    );
  }
  return { speed: 'custom', attached };
}

/** The `network` charge of a draft's details. */
export function networkFee(details: TonFeeDetails): bigint {
  return details.importFee + details.gasFee + details.storageFee + details.forwardFee;
}

/** The fee draft: `expected` for native coin, `upper` with the attached value for jettons. */
export function tonFeeDraft(args: {
  readonly speed: FeeSpeed | 'custom';
  readonly details: TonFeeDetails;
  /** Jetton transfers: how many jetton wallet messages carry `details.attached`. */
  readonly jettonOutputs?: number;
  readonly payer: string;
}): FeeEstimateDraft {
  // A draft is a stored record of plain data: only what `tonFeeDetails` reads back.
  const details = tonFeeDetails({ ...args.details });
  const outputs = args.jettonOutputs;
  if ((outputs === undefined) !== (details.attached === undefined)) {
    throw new ValidationError(
      'INVALID_INTENT',
      'a TON jetton fee needs both its outputs and its attached value',
    );
  }
  const charges = [
    { asset: 'native' as const, amount: networkFee(details), label: 'network' },
  ];
  if (outputs !== undefined) {
    if (!Number.isSafeInteger(outputs) || outputs < 1) {
      throw new ValidationError(
        'INVALID_INTENT',
        'a TON jetton fee needs a positive whole number of outputs',
      );
    }
    charges.push({
      asset: 'native',
      amount: (details.attached as bigint) * BigInt(outputs),
      label: 'attached',
    });
  }
  return {
    kind: 'ton',
    speed: args.speed,
    charges,
    bound: outputs !== undefined ? 'upper' : 'expected',
    payer: args.payer,
    details: { ...details },
  };
}

/**
 * Parses `fee.details` back (drafts are stored records: plain data only). Strict: a
 * missing or ill-typed field is refused, never filled with a default, so a damaged record
 * cannot change what a transfer attaches or whether it deploys. `undefined` is absent, and
 * keys the core adds (`requestedFee`) are not read.
 */
export function tonFeeDetails(details: Readonly<Record<string, unknown>>): TonFeeDetails {
  const field = (key: string): unknown =>
    Object.hasOwn(details, key) ? details[key] : undefined;
  const refuse = (key: string): never => {
    throw new ValidationError('INVALID_INTENT', `the TON fee has no valid '${key}'`);
  };
  const coins = (key: string): bigint => {
    const value = field(key);
    return isCoins(value) ? value : refuse(key);
  };
  const source = field('forwardFeeSource');
  if (source !== 'emulated' && source !== 'computed') refuse('forwardFeeSource');
  const deploy = field('deploy');
  if (typeof deploy !== 'boolean') refuse('deploy');
  const result: TonFeeDetails = {
    importFee: coins('importFee'),
    gasFee: coins('gasFee'),
    storageFee: coins('storageFee'),
    forwardFee: coins('forwardFee'),
    forwardFeeSource: source as TonFeeDetails['forwardFeeSource'],
    deploy: deploy as boolean,
  };
  let attached: bigint | undefined;
  if (field('attached') !== undefined) {
    attached = coins('attached');
    if (attached === 0n) refuse('attached');
  }
  const forwardAmount =
    field('forwardAmount') !== undefined ? coins('forwardAmount') : undefined;
  return {
    ...result,
    ...(attached !== undefined ? { attached } : {}),
    ...(forwardAmount !== undefined ? { forwardAmount } : {}),
  };
}
