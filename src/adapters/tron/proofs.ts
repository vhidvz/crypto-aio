/**
 * Proofs, the block source and TronGrid history.
 *
 * Proofs (spec §6.7, §8.5; lessons 16 and 17, final form): every read is a `proof` quorum
 * read, and each fact is attested at its own height, so no endpoint proposes a height:
 * - "my solidified block's timestamp is at or past the expiration" is a monotone predicate
 *   quorum key on the latest solidified block; honest endpoints disagree only in the moment
 *   it becomes true on one of them, which decides nothing;
 * - a block at a fixed height is read from the solidity node, which serves it only once it
 *   is solidified there, keyed on its consensus facts;
 * - `finalizedHead` is the one unanchored read: one endpoint's view, trailed by
 *   `PEER_SKEW` blocks, then attested at that height.
 * A stale or lagging answer is a retryable `PROVIDER_INCONSISTENT` or `PROVIDER_UNAVAILABLE`
 * and decides nothing.
 *
 * Which blocks can hold a transaction (java-tron GreatVoyage-v4.8.2.2 `d5c3d1d1`:
 * `Manager.processBlock` runs `processTransaction`, so `validateTapos` and `validateCommon`,
 * for each transaction, and only then records the block in the recent-block store and as
 * the head):
 * - expiry (D3): a transaction is invalid in a block whose parent's timestamp is at or past
 *   its expiration, and block timestamps strictly increase, so no block after the first one
 *   at or past the expiration can hold it;
 * - TaPoS: only a block above the reference block, and at most `TAPOS_WINDOW` above it, can
 *   hold it.
 *
 * "Not included" (lesson 16; F4-R11, F4-R12): the solidity index (and TronGrid behind a load
 * balancer) can lag, so an empty index answer is never taken as absence. `includedFinal`
 * answers `included: false` only once expiry is attested and a scan of every block that could
 * hold the transaction shows it absent: from the attested first block at or past the SIGNED
 * expiration (the ordering's `expiresAtMs`, which `assemble` binds to the signed bytes) down
 * to the block just above the reference block, whose height the ordering carries
 * (`lastValidHeight − TAPOS_WINDOW`, bound to the signed `ref_block_bytes`). The floor is the
 * attested reference-height block, never a time derived from the expiration: the build-time
 * head is a claim and the local clock may lead, so the expiration can sit any distance after
 * the reference. Each scanned block is read by hash under the quorum, its parent hash names
 * the next, and the walk must end on the attested reference-height block. A scanned block
 * that holds the transaction while the index says nothing decides nothing.
 */
import type {
  AddressHistorySource,
  BlockSource,
  DriverTransaction,
  ProofSource,
} from '../../core/driver/types';
import { ConfigError, ProviderError } from '../../core/errors/error';
import type { OrderingData } from '../../core/model/ordering';
import type { Transport } from '../../core/transport/types';
import { toBase58Address } from './address';
import { decodeTransaction, verdictOf } from './decode';
import {
  MONITOR,
  PROOF,
  READ,
  historyPage,
  notServable,
  type RpcBlock,
  type TronBlockHeader,
} from './http';
import { TAPOS_WINDOW } from './network';
import type { TronContext } from './reader';

function undecided(): ProviderError {
  return new ProviderError(
    'PROVIDER_UNAVAILABLE',
    'finalized state cannot decide this yet',
  );
}

/** Attested answers that the chain's own rules make impossible together: decides nothing. */
function contradiction(what: string): ProviderError {
  return new ProviderError('PROVIDER_INCONSISTENT', `${what}, which decides nothing`, {
    retryable: true,
  });
}

const SLOT_MS = 3_000;
/** How far `finalizedHead` trails one endpoint's solidified head (Plan 2 uses 2). */
const PEER_SKEW = 2n;
/** java-tron's block heights are `long`s. */
const INT64_MAX = 2n ** 63n - 1n;
const TX_ID = /^[0-9a-f]{64}$/;

/** The timestamp of a solidified-block answer, or -1 when it is not one (never agrees). */
function solidTimestamp(answer: unknown): number {
  const raw = (answer as { block_header?: { raw_data?: { timestamp?: unknown } } } | null)
    ?.block_header?.raw_data;
  return typeof raw?.timestamp === 'number' ? raw.timestamp : -1;
}

/**
 * Where an Attempt can be, from its ordering: its signed expiration and its reference
 * block's height; null when either is missing or out of range, which decides nothing.
 */
function attemptBounds(
  ordering: OrderingData,
): { readonly expiration: number; readonly reference: bigint } | null {
  if (ordering.kind !== 'expiry') return null;
  const { expiresAtMs, lastValidHeight } = ordering;
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    typeof lastValidHeight !== 'bigint' ||
    lastValidHeight < TAPOS_WINDOW ||
    lastValidHeight > INT64_MAX
  ) {
    return null;
  }
  return { expiration: expiresAtMs as number, reference: lastValidHeight - TAPOS_WINDOW };
}

