/**
 * The UTXO builder, broadcaster and RBF replacement policy (spec §15, §8.6).
 *
 * - `build` spends only outputs not held by another live Operation (`ctx.excludeInputs`),
 *   pays change to the wallet's change address, and records the spent outpoints as the
 *   `inputs` ordering. The fee is `exact` once built; the absurd-fee guard runs first.
 * - Every input a build, a replacement or a cancel spends is authenticated against its
 *   previous transaction first (F3-R14): the indexer's value and script count only when the
 *   bytes that hash to the outpoint's txid say the same.
 * - Replacements and cancels keep EVERY input of the Attempt they replace (and may add
 *   confirmed ones), so each new Attempt conflicts with every earlier one (handoff §3:
 *   exclusion is not transitive). Neither ever raises a fee on its own: a fee below the
 *   replacement floor is `FEE_TOO_LOW` (R30, Plan 2 D12).
 * - A cancel pays everything back to the sending address itself (M3).
 * - Broadcast answers are classified by `errors.ts`; an ambiguous transport failure is
 *   rethrown unclassified (R16/R17). A node's rejection is a claim (lesson 21): it stands
 *   only when its reason holds for the bytes that were sent, checked here; else `refused`.
 */
import type {
  BroadcastResult,
  Broadcaster,
  BuildContext,
  ReplacementPolicy,
  TxBuilder,
} from '../../core/driver/types';
import {
  ChainError,
  ProviderError,
  SigningError,
  UnsupportedCapabilityError,
  ValidationError,
  isCryptoAioError,
} from '../../core/errors/error';
import { assetId } from '../../core/model/asset';
import type { FeeEstimateDraft, FeeOverride, FeeSpeed } from '../../core/model/fee';
import type { DriverIntent, IntentSummary } from '../../core/model/intent';
import type { RawTx, SignedTx, UnsignedTx } from '../../core/model/transaction';
import type { SignatureBundle, SigningRequest } from '../../core/signing/types';
import { dustThreshold, type DecodedAddress, type WalletAddress } from './address';
import {
  assembleTx,
  assertPrevious,
  buildTx,
  isPreviousTxRefusal,
  signaturesFromPsbt,
  viewPsbt,
  SEQUENCE_FINAL_LOCKTIME,
  SEQUENCE_RBF,
  type BuiltTx,
  type PlannedInput,
  type PreviousTx,
} from './codec';
import {
  selectCoins,
  txWeight,
  vsizeOf,
  type PlannedOutput,
  type Selection,
  type Spendable,
} from './coinselect';
import { READ, withSignal, type UtxoContext } from './context';
import { classifyOwnBroadcast, parseNodeError } from './errors';
import { MAX_TX_BYTES, readTxHex } from './rawtx';
import { assertSaneFee, feeAt, replacementFloor } from './fees';
import type { Network } from './sdk';
import {
  assertNative,
  changeAddressOf,
  plannedOutputs,
  rateOf,
  senderOf,
  spendable,
  walletOf,
  type Sender,
} from './spend';
import type { UtxoFeeDetails } from './types';

const speedOf = (fee: FeeSpeed | FeeOverride): FeeSpeed | 'custom' =>
  typeof fee === 'string' ? fee : 'custom';

const paidOf = (fee: FeeEstimateDraft): bigint =>
  fee.charges.reduce((sum, charge) => sum + charge.amount, 0n);

function draft(
  from: string,
  speed: FeeSpeed | 'custom',
  fee: bigint,
  details: UtxoFeeDetails,
  bound: 'exact' | 'expected',
): FeeEstimateDraft {
  return {
    kind: 'utxo',
    speed,
    charges: [{ asset: 'native', amount: fee, label: 'network' }],
    bound,
    payer: from,
    details: { ...details },
  };
}

/** `UtxoFeeDetails` of a stored fee, checked (it is our own plain data, R11). */
function detailsOf(fee: FeeEstimateDraft): UtxoFeeDetails {
  const d = fee.details as Partial<UtxoFeeDetails>;
  if (
    fee.kind !== 'utxo' ||
    typeof d.satPerKvB !== 'bigint' ||
    !Number.isSafeInteger(d.vsize) ||
    (d.vsize as number) < 1 ||
    typeof d.change !== 'bigint' ||
    !Number.isSafeInteger(d.changeIndex)
  ) {
    throw new ValidationError('INVALID_INTENT', 'the fee is not a UTXO fee estimate');
  }
  return d as UtxoFeeDetails;
}

