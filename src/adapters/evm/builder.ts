/**
 * Fees, funds, building, assembling, broadcasting, and same-nonce replace and cancel
 * (spec §7, §8.3, §8.6, §15). One output per transfer, native or ERC-20 `transfer`.
 */
import type {
  BroadcastResult,
  Broadcaster,
  BuildContext,
  ReplacementPolicy,
  TxBuilder,
  WalletKey,
} from '../../core/driver/types';
import {
  ChainError,
  ProviderError,
  SigningError,
  StateError,
  UnsupportedCapabilityError,
  ValidationError,
  isCryptoAioError,
} from '../../core/errors/error';
import { assetId, parseAssetId } from '../../core/model/asset';
import type { FeeEstimateDraft, FeeOverride, FeeSpeed } from '../../core/model/fee';
import type { DriverIntent, IntentSummary } from '../../core/model/intent';
import type { OrderingData } from '../../core/model/ordering';
import type { UnsignedTx } from '../../core/model/transaction';
import { fromHex, toHex } from '../../core/util/bytes';
import { classifyBroadcastError } from './errors';
import {
  FEE_HISTORY_BLOCKS,
  FEE_PERCENTILES,
  TRANSFER_GAS,
  feeDraft,
  feeOf,
  feesFromHistory,
  gasLimitFrom,
  legacyPrice,
  meetsBump,
  minimumBump,
  parseFeeOverride,
  type EvmFeeParams,
} from './fees';
import { GAS_PRICE_ORACLE } from './network';
import { READ, erc20Balance, isRevert, withSignal, type EvmContext } from './reader';
import type { EvmClient, EvmTxFields } from './types';

/** One transfer: `token` is the ERC-20 contract, absent for the native asset. */
interface Transfer {
  readonly to: string;
  readonly amount: bigint;
  readonly token?: string;
}

interface Price {
  readonly speed: FeeSpeed | 'custom';
  readonly params: EvmFeeParams;
  readonly baseFeePerGas?: bigint;
  readonly gasLimit?: bigint;
}

function transferOf(intent: DriverIntent): Transfer {
  if (intent.memo !== undefined) {
    throw new UnsupportedCapabilityError(
      'UNSUPPORTED_CAPABILITY',
      'EVM transfers carry no memo',
    );
  }
  const [output] = intent.outputs;
  if (!output || intent.outputs.length !== 1) {
    throw new ValidationError('INVALID_INTENT', 'an EVM transfer has exactly one output');
  }
  if (intent.asset === 'native') return { to: output.to, amount: output.amount };
  if (intent.asset.standard !== 'erc20') {
    throw new ValidationError('ASSET_RESOLUTION', `EVM tokens use the 'erc20' standard`);
  }
  return { to: output.to, amount: output.amount, token: intent.asset.contract };
}

/** The call a transfer makes: a value transfer, or `transfer(to, amount)` on the token. */
function callOf(
  client: EvmClient,
  transfer: Transfer,
): { to: string; value: bigint; data: string } {
  return transfer.token === undefined
    ? { to: transfer.to, value: transfer.amount, data: '0x' }
    : {
        to: transfer.token,
        value: 0n,
        data: client.abi.encodeTransfer(transfer.to, transfer.amount),
      };
}

function fieldsOf(
  ctx: EvmContext,
  call: { to: string; value: bigint; data: string },
  nonce: bigint,
  gasLimit: bigint,
  params: EvmFeeParams,
): EvmTxFields {
  const base = { chainId: ctx.config.chainId, nonce, gasLimit, ...call };
  return params.type === 'eip1559'
    ? {
        ...base,
        type: 'eip1559',
        maxFeePerGas: params.maxFeePerGas,
        maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      }
    : { ...base, type: 'legacy', gasPrice: params.gasPrice };
}

function nonceOf(ordering: OrderingData | undefined): bigint {
  if (ordering?.kind !== 'nonce') {
    throw new StateError(
      'INVALID_TRANSITION',
      'an EVM transaction needs an allocated nonce',
    );
  }
  return ordering.nonce;
}