/** Scanned blocks kept per driver: immutable chain data (spec §7), so a retry is cheap. */
const SCAN_CACHE_SIZE = 1_024;

export function createTronProofs(ctx: TronContext): ProofSource {
  const { api } = ctx;
  // Only quorum-agreed blocks below an attested solidified block, keyed by hash: final.
  const scanned = new Map<string, RpcBlock>();

  /** The block `hash`, expected at `height`; cached only once its height checks out. */
  async function finalBlockByHash(
    hash: string,
    height: bigint,
  ): Promise<RpcBlock | null> {
    const cached = scanned.get(hash);
    if (cached) return cached;
    const block = await api.rpcBlock(hash, PROOF);
    if (block && block.number === height) {
      if (scanned.size >= SCAN_CACHE_SIZE) {
        scanned.delete(scanned.keys().next().value as string);
      }
      scanned.set(hash, block);
    }
    return block;
  }

  /** A block at a fixed height, attested as solidified on every quorum endpoint. */
  async function solidHeader(height: bigint): Promise<TronBlockHeader> {
    const header = await api.block('solid', height, PROOF);
    if (!header) throw undecided();
    return header;
  }

  /**
   * The latest solidified block when every quorum endpoint's solidified block is at or past
   * `expiration` (a monotone predicate), else null.
   */
  async function passedExpiry(expiration: number): Promise<TronBlockHeader | null> {
    const head = (await api.block('solid', undefined, {
      ...PROOF,
      quorumKey: (answer) => solidTimestamp(answer) >= expiration,
    })) as TronBlockHeader;
    return head.timestamp >= expiration ? head : null;
  }

  /**
   * The solidified block at or past `expiration` nearest to it, or null while the quorum
   * has not solidified past it. Every endpoint has then solidified the first block at or past
   * the expiration, and the walk reads only heights at or below it: no read can stall.
   */
  async function expiryBlock(expiration: number): Promise<TronBlockHeader | null> {
    const head = await passedExpiry(expiration);
    if (!head) return null;
    // Blocks are at least one slot apart, so this height is at or below the first block at
    // or past the expiration; walk up to it.
    const back = BigInt(Math.floor((head.timestamp - expiration) / SLOT_MS));
    let top = await solidHeader(head.number > back ? head.number - back : 0n);
    while (top.timestamp < expiration) top = await solidHeader(top.number + 1n);
    return top;
  }

  /**
   * Absence proven by scan (lesson 16); throws when anything cannot be decided. `top` is an
   * attested solidified block at or past the expiration, so no block above it can hold the
   * transaction; nor can a block at or below `reference`, or more than `TAPOS_WINDOW` above.
   */
  async function absentAbove(
    id: string,
    reference: bigint,
    top: TronBlockHeader,
  ): Promise<void> {
    // The expiration passed before any block could reference: no block can hold it.
    if (top.number <= reference) return;
    const last = reference + TAPOS_WINDOW;
    // Both heights are below `top`, which every quorum endpoint has solidified.
    const [floor, start] = await Promise.all([
      solidHeader(reference),
      top.number > last ? solidHeader(last) : top,
    ]);
    let hash = start.id;
    for (let height = start.number; height > reference; height -= 1n) {
      const block = await finalBlockByHash(hash, height);
      // Missing, or not the block the parent chain leads to: an endpoint is behind or lying.
      if (!block || block.number !== height) throw undecided();
      // In a solidified block, yet the index said nothing: it lags. Decide later.
      if (block.transactions.includes(id)) throw undecided();
      hash = block.parentHash;
    }
    // The walk is bound at both ends: it must arrive at the attested reference-height block.
    if (hash !== floor.id) {
      throw contradiction('the scanned blocks do not lead to the reference block');
    }
  }

  return {
    async finalizedHead() {
      // The unanchored exception: one endpoint's view, trailed by the peer skew, attested.
      const seen = (await api.block('solid', undefined, MONITOR)) as TronBlockHeader;
      const head = await solidHeader(
        seen.number > PEER_SKEW ? seen.number - PEER_SKEW : 0n,
      );
      return { height: head.number, hash: head.id, timestamp: head.timestamp };
    },

    async includedFinal(ref, ordering) {
      // Lesson 20: bounded before any work; our own Attempt's ref is always a txID.
      if (typeof ref.id !== 'string' || ref.id.length !== 64) throw undecided();
      const id = ref.id.toLowerCase();
      if (!TX_ID.test(id)) throw undecided();
      const info = await api.transactionInfo('solid', id, PROOF);
      if (info) {
        const [header, tx] = await Promise.all([
          api.block('solid', info.blockNumber, PROOF),
          api.transaction('solid', id, PROOF),
        ]);
        if (!header || !tx) throw undecided();
        // java-tron writes the block's time into each receipt (`blockTimeStamp`): a receipt
        // dated otherwise is not from the solidified block at its height.
        if (info.blockTimestamp !== header.timestamp) {
          throw contradiction('a receipt does not match its solidified block');
        }
        // `verdictOf` pairs the receipt with the transaction by id (lessons 6, 7 and 18).
        const verdict = verdictOf(ctx.codec, tx, info);
        return {
          included: true,
          success: verdict.success,
          blockHeight: info.blockNumber,
          blockHash: header.id,
          txHash: id,
          ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
        };
      }
      const bounds = attemptBounds(ordering);
      if (!bounds) throw undecided();
      const top = await expiryBlock(bounds.expiration);
      if (!top) throw undecided();
      await absentAbove(id, bounds.reference, top);
      return { included: false };
    },

    async slotConsumed() {
      // Tron has no nonce or sequence: expiry is the only way an Attempt dies.
      return false;
    },

    async expired(ordering: OrderingData) {
      if (ordering.kind !== 'expiry' || !Number.isSafeInteger(ordering.expiresAtMs)) {
        return false;
      }
      return (await expiryBlock(ordering.expiresAtMs as number)) !== null;
    },

    async blockHash(height, level) {
      if (height < 0n || height > INT64_MAX) return null;
      const header = await api.block(
        level === 'finalized' ? 'solid' : 'full',
        height,
        PROOF,
      );
      return header?.id ?? null;
    },
  };
}

