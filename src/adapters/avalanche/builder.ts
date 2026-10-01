/**
 * The Avalanche builder and broadcaster (spec §15's UTXO shape, `inputs` ordering).
 * - `build` spends only plain, unlocked AVAX outputs the wallet signs alone and that no
 *   other live Operation holds (`ctx.excludeInputs`), largest first; change goes back to
 *   the sending address; the spent outputs are the `inputs` ordering. The fee is `exact`
 *   once built, and never above `options.maxFee`.
 * - One signing request: the SHA-256 of the unsigned bytes, signed with the wallet's
 *   secp256k1 key; every input's credential carries that signature. The id is known only
 *   after signing (it hashes the credentials).
 * - There is no replacement or cancel: AvalancheGo's mempool keeps the first of two
 *   conflicting transactions, and an accepted one is final.
 * - Broadcast answers are classified by `errors.ts`; an ambiguous transport failure is
 *   rethrown unclassified (R16/R17).
 */
import { sha256 } from '@noble/hashes/sha256';
import type {
  BroadcastResult,
  Broadcaster,
  BuildContext,
  TxBuilder,
  WalletKey,
} from '../../core/driver/types';
import {
  ProviderError,
  SigningError,
  UnsupportedCapabilityError,
  ValidationError,
  isCryptoAioError,
} from '../../core/errors/error';
import { assetId } from '../../core/model/asset';
import type { FeeEstimateDraft, FeeOverride, FeeSpeed } from '../../core/model/fee';
import type { DriverIntent } from '../../core/model/intent';
import type { RawTx, SignedTx, UnsignedTx } from '../../core/model/transaction';
import type { SignatureBundle } from '../../core/signing/types';
import { equalBytes, fromHex, toHex, utf8ToBytes } from '../../core/util/bytes';
import { addressBytesOf, decodeAddress } from './address';
import {
  MAX_MEMO_BYTES,
  MAX_TX_BYTES,
  assembleSigned,
  buildBaseTx,
  credentialSignature,
  parseSignedTx,
  syntheticUtxo,
  type BuiltTx,
  type FeePlan,
  type ParsedUtxo,
  type PlannedOutput,
} from './codec';
import type { AvalancheContext } from './context';
import { classifyIssueError } from './errors';
import { feePlanOf, storedPlan, type FeeConfigCache } from './fees';
import { assertNative, spendable } from './reader';
import { TYPES } from './sdk';
import type { AvalancheFeeDetails } from './types';

/** At most this many outputs per transfer (and one more for change). */
export const MAX_OUTPUTS = 127;
/** At most this many inputs: well inside 64 KiB and the P-Chain's gas capacity. */
export const MAX_INPUTS = 128;
const REQUEST_ID = 'tx';

const speedOf = (fee: FeeSpeed | FeeOverride): FeeSpeed | 'custom' =>
  typeof fee === 'string' ? fee : 'custom';

const sumOf = (values: readonly bigint[]): bigint => values.reduce((s, v) => s + v, 0n);

function draft(
  from: string,
  speed: FeeSpeed | 'custom',
  fee: bigint,
  details: AvalancheFeeDetails,
  bound: 'exact' | 'expected',
): FeeEstimateDraft {
  return {
    kind: 'avalanche',
    speed,
    charges: [{ asset: 'native', amount: fee, label: 'network' }],
    bound,
    payer: from,
    details: { ...details },
  };
}

function detailsOf(plan: FeePlan, built: BuiltTx): AvalancheFeeDetails {
  return plan.model === 'static'
    ? {
        model: 'static',
        txFee: plan.txFee,
        inputs: built.inputs.length,
        outputs: built.outputs,
        change: built.change,
      }
    : {
        model: 'dynamic',
        gasPrice: plan.price,
        ...(built.gas !== undefined ? { gas: built.gas } : {}),
        inputs: built.inputs.length,
        outputs: built.outputs,
        change: built.change,
      };
}

