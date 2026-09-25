import type { AssetService } from '../assets/service';
import type { ResolvedSelection } from '../config/types';
import type {
  ChainDriver,
  DriverBlock,
  DriverTransaction,
  DriverTransfer,
  DriverTxObservation,
} from '../driver/types';
import { isCryptoAioError } from '../errors/error';
import { Address } from '../model/address';
import { Amount } from '../model/amount';
import type { AssetInfo, AssetRef } from '../model/asset';
import type { FeeEstimate, FeeEstimateDraft } from '../model/fee';
import type { Block, Transaction, Transfer, TxStatus } from '../model/transaction';

export interface MappingContext {
  readonly selection: ResolvedSelection;
  readonly driver: ChainDriver;
  readonly assets: AssetService;
}

export function toAddress(ctx: MappingContext, value: string): Address {
  return new Address(
    ctx.selection.chain.id,
    ctx.driver.address.normalize(value),
    ctx.driver.address.format,
  );
}

/** Addresses decoded from chain data may be unusual (contract creation, burn); keep them raw. */
function lenientAddress(ctx: MappingContext, value: string): Address {
  try {
    return toAddress(ctx, value);
  } catch {
    return new Address(ctx.selection.chain.id, { canonical: value, display: value });
  }
}

const resolveAsset = (ctx: MappingContext, ref: AssetRef) =>
  ctx.assets.resolve(ctx.selection, ctx.driver, ref);

export async function toFeeEstimate(
  ctx: MappingContext,
  draft: FeeEstimateDraft,
): Promise<FeeEstimate> {
  const charges = await Promise.all(
    draft.charges.map(async (charge) => ({
      amount: Amount.fromBase(charge.amount, await resolveAsset(ctx, charge.asset)),
      label: charge.label,
    })),
  );
  return {
    kind: draft.kind,
    speed: draft.speed,
    charges,
    bound: draft.bound,
    ...(draft.payer !== undefined ? { payer: lenientAddress(ctx, draft.payer) } : {}),
    details: draft.details,
  };
}

/**
 * Observation-level status (a single endpoint's view). This never returns `state: 'final'`:
 * that verdict requires `proven` evidence, produced only by the monitor's quorum-checked
 * path (Task 25's `statusOf`). A block at or below the finalized height is reported as
 * `state: 'included'` with `finality: 'final'`, evidence staying `'observed'`.
 */
export function statusFromObservation(
  observation: DriverTxObservation,
  head: bigint,
  finalized: bigint,
): TxStatus {
  if (observation.seen === 'block' && observation.blockHeight !== undefined) {
    const depth = head - observation.blockHeight + 1n;
    const isFinal = observation.blockHeight <= finalized;
    return {
      state: observation.success === false ? 'failed' : 'included',
      evidence: 'observed',
      confirmations: depth > 0n ? Number(depth) : 0,
      finality: isFinal ? 'final' : 'probabilistic',
      blockHeight: observation.blockHeight,
      ...(observation.txHash !== undefined ? { txHash: observation.txHash } : {}),
      ...(observation.blockHash !== undefined
        ? { blockHash: observation.blockHash }
        : {}),
      ...(observation.reason !== undefined ? { reason: observation.reason } : {}),
    };
  }
  return {
    state: observation.seen === 'mempool' ? 'mempool' : 'unknown',
    evidence: 'observed',
    confirmations: 0,
    finality: 'none',
  };
}

export function toBlock(block: DriverBlock): Block {
  return {
    height: block.height,
    hash: block.hash,
    parentHash: block.parentHash,
    ...(block.timestamp !== undefined ? { timestamp: block.timestamp } : {}),
    ...(block.transactionIds ? { transactionIds: block.transactionIds } : {}),
  };
}

/**
 * R35: a transfer whose asset does not resolve becomes an `UnresolvedTransfer` marker, so
 * one junk token never fails a whole read. Only a retryable failure propagates, and the
 * read is then retried; an error that is not a crypto-aio error is a driver bug and
 * propagates too.
 */
async function toTransfer(
  ctx: MappingContext,
  txId: string,
  transfer: DriverTransfer,
): Promise<Transfer> {
  const common = {
    id: `${txId}:${transfer.locator}`,
    from: transfer.from.map((value) => lenientAddress(ctx, value)),
    to: lenientAddress(ctx, transfer.to),
    source: transfer.source,
    ...(transfer.memo !== undefined ? { memo: transfer.memo } : {}),
  };
  let asset: AssetInfo;
  try {
    asset = await resolveAsset(ctx, transfer.asset);
  } catch (error) {
    if (!isCryptoAioError(error) || error.retryable) throw error;
    return {
      ...common,
      unresolved: { asset: transfer.asset, amount: transfer.amount, code: error.code },
    };
  }
  return { ...common, asset, amount: Amount.fromBase(transfer.amount, asset) };
}

export async function toTransaction(
  ctx: MappingContext,
  tx: DriverTransaction,
  head: bigint,
  finalized: bigint,
): Promise<Transaction> {
  const transfers = await Promise.all(
    tx.transfers.map((transfer) => toTransfer(ctx, tx.id, transfer)),
  );
  const unresolved = transfers.some((t) => t.unresolved !== undefined);
  const fee = tx.fee
    ? await Promise.all(
        tx.fee.map(async (f) =>
          Amount.fromBase(f.amount, await resolveAsset(ctx, f.asset)),
        ),
      )
    : undefined;
  const o = tx.observation;
  return {
    id: tx.id,
    chain: ctx.selection.chain.id,
    network: ctx.selection.network.id,
    status: statusFromObservation(o, head, finalized),
    ...(o.seen === 'block' && o.blockHeight !== undefined && o.blockHash !== undefined
      ? {
          block: {
            height: o.blockHeight,
            hash: o.blockHash,
            ...(tx.timestamp !== undefined ? { timestamp: tx.timestamp } : {}),
          },
        }
      : {}),
    ...(fee ? { fee } : {}),
    transfers,
    decoding: unresolved && tx.decoding === 'complete' ? 'partial' : tx.decoding,
    ...(tx.raw ? { raw: tx.raw } : {}),
    details: tx.details,
  };
}