/** Rebuilds an unsigned transaction's fields from its ordering, summary and fee (R11). */
function unsignedFields(ctx: EvmContext, unsigned: UnsignedTx): EvmTxFields {
  const { ref } = parseAssetId(unsigned.summary.asset);
  const [output] = unsigned.summary.outputs;
  if (!output)
    throw new ValidationError('INVALID_INTENT', 'the unsigned transaction has no output');
  const transfer: Transfer = {
    to: output.to,
    amount: BigInt(output.amount),
    ...(ref === 'native' ? {} : { token: ref.contract }),
  };
  const { gasLimit, params } = feeOf(unsigned.fee.details);
  return fieldsOf(
    ctx,
    callOf(ctx.client, transfer),
    nonceOf(unsigned.ordering),
    gasLimit,
    params,
  );
}

function keyOf(keys: readonly WalletKey[]): WalletKey {
  const key = keys.find((k) => k.scheme === 'secp256k1-ecdsa');
  if (!key)
    throw new SigningError(
      'SIGNER_UNAVAILABLE',
      'no secp256k1 key for the sending wallet',
    );
  return key;
}

function unsignedTx(
  ctx: EvmContext,
  fields: EvmTxFields,
  fee: FeeEstimateDraft,
  key: WalletKey,
  summary: IntentSummary,
): UnsignedTx {
  const { client } = ctx;
  return {
    payload: { encoding: 'hex', data: client.serializeUnsigned(fields) },
    signingRequests: [
      {
        id: 'r0',
        scheme: 'secp256k1-ecdsa',
        payload: fromHex(client.unsignedHash(fields)),
        payloadKind: 'digest',
        publicKey: key.publicKey,
        ...(key.keyRef ? { keyRef: key.keyRef } : {}),
      },
    ],
    ordering: { kind: 'nonce', nonce: fields.nonce },
    fee,
    summary,
  };
}

async function priceFor(
  ctx: EvmContext,
  fee: FeeSpeed | FeeOverride,
  signal?: AbortSignal,
): Promise<Price> {
  const { client, config } = ctx;
  if (typeof fee === 'object') {
    const { params, gasLimit } = parseFeeOverride(fee, config.feeModel);
    return { speed: 'custom', params, ...(gasLimit !== undefined ? { gasLimit } : {}) };
  }
  if (config.feeModel === 'evm-legacy') {
    return {
      speed: fee,
      params: legacyPrice(await client.gasPrice(withSignal(READ, signal)), fee),
    };
  }
  const history = await client.feeHistory(
    FEE_HISTORY_BLOCKS,
    'latest',
    FEE_PERCENTILES,
    withSignal(READ, signal),
  );
  const { params, baseFeePerGas } = feesFromHistory(
    history,
    fee,
    config.minPriorityFeePerGas,
  );
  return { speed: fee, params, baseFeePerGas };
}

/** OP Stack: the oracle's L1 data fee for these exact unsigned bytes. */
async function l1FeeFor(
  ctx: EvmContext,
  fields: EvmTxFields,
  signal?: AbortSignal,
): Promise<bigint | undefined> {
  if (!ctx.config.l1DataFee) return undefined;
  const { client } = ctx;
  const data = client.abi.encodeGetL1Fee(client.serializeUnsigned(fields));
  const result = await client.call(
    { to: GAS_PRICE_ORACLE, data },
    'latest',
    withSignal(READ, signal),
  );
  try {
    return client.abi.decodeUint256(result);
  } catch {
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'the L1 fee oracle gave no fee');
  }
}

async function draftFor(
  ctx: EvmContext,
  fields: EvmTxFields,
  price: Price,
  signal?: AbortSignal,
): Promise<FeeEstimateDraft> {
  const l1Fee = await l1FeeFor(ctx, fields, signal);
  return feeDraft(price.speed, fields.gasLimit, price.params, {
    ...(price.baseFeePerGas !== undefined ? { baseFeePerGas: price.baseFeePerGas } : {}),
    ...(l1Fee !== undefined ? { l1Fee } : {}),
  });
}

