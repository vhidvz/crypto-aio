/**
 * Proofs, the block source and TronGrid history.
 *
 * Proofs: every read is a `proof` quorum
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
 * - expiry: a transaction is invalid in a block whose parent's timestamp is at or past
 *   its expiration, and block timestamps strictly increase, so no block after the first one
 *   at or past the expiration can hold it;
 * - TaPoS: only a block above the reference block, and at most `TAPOS_WINDOW` above it, can
 *   hold it.
 *
 * "Not included": the solidity index (and TronGrid behind a load balancer) can lag, so an
 * empty index answer is never taken as absence: an expired verdict for a transfer the
 * index missed would let `rebuild` pay twice.
 * `includedFinal` answers `included: false` only once expiry is attested and a scan of every
 * block that could hold the transaction shows it absent, from the attested first block at or
 * past the SIGNED expiration (`expiresAtMs`, which `assemble` binds to the signed bytes) down
 * to just above the reference block. The floor is never a time derived from the expiration:
 * the build-time head and the local clock are claims, so the expiration can sit any distance
 * after the reference.
 * - The ordering (`TronExpiryOrdering`) carries the reference height the build-time head
 *   claimed (`lastValidHeight − TAPOS_WINDOW`) and the signed `ref_block_hash`. Only the
 *   height's low 16 bits are signed (`ref_block_bytes`), so the height is trusted only when
 *   the attested solidified block there carries the signed hash: then the scan runs from the
 *   top down to it.
 * - Otherwise (another block there, or a height at or above the top) the proof searches the
 *   heights TaPoS can match: every block up to the top checks the reference against the latest
 *   block at or below its parent with the signed low 16 bits, and its parent is at most 24 h
 *   before the expiration (`MAXIMUM_TIME_UNTIL_EXPIRATION`). So the attested blocks at those
 *   heights, from one TaPoS window below that 24 h mark up to the top, are the only possible
 *   references. None carries the signed hash: no block can hold the transaction. One does:
 *   the blocks in its TaPoS window (and not before the 24 h mark) are scanned.
 * - Either way, a block whose parent is more than 24 h before the expiration cannot hold the
 *   transaction, so no scan goes below the first block at or past that mark.
 * - A missing or malformed stored hash decides nothing.
 * Each scanned block is read by hash under the quorum, its parent hash names the next, and the
 * walk must end on the attested block below the window. A scanned block that holds the
 * transaction while the index says nothing decides nothing.
 *
 * Read cost, each read a quorum read: the reference check is one; a scan is one per block in
 * the window (about 20 for a 60 s expiration). A reference older than a day (a build head that
 * named an old block), or the search below, adds a gallop and binary search for the block 24 h
 * before the expiration (a few reads, logarithmic in missed slots). The search, only when the
 * stored height is not the reference, adds one read per candidate height (two or three). A
 * scan never covers more than the blocks from that 24 h mark to the first block at or past the
 * expiration: at most a day of blocks (28,800 at one per 3-second slot, fewer when slots are
 * missed), and never more than one TaPoS window (65,536).
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
import type { TronExpiryOrdering } from './types';

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
/**
 * How far `finalizedHead` trails one endpoint's solidified head: up to 6 s behind, and no
 * verdict reads it.
 */
const PEER_SKEW = 2n;
/** java-tron's block heights are `long`s. */
const INT64_MAX = 2n ** 63n - 1n;
const TX_ID = /^[0-9a-f]{64}$/;
/** A signed `ref_block_hash`: 8 bytes, lower-case hex, as the builder stores it. */
const REF_HASH = /^[0-9a-f]{16}$/;
/**
 * java-tron's `MAXIMUM_TIME_UNTIL_EXPIRATION` (`Constant.java`): `validateCommon` refuses an
 * expiration more than 24 h after the parent block's time.
 */
const MAX_LIFETIME_MS = 86_400_000;

/** The timestamp of a solidified-block answer, or -1 when it is not one (never agrees). */
function solidTimestamp(answer: unknown): number {
  const raw = (answer as { block_header?: { raw_data?: { timestamp?: unknown } } } | null)
    ?.block_header?.raw_data;
  return typeof raw?.timestamp === 'number' ? raw.timestamp : -1;
}