export function createTronBlocks(ctx: TronContext): BlockSource {
  return {
    async header(height) {
      const header = await ctx.api.block('full', height, MONITOR);
      return header
        ? {
            height: header.number,
            hash: header.id,
            parentHash: header.parentId,
            timestamp: header.timestamp,
          }
        : null;
    },
    async transactions(block, filter) {
      // F4-R7: genesis holds only the chain's initial allocations, which are not reported,
      // and java-tron answers `{}` for its receipts, which a scanner would retry for ever.
      if (block.height === 0n) return [];
      const read = await ctx.api.blockWithTransactions(block.height, MONITOR);
      if (!read || read.header.id !== block.hash) {
        throw new ProviderError(
          'PROVIDER_INCONSISTENT',
          `block ${block.height} changed while scanning`,
          { retryable: true },
        );
      }
      // Receipts pair with transactions by id, never by position.
      const infos = new Map(read.infos.map((info) => [info.id, info]));
      const txs = read.transactions.map((tx) => {
        const info = infos.get(tx.id);
        if (!info) {
          throw new ProviderError(
            'PROVIDER_UNAVAILABLE',
            'a scanned block lacks a receipt',
          );
        }
        return decodeTransaction(ctx.codec, tx, info, block.hash);
      });
      if (!filter?.addresses?.length) return txs;
      const wanted = new Set(filter.addresses.map((a) => toBase58Address(a)));
      return txs.filter(
        (tx) =>
          wanted.has(String(tx.details.owner)) ||
          tx.transfers.some((t) => wanted.has(t.to) || t.from.some((f) => wanted.has(f))),
      );
    },
  };
}

const CURSOR = /^([tx]):(.*)$/;
/** The largest page TronGrid serves. */
const MAX_PAGE = 200;

/**
 * TronGrid history (spec §15): the account's own transactions (`/transactions`), then the
 * TRC-20 transfers it only received (`/transactions/trc20`), each re-read from the full node
 * and decoded like any transaction. Confirmed (solidified) entries only (`historyPage`).
 * Paging follows the raw page's fingerprint, never how many items survive the filter, and
 * an entry the node cannot serve yet decides nothing: dropping it would skip it for good.
 */
export function createTronHistory(
  ctx: TronContext,
  indexer: Transport,
  getTransaction: (id: string) => Promise<DriverTransaction | null>,
): AddressHistorySource {
  return {
    async list(address, options) {
      const match = CURSOR.exec(options.cursor ?? 't:');
      if (!match) throw new ConfigError('CONFIG_INVALID', 'not a Tron history cursor');
      const phase = match[1] as 't' | 'x';
      const fingerprint = match[2] as string;
      const owner = toBase58Address(address);
      const page = await historyPage(
        indexer,
        owner,
        phase === 't' ? 'transactions' : 'trc20',
        {
          limit: Math.min(Math.max(Math.trunc(options.limit) || 1, 1), MAX_PAGE),
          ...(fingerprint ? { fingerprint } : {}),
        },
        READ,
      );
      const items: DriverTransaction[] = [];
      for (const id of page.ids) {
        const tx = await getTransaction(id);
        // The index lists it as confirmed: a node that serves nothing is behind.
        if (!tx) throw notServable();
        // Phase x skips the account's own calls: phase t listed them.
        if (!(phase === 'x' && tx.details.owner === owner)) items.push(tx);
      }
      const next = page.next ? `${phase}:${page.next}` : phase === 't' ? 'x:' : undefined;
      return { items, ...(next !== undefined ? { next } : {}) };
    },
  };
}