/** The node's gas estimate; a revert or a shortfall becomes a clear pre-signing failure. */
async function estimateGas(
  ctx: EvmContext,
  from: string,
  transfer: Transfer,
  signal?: AbortSignal,
): Promise<bigint> {
  try {
    return await ctx.client.estimateGas(
      { from, ...callOf(ctx.client, transfer) },
      withSignal(READ, signal),
    );
  } catch (error) {
    const definitive = isCryptoAioError(error, 'RPC_ERROR') && !error.ambiguous;
    const message = definitive ? String(error.details?.rpcMessage ?? error.message) : '';
    if (/insufficient funds/i.test(message)) {
      throw new ChainError('INSUFFICIENT_FUNDS', 'insufficient funds for this transfer');
    }
    if (!isRevert(error)) throw error;
    if (transfer.token !== undefined) {
      const available = await erc20Balance(
        ctx.client,
        transfer.token,
        from,
        withSignal(READ, signal),
      );
      if (available < transfer.amount) {
        throw new ChainError(
          'INSUFFICIENT_FUNDS',
          'insufficient token balance for this transfer',
          {
            details: {
              required: transfer.amount.toString(),
              available: available.toString(),
            },
          },
        );
      }
    }
    throw new ValidationError('INVALID_INTENT', 'the transfer would revert');
  }
}

export function createEvmBuilder(ctx: EvmContext): TxBuilder {
  const { client } = ctx;
  return {
    async estimateFee(intent, build: BuildContext) {
      const transfer = transferOf(intent);
      const price = await priceFor(ctx, intent.fee, build.signal);
      const gasLimit =
        price.gasLimit ??
        gasLimitFrom(await estimateGas(ctx, intent.from, transfer, build.signal));
      const nonce = build.ordering?.kind === 'nonce' ? build.ordering.nonce : 0n;
      const fields = fieldsOf(
        ctx,
        callOf(client, transfer),
        nonce,
        gasLimit,
        price.params,
      );
      return draftFor(ctx, fields, price, build.signal);
    },

    async checkFunds(intent, fee, build) {
      const transfer = transferOf(intent);
      if (transfer.token !== undefined) {
        const available = await erc20Balance(
          client,
          transfer.token,
          intent.from,
          withSignal(READ, build.signal),
        );
        if (available < transfer.amount) {
          return {
            ok: false,
            asset: { standard: 'erc20', contract: transfer.token },
            required: transfer.amount,
            available,
          };
        }
      }
      const cost = fee.charges.reduce(
        (sum, c) => (c.asset === 'native' ? sum + c.amount : sum),
        0n,
      );
      const required = cost + (transfer.token === undefined ? transfer.amount : 0n);
      const available = await client.getBalance(
        intent.from,
        'latest',
        withSignal(READ, build.signal),
      );
      return available >= required
        ? { ok: true }
        : { ok: false, asset: 'native', required, available };
    },

    async build(intent, fee, build) {
      const transfer = transferOf(intent);
      const { gasLimit, params } = feeOf(fee.details);
      const model = params.type === 'eip1559' ? 'evm-1559' : 'evm-legacy';
      if (model !== ctx.config.feeModel) {
        throw new ValidationError(
          'INVALID_INTENT',
          `this network takes ${ctx.config.feeModel} fees`,
        );
      }
      const fields = fieldsOf(
        ctx,
        callOf(client, transfer),
        nonceOf(build.ordering),
        gasLimit,
        params,
      );
      return unsignedTx(ctx, fields, fee, keyOf(build.keys), {
        asset: assetId(ctx.chain.id, ctx.network.id, intent.asset),
        outputs: [{ to: transfer.to, amount: transfer.amount.toString() }],
      });
    },

    async assemble(unsigned, signatures) {
      const request = unsigned.signingRequests[0];
      const signature = signatures.find((s) => s.requestId === request?.id);
      if (
        !request ||
        !signature ||
        signature.bytes.length !== 64 ||
        (signature.recovery !== 0 && signature.recovery !== 1)
      ) {
        throw new SigningError('SIGNING_FAILED', 'missing signature for request r0');
      }
      const mismatch = () =>
        new SigningError(
          'SIGNING_FAILED',
          'the unsigned payload does not match its fee and summary',
        );
      let fields: EvmTxFields;
      try {
        fields = unsignedFields(ctx, unsigned);
      } catch {
        throw mismatch();
      }
      if (client.serializeUnsigned(fields) !== unsigned.payload.data) throw mismatch();
      const { raw, hash } = client.serializeSigned(fields, {
        r: toHex(signature.bytes.slice(0, 32), true),
        s: toHex(signature.bytes.slice(32), true),
        yParity: signature.recovery,
      });
      return {
        raw: { encoding: 'hex', data: raw },
        ref: { id: hash, idKind: 'tx-hash', canonical: true },
      };
    },
  };
}