/** The wallet's key, which must own the sending address: nothing is built for others. */
function keyOf(from: Uint8Array, keys: readonly WalletKey[]): WalletKey {
  const key = keys.find((k) => k.scheme === 'secp256k1-ecdsa');
  if (!key) {
    throw new ValidationError(
      'INVALID_INTENT',
      'building an Avalanche transaction needs the wallet public key',
    );
  }
  if (!equalBytes(addressBytesOf(key.publicKey), from)) {
    throw new ValidationError(
      'INVALID_INTENT',
      "the wallet's key does not own the sending address",
    );
  }
  return key;
}

/** The intent's memo as bytes; only the X-Chain carries one (Durango refuses it on P). */
function memoOf(ctx: AvalancheContext, memo: string | undefined): Uint8Array {
  if (memo === undefined) return new Uint8Array();
  if (ctx.config.vm === 'pvm' || !ctx.config.capabilities.has('memo')) {
    throw new UnsupportedCapabilityError(
      'UNSUPPORTED_CAPABILITY',
      'P-Chain transactions carry no memo',
    );
  }
  const bytes = utf8ToBytes(memo);
  if (bytes.length > MAX_MEMO_BYTES) {
    throw new ValidationError('INVALID_INTENT', 'a memo has at most 256 bytes');
  }
  return bytes;
}

function plannedOutputs(
  ctx: AvalancheContext,
  outputs: DriverIntent['outputs'],
): PlannedOutput[] {
  if (outputs.length === 0) {
    throw new ValidationError('INVALID_INTENT', 'at least one output is required');
  }
  if (outputs.length > MAX_OUTPUTS) {
    throw new ValidationError(
      'INVALID_INTENT',
      `a transfer pays at most ${MAX_OUTPUTS} outputs`,
    );
  }
  return outputs.map((output) => {
    if (output.amount < 1n) {
      throw new ValidationError('INVALID_AMOUNT', 'an output must pay at least 1 nAVAX');
    }
    return { to: decodeAddress(output.to, ctx.config), amount: output.amount };
  });
}

export interface AvalancheBuilder extends TxBuilder {
  signaturesFrom(unsigned: UnsignedTx, signed: RawTx): readonly SignatureBundle[];
}