/** Everything that builds a transaction; shared by the builder and the replacement policy. */
interface Scope {
  readonly ctx: UtxoContext;
  readonly network: Network;
  readonly sequence: number;
}

const scopeOf = (ctx: UtxoContext, network: Network): Scope => ({
  ctx,
  network,
  sequence: ctx.config.rbf ? SEQUENCE_RBF : SEQUENCE_FINAL_LOCKTIME,
});

const changeOf = (scope: Scope, build: BuildContext, sender: Sender): DecodedAddress =>
  changeAddressOf(scope.ctx, build.wallet, sender, build.keys);

/** R24: the message is a fixed text; the amounts go only in the details (Plan 2's shape). */
const insufficient = (
  what: 'this transfer' | 'the replacement' | 'a cancel',
  required: bigint,
  available: bigint,
): ChainError =>
  new ChainError('INSUFFICIENT_FUNDS', `insufficient funds for ${what}`, {
    details: { required: required.toString(), available: available.toString() },
  });

/** F3-R14 (M3): at most this many previous transactions are read at once for one build. */
export const PREVIOUS_TX_READS = 4;

/**
 * A refusal of a previous transaction put on the provider: the inputs' outpoints and values
 * are the indexer's, and their previous transactions are bound to their txids, so authentic
 * bytes that disagree with the indexer's output decide nothing (retryable), never a user
 * error.
 */
function onProvider<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (!isPreviousTxRefusal(error)) throw error;
    throw new ProviderError(
      'PROVIDER_INCONSISTENT',
      "the indexer's unspent output disagrees with its previous transaction",
      { retryable: true, cause: error },
    );
  }
}

/** The previous transaction of each txid, read at most `PREVIOUS_TX_READS` at a time. */
async function previousTxs(
  scope: Scope,
  txids: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, PreviousTx>> {
  const found = new Map<string, PreviousTx>();
  let next = 0;
  let failed = false;
  const reader = async (): Promise<void> => {
    while (!failed && next < txids.length) {
      const txid = txids[next++] as string;
      try {
        const prev = await scope.ctx.esplora.previousTx(txid, withSignal(READ, signal));
        if (prev === null) {
          throw new ProviderError(
            'PROVIDER_UNAVAILABLE',
            'the previous transaction of an input is not available',
          );
        }
        found.set(txid, prev);
      } catch (error) {
        failed = true; // the other readers stop at their next step
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PREVIOUS_TX_READS, txids.length) }, reader),
  );
  return found;
}

/**
 * F3-R14: every input's value and script, authenticated against its previous transaction
 * (all wallet types, whatever `nonWitnessUtxo` says), so the node never judges bytes built
 * on an indexer's wrong value, and an outpoint its transaction does not have (a phantom that
 * nothing would ever spend, so never proven dead) is never built on. p2pkh inputs carry it
 * (D12), and segwit v0 ones while `nonWitnessUtxo` is on (M15); taproot never does: BIP341
 * commits to every amount, and `signed-psbt.ts` refuses one on a taproot input.
 */
async function authenticated(
  scope: Scope,
  wallet: WalletAddress,
  inputs: readonly Spendable[],
  signal?: AbortSignal,
): Promise<PlannedInput[]> {
  const embed =
    wallet.type === 'p2pkh' ||
    (wallet.type !== 'p2tr' && scope.ctx.config.nonWitnessUtxo);
  const txs = await previousTxs(scope, [...new Set(inputs.map((i) => i.txid))], signal);
  return inputs.map((input) => {
    const prevTx = txs.get(input.txid) as PreviousTx;
    onProvider(() => assertPrevious(prevTx, input, wallet.script));
    return embed ? { ...input, prevTx } : { ...input };
  });
}

/** `buildTx`, with its refusal of a previous transaction put on the provider. */
function builtFor(
  scope: Scope,
  wallet: WalletAddress,
  inputs: readonly PlannedInput[],
  outputs: readonly PlannedOutput[],
): BuiltTx {
  return onProvider(() =>
    buildTx(scope.network, wallet, inputs, outputs, scope.sequence),
  );
}