interface Bounds {
  /** The signed expiration. */
  readonly expiration: number;
  /** The reference height the build-time head claimed: only its low 16 bits are signed. */
  readonly reference: bigint;
  /** The signed `ref_block_hash`. */
  readonly refBlockHash: string;
}

/**
 * Where an Attempt can be, from its `TronExpiryOrdering`; null when a field is missing or
 * out of range, which decides nothing.
 */
function attemptBounds(ordering: OrderingData): Bounds | null {
  if (ordering.kind !== 'expiry') return null;
  const { expiresAtMs, lastValidHeight, refBlockHash } =
    ordering as Partial<TronExpiryOrdering>;
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    typeof lastValidHeight !== 'bigint' ||
    lastValidHeight < TAPOS_WINDOW ||
    lastValidHeight > INT64_MAX ||
    typeof refBlockHash !== 'string' ||
    !REF_HASH.test(refBlockHash)
  ) {
    return null;
  }
  return {
    expiration: expiresAtMs as number,
    reference: lastValidHeight - TAPOS_WINDOW,
    refBlockHash,
  };
}

/** Bytes 8..16 of a block id: what a transaction's `ref_block_hash` names. */
const hashBytes = (block: TronBlockHeader): string => block.id.slice(16, 32);

/** Scanned blocks kept per driver: immutable chain data, so a retry is cheap. */
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
   * The first solidified block at or past `time`, at or below `hi` (an attested block at or
   * past it). Block timestamps strictly increase, so "at or past `time`" is monotone in the
   * height: a gallop down from the slot estimate, then a binary search. Every probe is
   * an attested fixed-height read at or below `hi`, which every quorum endpoint has
   * solidified, so none can stall; the slot spacing only picks the first probe.
   */
  async function firstAtOrAfter(
    time: number,
    hi: TronBlockHeader,
  ): Promise<TronBlockHeader> {
    let high = hi;
    let low: TronBlockHeader | undefined;
    let step = BigInt(Math.max(1, Math.floor((hi.timestamp - time) / SLOT_MS)));
    while (low === undefined) {
      if (high.number === 0n) return high;
      const probe = await solidHeader(high.number > step ? high.number - step : 0n);
      if (probe.timestamp < time) {
        low = probe;
      } else {
        high = probe;
        step *= 2n;
      }
    }
    while (high.number - low.number > 1n) {
      const mid = await solidHeader((low.number + high.number) / 2n);
      if (mid.timestamp < time) low = mid;
      else high = mid;
    }
    return high;
  }

  /**
   * The first solidified block at or past `expiration`, or null while the quorum has not
   * solidified past it. Only the predicate is attested: the latest block's height and time
   * are one endpoint's word, so a block trailed by the peer skew is attested at its own height
   * (a freshest endpoint then stalls nothing), and the search runs at or below it
   * or, within the skew, up to the first block at the expiration, which every endpoint has
   * solidified (bounded, whatever the endpoint claimed).
   */
  async function expiryBlock(expiration: number): Promise<TronBlockHeader | null> {
    const seen = await passedExpiry(expiration);
    if (!seen) return null;
    let top = await solidHeader(seen.number > PEER_SKEW ? seen.number - PEER_SKEW : 0n);
    if (top.timestamp >= expiration) return firstAtOrAfter(expiration, top);
    while (top.timestamp < expiration) {
      if (top.number >= seen.number) throw undecided();
      top = await solidHeader(top.number + 1n);
    }
    return top;
  }

  /**
   * No block above the attested `floor`, at or below `last` and `top`, holds `id`: walked by
   * parent hash from the upper end, which must arrive at `floor`. Throws when anything cannot
   * be decided. Every height read is below `top`, which every quorum endpoint has solidified.
   */
  async function absentAbove(
    id: string,
    floor: TronBlockHeader,
    top: TronBlockHeader,
    last: bigint,
  ): Promise<void> {
    const end = last < top.number ? last : top.number;
    if (end <= floor.number) return;
    const start = end === top.number ? top : await solidHeader(end);
    let hash = start.id;
    for (let height = start.number; height > floor.number; height -= 1n) {
      const block = await finalBlockByHash(hash, height);
      // Missing, or not the block the parent chain leads to: an endpoint is behind or lying.
      if (!block || block.number !== height) throw undecided();
      // In a solidified block, yet the index said nothing: it lags. Decide later.
      if (block.transactions.includes(id)) throw undecided();
      hash = block.parentHash;
    }
    // The walk is bound at both ends: it must arrive at the attested block below the window.
    if (hash !== floor.id) {
      throw contradiction('the scanned blocks do not lead to the reference block');
    }
  }

  /**
   * Absence proven by scan; throws when anything cannot be decided. `top`
   * is the attested first block at or past the expiration: no block above it can hold `id`.
   */
  async function absent(id: string, bounds: Bounds, top: TronBlockHeader): Promise<void> {
    const { reference, refBlockHash } = bounds;
    /** The 24 h mark: only a block whose parent is at or after it can hold `id`. */
    const dayMark = bounds.expiration - MAX_LIFETIME_MS;
    // The stored height is the build-time head's claim: it bounds the scan only when the
    // attested block there carries the signed hash bytes.
    if (reference < top.number) {
      const named = await solidHeader(reference);
      if (hashBytes(named) === refBlockHash) {
        // A reference older than a day (a build head that named an old block) is
        // scanned only from the 24 h mark, as the search below does, never its whole window.
        const floor =
          named.timestamp < dayMark ? await firstAtOrAfter(dayMark, top) : named;
        await absentAbove(id, floor, top, reference + TAPOS_WINDOW);
        return;
      }
    }
    // Otherwise, the heights TaPoS can match: the signed low 16 bits, below the top, from one
    // TaPoS window below the first block within 24 h of the expiration (a block's parent is at
    // or after it). Every block up to the top checks the reference against one of them.
    const earliest = await firstAtOrAfter(dayMark, top);
    const low16 = reference % TAPOS_WINDOW;
    const from =
      earliest.number + 1n > TAPOS_WINDOW ? earliest.number + 1n - TAPOS_WINDOW : 0n;
    let height = from + ((low16 - (from % TAPOS_WINDOW) + TAPOS_WINDOW) % TAPOS_WINDOW);
    for (; height < top.number; height += TAPOS_WINDOW) {
      const candidate = await solidHeader(height);
      if (hashBytes(candidate) !== refBlockHash) continue;
      // Its TaPoS window, less the blocks whose parent is more than 24 h before the expiration.
      const floor = candidate.number >= earliest.number ? candidate : earliest;
      await absentAbove(id, floor, top, candidate.number + TAPOS_WINDOW);
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
      // Bounded before any work; our own Attempt's ref is always a txID.
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
        // `verdictOf` pairs the receipt with the transaction by id, reads the verdict
        // fields strictly and wants evidence that value moved; a contradiction decides
        // nothing.
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
      await absent(id, bounds, top);
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
      // Genesis holds only the chain's initial allocations, which are not reported,
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
 * TronGrid history, each entry re-read from the full node and decoded like any
 * transaction; confirmed (solidified) entries only (`historyPage`). Phase `t` is
 * `/transactions`: the account's own transactions, TRX sent to it and, for a contract
 * account, other accounts' calls to it. Phase `x` is `/transactions/trc20`: every TRC-20
 * transfer from or to it (a spender's `transferFrom` out of it included), less the account's
 * own calls, which phase `t` listed. A TRC-20 transfer a wallet only received is in phase `x`
 * alone (TronGrid, read-only on Nile, 2026-09-28), but a call to a contract account that moves
 * its own tokens comes in both phases, so callers dedupe on `transfer.id`.
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
        // The index lists it as confirmed: a node that serves nothing, or only its pool
        // copy, is behind; listing that copy would move the cursor past it for good.
        if (!tx || tx.observation.seen !== 'block') throw notServable();
        // Phase x skips the account's own calls: phase t listed them.
        if (!(phase === 'x' && tx.details.owner === owner)) items.push(tx);
      }
      const next = page.next ? `${phase}:${page.next}` : phase === 't' ? 'x:' : undefined;
      return { items, ...(next !== undefined ? { next } : {}) };
    },
  };
}
