/**
 * Avalanche addresses, point reads, observation, address history and
 * `ext.avalanche.listUnspent`. Every call carries the tags of the `ChainDriver` contract
 * table: `read` for point queries, `monitor` for heights and observations.
 *
 * Observation: the X-Chain has no mempool view (its `getTxStatus` is deprecated and only
 * reports accepted or unknown), so a transaction is in a block once the node holds it and
 * unknown before. The P-Chain also reports its mempool (`Processing`) and an aborted
 * proposal. An accepted transaction whose block is not located yet reads as `mempool`: it
 * is known to the network, and the next look finds its block. An X-Chain transaction from
 * before the linearization (April 2023) has no block and reads as not seen.
 */
import type {
  AddressCodec,
  AddressHistorySource,
  ChainReader,
  DriverBlock,
  DriverTransaction,
  DriverTxObservation,
} from '../../core/driver/types';
import { UnsupportedCapabilityError, ValidationError } from '../../core/errors/error';
import type { AssetRef } from '../../core/model/asset';
import {
  addressBytesOf,
  decodeAddress,
  formatAddress,
  normalizeAddress,
} from './address';
import type { NodeBlock, PlatformStatus } from './api';
import { isId } from './cb58';
import { parseUtxo, spendableBy, type ParsedUtxo } from './codec';
import {
  MONITOR,
  READ,
  contradiction,
  locate,
  proofRead,
  withSignal,
  type AvalancheContext,
} from './context';
import { decodeTransaction } from './decode';
import type { AvalancheCallTags, AvalancheUnspent } from './types';

/** The Data API serves at most 100 transactions per page. */
const HISTORY_PAGE = 100;
const PAGE_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_HEIGHT = BigInt(Number.MAX_SAFE_INTEGER);

export function assertNative(asset: AssetRef): void {
  if (asset !== 'native') {
    throw new UnsupportedCapabilityError(
      'UNSUPPORTED_CAPABILITY',
      'only AVAX can be sent or read on the X-Chain and P-Chain here; Avalanche native tokens are not supported',
    );
  }
}

export function addressCodec(ctx: AvalancheContext): AddressCodec {
  const { config } = ctx;
  return {
    validate: (address) => {
      try {
        decodeAddress(address, config);
        return true;
      } catch {
        return false;
      }
    },
    normalize: (address) => normalizeAddress(address, config),
    fromPublicKey: (publicKey) => {
      const canonical = formatAddress(addressBytesOf(publicKey), config);
      return { canonical, display: canonical };
    },
  };
}

export const toDriverBlock = (block: NodeBlock): DriverBlock => ({
  height: block.height,
  hash: block.id,
  parentHash: block.parentId,
  ...(block.timestamp !== undefined ? { timestamp: block.timestamp } : {}),
  transactionIds: block.txIds,
});

/** Every output `address` owns on this chain, parsed (the node's UTXO set). */
export async function ownedUtxos(
  ctx: AvalancheContext,
  address: string,
  tags: AvalancheCallTags,
): Promise<ParsedUtxo[]> {
  const canonical = normalizeAddress(address, ctx.config).canonical;
  const listed = await ctx.node.utxos(canonical, tags);
  return listed.map((bytes) => parseUtxo(bytes, ctx.config));
}

/**
 * The outputs a transfer from `address` may spend, largest first (fewest inputs, so the
 * lowest P-Chain fee), each id once; `exclude` leaves out those held by live Operations.
 */
export async function spendable(
  ctx: AvalancheContext,
  address: string,
  exclude: readonly string[] | undefined,
  signal?: AbortSignal,
): Promise<ParsedUtxo[]> {
  const from = decodeAddress(address, ctx.config);
  const held = new Set(exclude ?? []);
  const owned = await ownedUtxos(ctx, address, withSignal(READ, signal));
  return owned
    .filter((utxo) => !held.has(utxo.utxoId) && spendableBy(utxo, from, ctx.config))
    .sort((a, b) =>
      a.amount === b.amount
        ? a.utxoId < b.utxoId
          ? -1
          : 1
        : a.amount > b.amount
          ? -1
          : 1,
    );
}

/** `ext.avalanche.listUnspent`: every owned output, largest first. */
export async function listUnspent(
  ctx: AvalancheContext,
  address: string,
): Promise<AvalancheUnspent[]> {
  const from = decodeAddress(address, ctx.config);
  const owned = await ownedUtxos(ctx, address, READ);
  return owned
    .map((utxo) => ({
      utxoId: utxo.utxoId,
      txId: utxo.txId,
      outputIndex: utxo.outputIndex,
      assetId: utxo.assetId,
      amount: utxo.amount,
      locktime: utxo.locktime,
      threshold: utxo.threshold,
      spendable: spendableBy(utxo, from, ctx.config),
    }))
    .sort((a, b) =>
      a.amount === b.amount
        ? a.utxoId < b.utxoId
          ? -1
          : 1
        : a.amount > b.amount
          ? -1
          : 1,
    );
}

