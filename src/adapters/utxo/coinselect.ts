/**
 * Transaction size and coin selection (pure; spec §15: `accumulative`, the default, and
 * `all`). Sizes are exact weight units with worst-case signatures (a low-s DER ECDSA
 * signature is at most 71 bytes plus the sighash byte; BIP340 is 64 bytes), so the signed
 * transaction is never larger than estimated and its fee rate never lower. Change below the
 * dust threshold is not created; its value goes to the fee (bounded by the absurd-fee guard).
 */
import { ValidationError } from '../../core/errors/error';
import { compactSize, dustThreshold } from './address';
import { feeAt } from './fees';
import type { CoinSelectionStrategy } from './network';
import type { UtxoAddressType } from './types';

/** Bitcoin Core's `MAX_STANDARD_TX_WEIGHT` (policy.h). */
export const MAX_STANDARD_WEIGHT = 400_000;

/** Per input: non-witness bytes (outpoint, script, sequence) and witness bytes. */
const INPUT_SIZE: Readonly<Record<UtxoAddressType, { base: number; witness: number }>> = {
  // 32 + 4 + 1 (empty script) + 4; witness: count, 72-byte signature push, 33-byte key push.
  p2wpkh: { base: 41, witness: 1 + 1 + 72 + 1 + 33 },
  // scriptSig: 1 (length) + 1 (push) + 22-byte redeem script.
  'p2sh-p2wpkh': { base: 32 + 4 + 1 + 23 + 4, witness: 1 + 1 + 72 + 1 + 33 },
  // scriptSig: 1 (length) + 1 + 72 + 1 + 33.
  p2pkh: { base: 32 + 4 + 1 + 107 + 4, witness: 0 },
  // witness: count, 64-byte signature push (SIGHASH_DEFAULT).
  p2tr: { base: 41, witness: 1 + 1 + 64 },
};

/** The weight of a transaction spending `inputs` inputs of one type to these outputs. */
export function txWeight(
  inputType: UtxoAddressType,
  inputs: number,
  outputScriptLengths: readonly number[],
): number {
  const size = INPUT_SIZE[inputType];
  let base =
    4 +
    compactSize(inputs) +
    inputs * size.base +
    compactSize(outputScriptLengths.length) +
    4;
  for (const length of outputScriptLengths) base += 8 + compactSize(length) + length;
  const witness = size.witness > 0 ? 2 + inputs * size.witness : 0;
  return base * 4 + witness;
}

export const vsizeOf = (weight: number): number => Math.ceil(weight / 4);

export interface Spendable {
  /** `txid:vout`. */
  readonly outpoint: string;
  readonly txid: string;
  readonly vout: number;
  readonly value: bigint;
}

export interface PlannedOutput {
  readonly script: Uint8Array;
  readonly value: bigint;
}

export interface SelectionRequest {
  /** Eligible outputs of the wallet (already filtered for reservations and confirmations). */
  readonly candidates: readonly Spendable[];
  /** Inputs that must be spent (an RBF replacement keeps every earlier input). */
  readonly required?: readonly Spendable[];
  readonly outputs: readonly PlannedOutput[];
  readonly changeScript: Uint8Array;
  readonly inputType: UtxoAddressType;
  /** sat/kvB. */
  readonly rate: bigint;
  readonly dustRelayFee: bigint;
  readonly strategy: CoinSelectionStrategy;
}

export interface Selection {
  readonly ok: true;
  readonly inputs: readonly Spendable[];
  readonly change: bigint;
  readonly fee: bigint;
  readonly vsize: number;
}

export interface Shortfall {
  readonly ok: false;
  readonly required: bigint;
  readonly available: bigint;
  /** The fee of spending every eligible output (for an estimate that cannot be met). */
  readonly fee: bigint;
  readonly vsize: number;
}

const byValue = (a: Spendable, b: Spendable): number =>
  a.value === b.value ? (a.outpoint < b.outpoint ? -1 : 1) : a.value > b.value ? -1 : 1;

function assertStandard(weight: number): void {
  if (weight > MAX_STANDARD_WEIGHT) {
    throw new ValidationError(
      'INVALID_INTENT',
      'the transaction would exceed the standard size (400,000 weight units)',
    );
  }
}

/** Picks inputs for the outputs at `rate`; deterministic for the same candidates. */
export function selectCoins(request: SelectionRequest): Selection | Shortfall {
  const { outputs, inputType, rate, changeScript } = request;
  const required = request.required ?? [];
  // An outpoint is spent once, even when a listing names it twice (a node would refuse the
  // transaction as `bad-txns-inputs-duplicate`, which ends the Attempt as rejected).
  const seen = new Set(required.map((input) => input.outpoint));
  const pool: Spendable[] = [];
  for (const candidate of request.candidates) {
    if (seen.has(candidate.outpoint)) continue;
    seen.add(candidate.outpoint);
    pool.push(candidate);
  }
  pool.sort(byValue);
  const scripts = outputs.map((o) => o.script.length);
  const target = outputs.reduce((sum, o) => sum + o.value, 0n);
  const dust = dustThreshold(changeScript, request.dustRelayFee);
  const marginal = feeAt(
    rate,
    vsizeOf(txWeight(inputType, 1, []) - txWeight(inputType, 0, [])),
  );

  const settle = (inputs: readonly Spendable[]): Selection | undefined => {
    const total = inputs.reduce((sum, i) => sum + i.value, 0n);
    const bare = vsizeOf(txWeight(inputType, inputs.length, scripts));
    if (total < target + feeAt(rate, bare)) return undefined;
    const withChangeWeight = txWeight(inputType, inputs.length, [
      ...scripts,
      changeScript.length,
    ]);
    const withChange = vsizeOf(withChangeWeight);
    const change = total - target - feeAt(rate, withChange);
    if (change >= dust) {
      assertStandard(withChangeWeight);
      return {
        ok: true,
        inputs,
        change,
        fee: total - target - change,
        vsize: withChange,
      };
    }
    assertStandard(txWeight(inputType, inputs.length, scripts));
    return { ok: true, inputs, change: 0n, fee: total - target, vsize: bare };
  };

  const everything = [...required, ...pool];
  if (request.strategy === 'all') {
    const done = everything.length > 0 ? settle(everything) : undefined;
    if (done) return done;
  } else {
    const chosen: Spendable[] = [...required];
    const first = chosen.length > 0 ? settle(chosen) : undefined;
    if (first) return first;
    for (const candidate of pool) {
      if (candidate.value <= marginal) continue; // costs more to spend than it is worth
      chosen.push(candidate);
      const done = settle(chosen);
      if (done) return done;
    }
    // `marginal` rounds one input's cost up on its own, but a step in the whole
    // transaction's size can be a vbyte or a satoshi less: a skipped output may still pay
    // its way, so everything is tried before a shortfall is reported.
    if (chosen.length < everything.length) {
      const done = settle(everything);
      if (done) return done;
    }
  }
  const vsize = vsizeOf(txWeight(inputType, everything.length, scripts));
  const fee = feeAt(rate, vsize);
  return {
    ok: false,
    required: target + fee,
    available: everything.reduce((sum, i) => sum + i.value, 0n),
    fee,
    vsize,
  };
}