export function avalancheBuilder(ctx: AvalancheContext): AvalancheBuilder {
  const { config, clock } = ctx;
  const native = assetId(ctx.chain.id, ctx.network.id, 'native');
  const feeCache: FeeConfigCache = {};
  const model = config.vm === 'avm' ? 'static' : 'dynamic';

  const plan = async (intent: DriverIntent, build: BuildContext) => {
    assertNative(intent.asset);
    const memo = memoOf(ctx, intent.memo);
    const from = decodeAddress(intent.from, config);
    const outputs = plannedOutputs(ctx, intent.outputs);
    const candidates = await spendable(
      ctx,
      intent.from,
      build.excludeInputs,
      build.signal,
    );
    return { memo, from, outputs, candidates };
  };

  const minIssuanceTime = (): bigint => BigInt(Math.floor(clock.now() / 1000));

  /** Builds with the first `MAX_INPUTS` candidates, which must cover the transfer. */
  const buildWith = (
    planned: Awaited<ReturnType<typeof plan>>,
    fee: FeePlan,
    utxos: readonly ParsedUtxo[],
  ): BuiltTx =>
    buildBaseTx({
      config,
      from: planned.from,
      utxos: utxos.slice(0, MAX_INPUTS),
      outputs: planned.outputs,
      memo: planned.memo,
      minIssuanceTime: minIssuanceTime(),
      fee,
    });

  /** The plan a stored estimate fixed, with today's fee state (capacity) and weights. */
  const planOfStored = async (
    fee: FeeEstimateDraft,
    signal?: AbortSignal,
  ): Promise<FeePlan> => {
    if (fee.kind !== 'avalanche') {
      throw new ValidationError('INVALID_INTENT', 'the fee is not an Avalanche estimate');
    }
    const stored = storedPlan(fee.details, model);
    if (stored.txFee !== undefined) return { model: 'static', txFee: stored.txFee };
    const current = await feePlanOf(ctx, 'slow', feeCache, signal);
    if (current.model !== 'dynamic') throw new Error('unreachable: P-Chain plan');
    if ((stored.gasPrice as bigint) > config.maxGasPrice) {
      throw new ValidationError(
        'INVALID_INTENT',
        'the gas price exceeds the configured maximum (options.maxGasPrice)',
      );
    }
    return { ...current, price: stored.gasPrice as bigint };
  };

  return {
    async estimateFee(intent, build) {
      const planned = await plan(intent, build);
      const fee = await feePlanOf(ctx, intent.fee, feeCache, build.signal);
      const paid = sumOf(planned.outputs.map((o) => o.amount));
      const available = sumOf(planned.candidates.map((u) => u.amount));
      let built: BuiltTx;
      if (planned.candidates.length > 0 && available > paid) {
        try {
          built = buildWith(planned, fee, planned.candidates);
        } catch (error) {
          if (!isCryptoAioError(error, 'INSUFFICIENT_FUNDS')) throw error;
          built = buildWith(planned, fee, [
            syntheticUtxo(planned.from, paid + config.maxFee, config),
          ]);
        }
      } else {
        // Not enough to pay: name the fee of a one-input transfer.
        built = buildWith(planned, fee, [
          syntheticUtxo(planned.from, paid + config.maxFee, config),
        ]);
      }
      return draft(
        intent.from,
        speedOf(intent.fee),
        built.fee,
        detailsOf(fee, built),
        'expected',
      );
    },

    async checkFunds(intent, fee, build) {
      assertNative(intent.asset);
      const candidates = await spendable(
        ctx,
        intent.from,
        build.excludeInputs,
        build.signal,
      );
      const available = sumOf(candidates.map((u) => u.amount));
      const required =
        sumOf(intent.outputs.map((o) => o.amount)) +
        sumOf(fee.charges.map((c) => c.amount));
      return available >= required
        ? { ok: true }
        : { ok: false, asset: 'native', required, available };
    },

    async build(intent, fee, build) {
      const planned = await plan(intent, build);
      const key = keyOf(planned.from, build.keys);
      const feePlan = await planOfStored(fee, build.signal);
      const built = buildWith(planned, feePlan, planned.candidates);
      return {
        payload: { encoding: 'hex', data: toHex(built.bytes) },
        signingRequests: [
          {
            id: REQUEST_ID,
            scheme: 'secp256k1-ecdsa',
            payload: sha256(built.bytes),
            payloadKind: 'digest',
            publicKey: key.publicKey,
            ...(key.keyRef ? { keyRef: key.keyRef } : {}),
          },
        ],
        ordering: { kind: 'inputs', inputs: built.inputs },
        fee: draft(intent.from, fee.speed, built.fee, detailsOf(feePlan, built), 'exact'),
        summary: {
          asset: native,
          outputs: intent.outputs.map((o) => ({ to: o.to, amount: o.amount.toString() })),
          ...(intent.memo !== undefined ? { memo: intent.memo } : {}),
        },
      };
    },

    async assemble(unsigned, signatures) {
      const bundle = signatures.find((s) => s.requestId === REQUEST_ID);
      if (!bundle || bundle.bytes.length !== 64) {
        throw new SigningError('SIGNING_FAILED', 'the transaction signature is missing');
      }
      if (bundle.recovery !== 0 && bundle.recovery !== 1) {
        throw new SigningError(
          'SIGNING_FAILED',
          'an Avalanche signature needs its recovery id (0 or 1)',
        );
      }
      const signed = assembleSigned(
        fromHex(unsigned.payload.data),
        credentialSignature(bundle.bytes, bundle.recovery),
        config,
      );
      const id = parseSignedTx(signed, config).id;
      return {
        raw: { encoding: 'hex', data: toHex(signed) },
        ref: { id, idKind: 'txid', canonical: true },
      };
    },

    signaturesFrom(unsigned, signed) {
      if (signed.encoding !== 'hex' || !/^(?:[0-9a-fA-F]{2})+$/.test(signed.data)) {
        throw new ValidationError(
          'INVALID_INTENT',
          'a signed Avalanche transaction is expected, as hex',
        );
      }
      let parsed: ReturnType<typeof parseSignedTx>;
      try {
        parsed = parseSignedTx(fromHex(signed.data), config);
      } catch {
        throw new ValidationError(
          'INVALID_INTENT',
          'not a signed transaction of this chain',
        );
      }
      if (!equalBytes(parsed.unsignedBytes, fromHex(unsigned.payload.data))) {
        throw new ValidationError(
          'INVALID_INTENT',
          'the signed transaction is not the prepared one',
        );
      }
      const first = parsed.signed
        .getCredentials()
        .find((c) => c._type === TYPES.credential)
        ?.getSignatures()[0];
      if (first === undefined) return [];
      const bytes = fromHex(first.replace(/^0x/, ''));
      return [
        {
          requestId: REQUEST_ID,
          bytes: bytes.subarray(0, 64),
          recovery: bytes[64] as number,
        },
      ];
    },
  };
}