/** What a located, accepted transaction looks like to the core. */
async function inBlock(
  ctx: AvalancheContext,
  txId: string,
  status: 'accepted' | 'aborted',
  tags: AvalancheCallTags,
): Promise<DriverTxObservation> {
  const location = await locate(ctx, txId, tags);
  // Accepted before the X-Chain had blocks: final, but there is no block to name.
  if (location === 'no-block') return { seen: 'none' };
  if (!location) return { seen: 'mempool', txHash: txId };
  return {
    seen: 'block',
    txHash: txId,
    blockHeight: location.height,
    blockHash: location.hash,
    success: status === 'accepted',
    ...(status === 'aborted' ? { reason: 'the transaction was aborted' } : {}),
  };
}

/**
 * The node's view of `txId` and, once accepted, its block. X-Chain: accepted when the node
 * holds it (`present`), else not seen. P-Chain: from `platform.getTxStatus`.
 */
async function observeId(
  ctx: AvalancheContext,
  txId: string,
  tags: AvalancheCallTags,
  present?: boolean,
): Promise<DriverTxObservation> {
  if (ctx.config.vm === 'avm') {
    const accepted = present ?? (await ctx.node.txBytes(txId, tags)) !== null;
    return accepted ? inBlock(ctx, txId, 'accepted', tags) : { seen: 'none' };
  }
  const status: PlatformStatus = await ctx.node.txStatus(txId, tags);
  switch (status) {
    case 'Committed':
      return inBlock(ctx, txId, 'accepted', tags);
    case 'Aborted':
      return inBlock(ctx, txId, 'aborted', tags);
    case 'Processing':
      return { seen: 'mempool', txHash: txId };
    default:
      // Dropped (the node's mempool refused it) or Unknown: not seen.
      return { seen: 'none' };
  }
}

export function chainReader(ctx: AvalancheContext): ChainReader {
  const { node } = ctx;
  return {
    getBalance: async (address, asset) => {
      assertNative(asset);
      const utxos = await spendable(ctx, address, undefined);
      return utxos.reduce((sum, utxo) => sum + utxo.amount, 0n);
    },
    getBlockHeight: () => node.height(MONITOR),
    // Snowman: an accepted block is final; N confirmations trail the head by N − 1.
    getFinalizedHeight: async () => {
      const height = (await node.height(MONITOR)) - BigInt(ctx.config.confirmations) + 1n;
      return height < 0n ? 0n : height;
    },
    getBlock: async (ref) => {
      if (typeof ref === 'string') {
        // I2: a malformed id never reaches the node.
        const block = isId(ref) ? await node.blockById(ref, READ) : null;
        return block ? toDriverBlock(block) : null;
      }
      if (ref < 0n || ref > MAX_HEIGHT) return null;
      const block = await node.blockAt(ref, READ);
      return block ? toDriverBlock(block) : null;
    },
    getTransaction: async (id) => {
      if (!isId(id)) return null; // I2
      const bytes = await node.txBytes(id, READ);
      if (!bytes) return null;
      const observation = await observeId(ctx, id, READ, true);
      return decodeTransaction(bytes, ctx.config, observation);
    },
    // Lesson 18, widened: a refusal on any of these reads decides nothing (retryable).
    observe: async (ref) =>
      isId(ref.id) ? proofRead(() => observeId(ctx, ref.id, MONITOR)) : { seen: 'none' },
  };
}

/**
 * Address history from the Data API, newest first; the cursor is its page token. Each
 * transaction's bytes come from the node (they authenticate themselves by their id) and are
 * decoded here; one that pays the address nothing and that it did not sign is left out
 * (lesson 6: a server that dropped its filter never lists another address's), and
 * every listed transaction counts toward `limit`, so paging stays bounded. An X-Chain
 * transaction from before its linearization has no block, so it reads as not seen.
 */
export function addressHistory(ctx: AvalancheContext): AddressHistorySource {
  return {
    async list(address, { cursor, limit }) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new ValidationError('INVALID_INTENT', 'limit must be a positive integer');
      }
      if (cursor !== undefined && !PAGE_TOKEN.test(cursor)) {
        throw new ValidationError('INVALID_INTENT', 'malformed history cursor');
      }
      const canonical = normalizeAddress(address, ctx.config).canonical;
      const items: DriverTransaction[] = [];
      let served = 0;
      let next = cursor;
      do {
        const page = await ctx.dataApi.history(
          canonical,
          {
            ...(next !== undefined ? { cursor: next } : {}),
            pageSize: Math.min(HISTORY_PAGE, limit - served),
          },
          READ,
        );
        for (const entry of page.items) {
          const bytes = await ctx.node.txBytes(entry.txId, READ);
          if (!bytes) {
            throw contradiction('the indexer lists a transaction the node does not have');
          }
          const observation: DriverTxObservation = entry.location
            ? {
                seen: 'block',
                txHash: entry.txId,
                blockHeight: entry.location.height,
                blockHash: entry.location.hash,
                success: true,
              }
            : { seen: 'none' };
          const tx = decodeTransaction(bytes, ctx.config, observation);
          const signers = tx.details.signers as readonly string[] | undefined;
          const touches =
            tx.transfers.some((t) => t.to === canonical) ||
            (signers ?? []).includes(canonical);
          if (touches) items.push(tx);
          served++;
        }
        next = page.next;
      } while (served < limit && next !== undefined);
      return { items, ...(next !== undefined ? { next } : {}) };
    },
  };
}