/** The unsigned transaction for a selection: PSBT, one request per input, exact fee, ordering. */
async function unsignedFor(
  scope: Scope,
  build: BuildContext,
  sender: Sender,
  selection: Selection,
  outputs: readonly PlannedOutput[],
  changeScript: Uint8Array,
  rate: bigint,
  speed: FeeSpeed | 'custom',
  summary: IntentSummary,
): Promise<UnsignedTx> {
  const { wallet, key } = walletOf(scope.ctx, sender, build.keys);
  assertSaneFee(selection.fee, selection.vsize, scope.ctx.config);
  const all: PlannedOutput[] =
    selection.change > 0n
      ? [...outputs, { script: changeScript, value: selection.change }]
      : [...outputs];
  const inputs = await authenticated(scope, wallet, selection.inputs, build.signal);
  const built = builtFor(scope, wallet, inputs, all);
  const signingRequests: SigningRequest[] = built.digests.map((digest, index) => ({
    id: `in:${index}`,
    scheme: wallet.type === 'p2tr' ? 'secp256k1-schnorr' : 'secp256k1-ecdsa',
    payload: digest,
    payloadKind: 'digest',
    publicKey:
      wallet.type === 'p2tr' ? (wallet.outputKey as Uint8Array) : wallet.publicKey,
    ...(key.keyRef ? { keyRef: key.keyRef } : {}),
    ...(wallet.tweak ? { params: { tweak: wallet.tweak } } : {}),
  }));
  return {
    payload: { encoding: 'base64', data: built.psbt },
    ...(built.txid !== undefined
      ? { expectedRef: { id: built.txid, idKind: 'txid', canonical: true } }
      : {}),
    signingRequests,
    ordering: { kind: 'inputs', inputs: selection.inputs.map((i) => i.outpoint).sort() },
    fee: draft(
      sender.from.canonical,
      speed,
      selection.fee,
      {
        satPerKvB: rate,
        vsize: selection.vsize,
        inputs: selection.inputs.length,
        outputs: all.length,
        change: selection.change,
        changeIndex: selection.change > 0n ? outputs.length : -1,
      },
      'exact',
    ),
    summary,
  };
}

/** The replaced Attempt: its inputs (values from its PSBT), payments (no change) and fee. */
function previousOf(scope: Scope, previous: UnsignedTx, sender: Sender) {
  const details = detailsOf(previous.fee);
  const view = viewPsbt(previous.payload.data, scope.network);
  const inputs: Spendable[] = view.inputs.map((i) => ({
    outpoint: i.outpoint,
    txid: i.txid,
    vout: i.vout,
    value: i.value,
  }));
  const outputs = view.outputs.filter((_, index) => index !== details.changeIndex);
  // M1: a real signature may be a byte shorter than the worst case the estimate counts: a
  // full vbyte per legacy input, a quarter per witness input.
  const slack = sender.type === 'p2pkh' ? inputs.length : Math.ceil(inputs.length / 4);
  const minVsize = Math.max(1, details.vsize - slack);
  return { vsize: details.vsize, minVsize, inputs, outputs, paid: paidOf(previous.fee) };
}

export interface UtxoBuilder extends TxBuilder {
  signaturesFrom(unsigned: UnsignedTx, signed: RawTx): readonly SignatureBundle[];
}