/** Twice the mempool's largest transaction, as hex characters (lesson 20). */
const MAX_TX_HEX = 4 * MAX_TX_BYTES;

export function avalancheBroadcaster(ctx: AvalancheContext): Broadcaster {
  const { config } = ctx;
  return {
    async broadcast(signed: SignedTx, options = {}): Promise<BroadcastResult> {
      const { encoding, data } = signed.raw;
      if (
        encoding !== 'hex' ||
        data.length > MAX_TX_HEX ||
        !/^(?:[0-9a-fA-F]{2})+$/.test(data)
      ) {
        throw new ValidationError(
          'INVALID_INTENT',
          'a raw Avalanche transaction is hex (signed bytes, no checksum)',
        );
      }
      const bytes = fromHex(data);
      let parsed: ReturnType<typeof parseSignedTx>;
      try {
        parsed = parseSignedTx(bytes, config);
      } catch {
        throw new ValidationError(
          'INVALID_INTENT',
          'not a signed transaction of this chain',
        );
      }
      const base = parsed.tx.baseTx;
      if (
        base &&
        (base.NetworkId.value() !== config.networkId ||
          base.BlockchainId.toString() !== config.blockchainId)
      ) {
        throw new ValidationError(
          'INVALID_INTENT',
          'the transaction is for another network or chain',
        );
      }
      // M7: a bare broadcast (no ref) is checked against the bytes' own id.
      if (signed.ref.id !== '' && signed.ref.id !== parsed.id) {
        throw new ValidationError(
          'INVALID_INTENT',
          'the transaction bytes do not have the Attempt id',
        );
      }
      try {
        const id = await ctx.node.issueTx(bytes, {
          purpose: 'broadcast',
          retry: 'ambiguous-on-failure',
          ...(options.fanout !== undefined ? { fanout: options.fanout } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (id !== parsed.id) {
          // The node accepted something under another id: the outcome is unknown.
          throw new ProviderError(
            'PROVIDER_UNAVAILABLE',
            'the node answered another id',
            {
              ambiguous: true,
            },
          );
        }
        return { kind: 'accepted' };
      } catch (error) {
        // A definitive JSON-RPC error is AvalancheGo's answer; anything else is rethrown
        // (R16/R17). Lesson 21: its texts only ever make a refusal (errors.ts).
        if (
          isCryptoAioError(error, 'RPC_ERROR') &&
          !error.ambiguous &&
          typeof error.details?.rpcMessage === 'string'
        ) {
          return classifyIssueError(error.details.rpcMessage);
        }
        throw error;
      }
    },
  };
}