export function createEvmBroadcaster(client: EvmClient): Broadcaster {
  return {
    async broadcast(signed, options = {}): Promise<BroadcastResult> {
      try {
        await client.sendRawTransaction(signed.raw.data, {
          purpose: 'broadcast',
          retry: 'ambiguous-on-failure',
          ...(options.fanout !== undefined ? { fanout: options.fanout } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return { kind: 'accepted' };
      } catch (error) {
        // R17: an ambiguous error may hide a delivered transaction; it is never classified.
        if (isCryptoAioError(error, 'RPC_ERROR') && !error.ambiguous) {
          return classifyBroadcastError(
            String(error.details?.rpcMessage ?? error.message),
          );
        }
        throw error;
      }
    },
  };
}

/** Same-nonce replace and cancel under the network's bump; absent without a mempool. */
export function createEvmReplacement(ctx: EvmContext): ReplacementPolicy | undefined {
  const { config } = ctx;
  const bump = config.minBumpPercent;
  if (bump === undefined) return undefined;
  const tooLow = (what: string) =>
    new ChainError(
      'FEE_TOO_LOW',
      `${what} must raise the fee cap and the tip by at least ${bump}%`,
    );
  const keyFrom = (previous: UnsignedTx): WalletKey => {
    const request = previous.signingRequests[0];
    if (!request)
      throw new SigningError('SIGNER_UNAVAILABLE', 'the previous attempt has no key');
    return {
      scheme: request.scheme,
      publicKey: request.publicKey,
      ...(request.keyRef ? { keyRef: request.keyRef } : {}),
    };
  };
  return {
    replace: config.capabilities.has('replace-fee'),
    cancel: config.capabilities.has('cancel'),

    async buildReplacement(previous, fee, build) {
      const before = feeOf(previous.fee.details);
      const price = await priceFor(ctx, fee, build.signal);
      if (!meetsBump(before.params, price.params, bump)) throw tooLow('a replacement');
      const old = unsignedFields(ctx, previous);
      const fields = fieldsOf(
        ctx,
        { to: old.to, value: old.value, data: old.data },
        old.nonce,
        price.gasLimit ?? before.gasLimit,
        price.params,
      );
      return unsignedTx(
        ctx,
        fields,
        await draftFor(ctx, fields, price, build.signal),
        keyFrom(previous),
        previous.summary,
      );
    },

    async buildCancel(previous, build, fee) {
      const before = feeOf(previous.fee.details);
      const price: Price =
        fee === undefined
          ? { speed: 'custom', params: minimumBump(before.params, bump) }
          : await priceFor(ctx, fee, build.signal);
      if (!meetsBump(before.params, price.params, bump)) throw tooLow('a cancel');
      const nonce = nonceOf(previous.ordering);
      const fields = fieldsOf(
        ctx,
        { to: build.from, value: 0n, data: '0x' },
        nonce,
        price.gasLimit ?? TRANSFER_GAS,
        price.params,
      );
      return unsignedTx(
        ctx,
        fields,
        await draftFor(ctx, fields, price, build.signal),
        keyFrom(previous),
        {
          asset: assetId(ctx.chain.id, ctx.network.id, 'native'),
          outputs: [{ to: build.from, amount: '0' }],
        },
      );
    },
  };
}