export function utxoBuilder(ctx: UtxoContext, network: Network): UtxoBuilder {
  const scope = scopeOf(ctx, network);
  const { config } = ctx;
  const native = assetId(ctx.chain.id, ctx.network.id, 'native');

  const plan = async (intent: DriverIntent, rate: bigint, build: BuildContext) => {
    assertNative(intent.asset);
    // F3-R15: defence in depth behind the network check; nothing here writes a memo.
    if (intent.memo !== undefined) {
      throw new UnsupportedCapabilityError(
        'UNSUPPORTED_CAPABILITY',
        'Bitcoin transfers carry no memo (OP_RETURN is not supported)',
      );
    }
    const sender = senderOf(ctx, intent.from);
    const outputs = plannedOutputs(ctx, intent.outputs);
    const changeScript = changeOf(scope, build, sender).script;
    const candidates = await spendable(
      ctx,
      sender.from.canonical,
      build.excludeInputs,
      config.minInputConfirmations,
      build.signal,
    );
    const selection = selectCoins({
      candidates,
      outputs,
      changeScript,
      inputType: sender.type,
      rate,
      dustRelayFee: config.dustRelayFee,
      strategy: config.coinSelection,
    });
    return { sender, outputs, changeScript, selection };
  };

  return {
    async estimateFee(intent, build) {
      const rate = await rateOf(ctx, intent.fee, build.signal);
      const { sender, selection } = await plan(intent, rate, build);
      const change = selection.ok ? selection.change : 0n;
      return draft(
        sender.from.canonical,
        speedOf(intent.fee),
        selection.fee,
        {
          satPerKvB: rate,
          vsize: selection.vsize,
          inputs: selection.ok ? selection.inputs.length : 0,
          outputs: intent.outputs.length + (change > 0n ? 1 : 0),
          change,
          changeIndex: change > 0n ? intent.outputs.length : -1,
        },
        'expected',
      );
    },

    async checkFunds(intent, fee, build) {
      assertNative(intent.asset);
      const candidates = await spendable(
        ctx,
        senderOf(ctx, intent.from).from.canonical,
        build.excludeInputs,
        config.minInputConfirmations,
        build.signal,
      );
      const available = candidates.reduce((sum, c) => sum + c.value, 0n);
      const required =
        intent.outputs.reduce((sum, o) => sum + o.amount, 0n) + paidOf(fee);
      return available >= required
        ? { ok: true }
        : { ok: false, asset: 'native', required, available };
    },

    async build(intent, fee, build) {
      const rate = detailsOf(fee).satPerKvB;
      const { sender, outputs, changeScript, selection } = await plan(
        intent,
        rate,
        build,
      );
      if (!selection.ok) {
        throw insufficient('this transfer', selection.required, selection.available);
      }
      return unsignedFor(
        scope,
        build,
        sender,
        selection,
        outputs,
        changeScript,
        rate,
        fee.speed,
        {
          asset: native,
          outputs: intent.outputs.map((o) => ({ to: o.to, amount: o.amount.toString() })),
        },
      );
    },

    async assemble(unsigned, signatures) {
      const { hex, txid } = assembleTx(
        unsigned.payload.data,
        network,
        unsigned.signingRequests,
        signatures,
      );
      if (unsigned.expectedRef && unsigned.expectedRef.id !== txid) {
        throw new SigningError(
          'SIGNING_FAILED',
          'the signed transaction id differs from the prepared one',
        );
      }
      return {
        raw: { encoding: 'hex', data: hex },
        ref: { id: txid, idKind: 'txid', canonical: true },
      };
    },

    signaturesFrom(unsigned, signed) {
      if (signed.encoding !== 'base64') {
        throw new ValidationError(
          'INVALID_INTENT',
          'a signed PSBT is expected, as base64',
        );
      }
      return signaturesFromPsbt(
        unsigned.payload.data,
        signed.data,
        network,
        unsigned.signingRequests,
      );
    },
  };
}

/**
 * Twice Bitcoin Core's `MAX_BLOCK_SERIALIZED_SIZE`: no transaction's hex is longer (lesson
 * 20). A flat character class, never a repeated group: V8's regexp stack overflows on a
 * repeated group of a few million matches, which a valid transaction can have.
 */
const MAX_TX_HEX = 8_000_000;
const HEX = /^[0-9a-fA-F]+$/;

export function utxoBroadcaster(ctx: UtxoContext): Broadcaster {
  return {
    async broadcast(signed: SignedTx, options = {}): Promise<BroadcastResult> {
      const { encoding, data } = signed.raw;
      if (
        encoding !== 'hex' ||
        data.length > MAX_TX_HEX ||
        data.length % 2 !== 0 ||
        !HEX.test(data)
      ) {
        throw new ValidationError('INVALID_INTENT', 'a raw Bitcoin transaction is hex');
      }
      const hex = data.toLowerCase();
      try {
        const txid = await ctx.esplora.broadcast(hex, {
          purpose: 'broadcast',
          retry: 'ambiguous-on-failure',
          ...(options.fanout !== undefined ? { fanout: options.fanout } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        // M7: a bare broadcast (no ref) is checked against the bytes' own txid.
        const expected =
          signed.ref.id !== ''
            ? signed.ref.id
            : readTxHex(hex, { maxStripped: MAX_TX_BYTES })?.txid;
        if (txid !== expected) {
          // The node accepted something under another id: the outcome is unknown.
          throw new ProviderError(
            'PROVIDER_UNAVAILABLE',
            'the node answered another txid',
            {
              ambiguous: true,
            },
          );
        }
        return { kind: 'accepted' };
      } catch (error) {
        // A definitive 400 is bitcoind's answer; anything else is rethrown (R16/R17). Lesson
        // 21: a rejection stands only when its reason holds for these bytes, checked here.
        if (
          isCryptoAioError(error, 'RPC_ERROR') &&
          !error.ambiguous &&
          error.details?.status === 400
        ) {
          return classifyOwnBroadcast(
            parseNodeError(String(error.details.body ?? '')),
            hex,
          );
        }
        throw error;
      }
    },
  };
}

const tooLow = (): ChainError =>
  new ChainError(
    'FEE_TOO_LOW',
    'a replacement must pay the replaced fee plus the incremental relay fee, at a higher rate',
  );

export function utxoReplacement(ctx: UtxoContext, network: Network): ReplacementPolicy {
  const scope = scopeOf(ctx, network);
  const { config } = ctx;
  return {
    replace: true,
    cancel: true,

    async buildReplacement(previous, fee, build) {
      const sender = senderOf(ctx, build.from);
      const prev = previousOf(scope, previous, sender);
      const rate = await rateOf(ctx, fee, build.signal);
      const changeScript = changeOf(scope, build, sender).script;
      // BIP125 rule 2: an input it adds must be confirmed; it never takes a held one.
      const candidates = await spendable(
        ctx,
        sender.from.canonical,
        [...(build.excludeInputs ?? []), ...prev.inputs.map((i) => i.outpoint)],
        Math.max(1, config.minInputConfirmations),
        build.signal,
      );
      const selection = selectCoins({
        candidates,
        required: prev.inputs,
        outputs: prev.outputs,
        changeScript,
        inputType: sender.type,
        rate,
        dustRelayFee: config.dustRelayFee,
        strategy: 'accumulative',
      });
      if (!selection.ok) {
        throw insufficient('the replacement', selection.required, selection.available);
      }
      const floor = replacementFloor(
        { fee: prev.paid, vsize: prev.vsize, minVsize: prev.minVsize },
        selection.vsize,
        config.incrementalRelayFee,
      );
      if (selection.fee < floor) throw tooLow();
      return unsignedFor(
        scope,
        build,
        sender,
        selection,
        prev.outputs,
        changeScript,
        rate,
        speedOf(fee),
        previous.summary,
      );
    },

    async buildCancel(previous, build, fee) {
      const sender = senderOf(ctx, build.from);
      const prev = previousOf(scope, previous, sender);
      // M3: a cancel pays everything back to the sending address itself, never to a
      // configured change address (under `allowExternalChangeAddress` an external one). A
      // misconfigured change address is still refused here, as on every path (A19).
      changeOf(scope, build, sender);
      const own = sender.from;
      const total = prev.inputs.reduce((sum, i) => sum + i.value, 0n);
      const vsize = vsizeOf(
        txWeight(sender.type, prev.inputs.length, [own.script.length]),
      );
      const floor = replacementFloor(
        { fee: prev.paid, vsize: prev.vsize, minVsize: prev.minVsize },
        vsize,
        config.incrementalRelayFee,
      );
      let paid = floor;
      let rate = (floor * 1_000n + BigInt(vsize) - 1n) / BigInt(vsize);
      if (fee !== undefined) {
        rate = await rateOf(ctx, fee, build.signal);
        paid = feeAt(rate, vsize);
        if (paid < floor) throw tooLow();
      }
      const dust = dustThreshold(own.script, config.dustRelayFee);
      if (total - paid < dust) throw insufficient('a cancel', paid + dust, total);
      const value = total - paid;
      return unsignedFor(
        scope,
        build,
        sender,
        { ok: true, inputs: prev.inputs, change: 0n, fee: paid, vsize },
        [{ script: own.script, value }],
        own.script,
        rate,
        fee === undefined ? 'custom' : speedOf(fee),
        {
          asset: previous.summary.asset,
          outputs: [{ to: own.canonical, amount: value.toString() }],
        },
      );
    },
  };
}
