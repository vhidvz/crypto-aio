/**
 * Proofs and block scanning (spec §6.7, §10), in lesson 17's final form: each fact is
 * attested at its own height with a monotone predicate, never at a height one endpoint
 * proposes. "My finalized height is past H" is a quorum read of
 * `getBlockHeight({ commitment: 'finalized' })` keyed on `height > H`; the block at a height
 * is a quorum read of `getBlock(slot, { commitment: 'finalized' })` keyed on its consensus
 * fields, so an endpoint that has not finalized it answers nothing and decides nothing.
 *
 * The expiry height itself is never taken on trust (F5-R9, F5-R10): the build read it from
 * one endpoint. A verdict rests on the height the quorum attests for the transaction's
 * blockhash: when the finalized block at the slot the build recorded carries it, that
 * block's height plus `BLOCKHASH_VALIDITY` is the last valid height, whatever was recorded;
 * otherwise the finalized block at the recorded height minus `BLOCKHASH_VALIDITY` must carry
 * it, which confirms the recorded height without the slot (M1). Neither decides nothing.
 *
 * A transaction is proven absent (lesson 16) only by reading every block of its window
 * under finality: each block certifies its own height and its parent's hash, from the
 * blockhash's own block to the window's last, so a lagging, pruned, snapshot-jumped or
 * long-term-storage-gapped backend behind a load-balanced URL can only answer "not
 * available" (decides nothing), never a short window (C1).
 *
 * Lesson 18, widened: only a definitive negative proof answers "no". Every other RPC error
 * on these paths decides nothing (`undecided`: a retryable `PROVIDER_UNAVAILABLE`).
 *
 * Tags: every read a verdict rests on carries the contract table's proof tags (`ChainDriver`
 * in the core's `driver/types.ts`: purpose `proof`, quorum `'proof'`), with two deliberate
 * exceptions, both single-endpoint `monitor` reads of hints the quorum then re-attests: the
 * finalized height behind `finalizedHead` (the one unanchored head, lesson 17), and the
 * height-to-slot lookups of `HeightIndex` (`attestedBlock`). A wrong hint names a block the
 * quorum does not attest at that height, so it only ever decides nothing.
 */
import type { BlockSource, DriverBlock, ProofSource } from '../../core/driver/types';
import { ProviderError } from '../../core/errors/error';
import type { OrderingData } from '../../core/model/ordering';
import {
  decodeTransaction,
  isVote,
  parseTransaction,
  tokenTransfersLanded,
  touches,
} from './decode';
import { decodeBase58, isSignature } from './keys';
import { blockAtHeight, type SolanaContext } from './reader';
import {
  BLOCK_FIELDS,
  MONITOR,
  PROOF,
  blockHeader,
  call,
  headerOptions,
  gone,
  inconsistent,
  isGone,
  isNotAvailable,
  isSkipped,
  malformed,
  notYet,
  parsedOptions,
  pick,
  u64,
  undecided,
  type BlockHeader,
} from './rpc';
import type { Commitment, SolanaExpiryOrdering } from './types';

/**
 * A blockhash is valid for this many blocks after its own: agave's `MAX_PROCESSING_AGE`
 * (v4.3.0: `runtime/src/bank.rs` sets every bank's `max_processing_age` to it, and
 * `get_blockhash_last_valid_block_height` answers `block_height + max_processing_age −
 * age`, so the newest blockhash's last valid height is its block's height plus 150).
 */
export const BLOCKHASH_VALIDITY = 150n;

/**
 * The heights that can hold a transaction whose blockhash gives `lastValidBlockHeight`:
 * from the block after the blockhash's own, through `lastValidBlockHeight + 1`. agave checks
 * a blockhash's age against the including block's PARENT, so the block after
 * `lastValidBlockHeight` still accepts it (I1).
 */
export function windowOf(lastValidHeight: bigint): {
  readonly first: bigint;
  readonly end: bigint;
} {
  const first =
    lastValidHeight >= BLOCKHASH_VALIDITY - 1n
      ? lastValidHeight - BLOCKHASH_VALIDITY + 1n
      : 0n;
  return { first, end: lastValidHeight + 1n };
}

/** Signatures proven absent from their finalized windows, kept per driver (spec §7). */
const ABSENT_MEMO = 1_024;
/** Attested last valid heights by blockhash (immutable chain data), kept per driver. */
const ANCHOR_MEMO = 1_024;

/** Library policy: an unanchored head trails one endpoint's view by this peer skew. */
export const PEER_SKEW = 2n;

/** Drops a bounded memo's oldest entry once it holds more than `size`. */
function trim(memo: Set<string> | Map<string, unknown>, size: number): void {
  if (memo.size > size) memo.delete(memo.keys().next().value as string);
}

async function finalizedHeight(ctx: SolanaContext): Promise<bigint> {
  return u64(
    await call(ctx.transport, 'getBlockHeight', [{ commitment: 'finalized' }], MONITOR),
    'getBlockHeight',
  );
}

/**
 * Whether every quorum endpoint has finalized a block above `height`: the monotone
 * predicate "my finalized height > height" (lesson 17). Endpoints that disagree throw a
 * retryable `PROVIDER_INCONSISTENT` (decides nothing); all saying no is `false`.
 */
async function finalizedPast(ctx: SolanaContext, height: bigint): Promise<boolean> {
  const past = (result: unknown): boolean => {
    if (typeof result === 'bigint') return result > height;
    if (typeof result === 'number' && Number.isSafeInteger(result))
      return BigInt(result) > height;
    throw malformed('getBlockHeight');
  };
  const result = await call(
    ctx.transport,
    'getBlockHeight',
    [{ commitment: 'finalized' }],
    { ...PROOF, quorumKey: past },
  );
  return past(result);
}

/** What a build recorded with the height: one endpoint's word until attested. */
interface Recorded {
  readonly lastValidHeight: bigint;
  readonly blockhash: string;
  /** Absent when not recorded, or not a slot a request can name exactly. */
  readonly slot?: bigint;
}

/** Our own expiry ordering's recorded height, or `undefined` for any other ordering. */
const lastValidOf = (ordering: OrderingData): bigint | undefined =>
  ordering.kind === 'expiry' ? ordering.lastValidHeight : undefined;

/** The blockhash an expiry ordering names, if any (the key of the attested heights). */
const blockhashOf = (ordering: OrderingData): string | undefined => {
  const { blockhash } = ordering as Partial<SolanaExpiryOrdering>;
  return typeof blockhash === 'string' ? blockhash : undefined;
};

/**
 * The blockhash and slot a build recorded with the height (`SolanaExpiryOrdering`). An
 * ordering without a blockhash can never be attested: it decides nothing. A missing or
 * ill-typed slot only leaves the slot-free check (M1).
 */
function recordedOf(ordering: OrderingData, lastValidHeight: bigint): Recorded {
  const { blockhash, blockhashSlot: slot } = ordering as Partial<SolanaExpiryOrdering>;
  if (decodeBase58(blockhash, 32) === null) {
    throw new ProviderError(
      'PROVIDER_UNAVAILABLE',
      'the expiry ordering does not name the blockhash its height belongs to',
    );
  }
  const exact =
    typeof slot === 'bigint' && slot >= 0n && slot <= BigInt(Number.MAX_SAFE_INTEGER);
  return { lastValidHeight, blockhash: blockhash as string, ...(exact ? { slot } : {}) };
}

const BLOCKHASH_BLOCK = "the block of the transaction's blockhash";
const LIE =
  'the recorded expiry height disagrees with its blockhash; using the attested one';

/**
 * F5-R10: the height of the finalized block at `slot` when it carries `blockhash`, or
 * `null` when the slot does not anchor it (another block there, a skipped or pruned slot,
 * no finalized block yet). The quorum key is the block's height and whether its hash
 * matches, so the height adopted is every endpoint's, never the first answer's. Only a
 * hash match yields a height; a disagreement or any other error decides nothing.
 */
async function heightAtSlot(
  ctx: SolanaContext,
  blockhash: string,
  slot: bigint,
): Promise<bigint | null> {
  const key = (result: unknown) => {
    if (result === null) return null;
    const header = blockHeader(result);
    return {
      height: header.blockHeight.toString(),
      matches: header.blockhash === blockhash,
    };
  };
  let result: unknown;
  try {
    result = await call(
      ctx.transport,
      'getBlock',
      [Number(slot), headerOptions('finalized')],
      { ...PROOF, quorumKey: key },
    );
  } catch (error) {
    if (isNotAvailable(error)) return null;
    throw undecided(error, BLOCKHASH_BLOCK);
  }
  if (result === null) return null;
  const header = blockHeader(result);
  return header.blockhash === blockhash ? header.blockHeight : null;
}

/**
 * The last valid height the quorum attests for a recorded expiry. agave answers
 * `getLatestBlockhash` from one bank (its slot, its last blockhash, and that blockhash's
 * last valid height: `block_height + MAX_PROCESSING_AGE`), so an honest record anchors at
 * its slot. When it does, the attested block's height plus `BLOCKHASH_VALIDITY` is the
 * answer, and a recorded height that disagrees is a build-time lie: logged (fixed text) and
 * ignored. When the slot does not anchor the blockhash, the block at the recorded height
 * minus `BLOCKHASH_VALIDITY` must carry it (M1), which confirms the recorded height. Only a
 * lie in both the slot and the height is never attested: it decides nothing, for good.
 */
async function attestLastValid(ctx: SolanaContext, recorded: Recorded): Promise<bigint> {
  const at =
    recorded.slot === undefined
      ? null
      : await heightAtSlot(ctx, recorded.blockhash, recorded.slot);
  if (at !== null) {
    const last = at + BLOCKHASH_VALIDITY;
    if (last !== recorded.lastValidHeight) ctx.log.warn(LIE);
    return last;
  }
  const height = recorded.lastValidHeight - BLOCKHASH_VALIDITY;
  const block = height < 0n ? null : await attestedBlock(ctx, height, 'finalized');
  if (!block) throw notYet(BLOCKHASH_BLOCK);
  if (block.header.blockhash !== recorded.blockhash) {
    throw inconsistent(
      'neither the recorded slot nor the recorded height holds the blockhash',
    );
  }
  return recorded.lastValidHeight;
}

/**
 * The block at `height` as the quorum serves it at `commitment`, or `null` when an endpoint
 * cannot show it there yet. The slot of a height comes from one endpoint's block list; the
 * quorum then attests the block itself and its height, so a wrong slot only ever decides
 * nothing. Callers use it only for heights the quorum already holds as final (deep window
 * starts, heights at or below an attested finalized height) or for `'latest'` checks where
 * `null` decides nothing.
 */
async function attestedBlock(
  ctx: SolanaContext,
  height: bigint,
  commitment: Commitment,
): Promise<{ readonly slot: bigint; readonly header: BlockHeader } | null> {
  const slot = await ctx.heights.slotAt(height, commitment, MONITOR);
  if (slot === null) return null;
  let result: unknown;
  try {
    result = await call(
      ctx.transport,
      'getBlock',
      [Number(slot), headerOptions(commitment)],
      PROOF,
    );
  } catch (error) {
    if (isSkipped(error)) {
      // The slot came from a list that named a slot with no block.
      ctx.heights.forget();
      throw inconsistent(`slot ${slot} holds no block`);
    }
    if (isNotAvailable(error)) return null;
    throw undecided(error, `the block at height ${height}`);
  }
  if (result === null) return null;
  const header = blockHeader(result);
  if (header.blockHeight !== height) {
    ctx.heights.forget();
    throw inconsistent(`the block at slot ${slot} is not at height ${height}`);
  }
  return { slot, header };
}

/** The window a verdict reads: an attested last valid height, and its blockhash. */
interface Anchor {
  readonly lastValidHeight: bigint;
  readonly blockhash: string;
}

/**
 * Whether `signature` is in none of the finalized blocks of its window (C1, lesson 16).
 * The window's first and last blocks are attested by height; `getBlocks` must list exactly
 * one slot per height between them; every block is read whole (its signatures) under the
 * proof quorum and must sit at the next height with the previous block as its parent, the
 * first one on the attested blockhash's own block. A gap, a pruned block or a lagging
 * backend answers "not available" and decides nothing. `false` means a block holds the
 * transaction.
 */
async function absentFromWindow(
  ctx: SolanaContext,
  signature: string,
  anchor: Anchor,
): Promise<boolean> {
  const { first, end } = windowOf(anchor.lastValidHeight);
  const top = await attestedBlock(ctx, end, 'finalized');
  const bottom = await attestedBlock(ctx, first, 'finalized');
  if (!top || !bottom) throw notYet('the transaction window');
  const listKey = (result: unknown): unknown => {
    if (!Array.isArray(result)) throw malformed('getBlocks');
    return result.map(String);
  };
  let listed: unknown;
  try {
    listed = await call(
      ctx.transport,
      'getBlocks',
      [
        Number(bottom.slot),
        Number(top.slot),
        { commitment: 'finalized', minContextSlot: Number(top.slot) },
      ],
      { ...PROOF, quorumKey: listKey },
    );
  } catch (error) {
    if (isNotAvailable(error)) throw notYet('every block of the window');
    throw undecided(error, 'every block of the window');
  }
  if (!Array.isArray(listed) || BigInt(listed.length) !== end - first + 1n) {
    throw notYet('every block of the window');
  }
  const holds = (result: unknown): boolean | null => {
    const list = (result as { signatures?: unknown } | null)?.signatures;
    return Array.isArray(list) ? list.includes(signature) : null;
  };
  const blockKey = (result: unknown): unknown => ({
    ...(pick(result, BLOCK_FIELDS) as object),
    holds: holds(result),
  });
  // The window hangs off the blockhash's own block, which the anchor attested.
  let parent = anchor.blockhash;
  for (const [i, value] of listed.entries()) {
    let block: unknown;
    try {
      block = await call(
        ctx.transport,
        'getBlock',
        [
          Number(u64(value, 'getBlocks slot')),
          { ...headerOptions('finalized'), transactionDetails: 'signatures' },
        ],
        { ...PROOF, quorumKey: blockKey },
      );
    } catch (error) {
      if (isNotAvailable(error)) throw notYet('a block of the window');
      throw undecided(error, 'a block of the window');
    }
    const found = holds(block);
    if (found === null) throw notYet('a block of the window');
    const header = blockHeader(block);
    if (header.blockHeight !== first + BigInt(i) || header.previousBlockhash !== parent) {
      throw inconsistent('the window is not one chain of blocks');
    }
    if (found) return false;
    parent = header.blockhash;
  }
  if (parent !== top.header.blockhash) {
    throw inconsistent('the window does not end at its attested block');
  }
  return true;
}

/** The quorum's finalized transaction (`null`: every endpoint agrees it has none). */
async function finalTransaction(ctx: SolanaContext, signature: string): Promise<unknown> {
  try {
    return await call(
      ctx.transport,
      'getTransaction',
      [signature, parsedOptions('finalized')],
      PROOF,
    );
  } catch (error) {
    if (isNotAvailable(error)) throw notYet('the transaction history');
    throw undecided(error, 'the transaction history');
  }
}

/** Lesson 18, widened: whatever a proof method meets, no RPC error is ever a verdict. */
function guarded<A extends unknown[], R>(
  method: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await method(...args);
    } catch (error) {
      throw undecided(error, 'the proof');
    }
  };
}

export function createSolanaProofs(ctx: SolanaContext): ProofSource {
  const absent = new Set<string>();
  /** Attested last valid heights by blockhash: a blockhash names one block, for good. */
  const anchors = new Map<string, bigint>();
  const known = (ordering: OrderingData): bigint | undefined => {
    const blockhash = blockhashOf(ordering);
    return blockhash === undefined ? undefined : anchors.get(blockhash);
  };
  /** The attested last valid height of `ordering` (F5-R10), remembered once attested. */
  const attested = async (ordering: OrderingData, recorded: bigint): Promise<Anchor> => {
    const record = recordedOf(ordering, recorded);
    let last = anchors.get(record.blockhash);
    if (last === undefined) {
      last = await attestLastValid(ctx, record);
      anchors.set(record.blockhash, last);
      trim(anchors, ANCHOR_MEMO);
    }
    return { lastValidHeight: last, blockhash: record.blockhash };
  };
  /**
   * A finalized `getTransaction` answer, read under that method's quorum key, is the only
   * verdict input (never a block's entry): the transaction asked for, in the finalized
   * block at its slot, with the landing guard applied (lesson 7).
   */
  const included = async (result: unknown, signature: string, from: string) => {
    const parsed = parseTransaction(result, signature);
    if (parsed.slot === undefined) throw malformed('getTransaction');
    let header: BlockHeader | null;
    try {
      const block = await call(
        ctx.transport,
        'getBlock',
        [Number(parsed.slot), headerOptions('finalized')],
        PROOF,
      );
      header = block === null ? null : blockHeader(block);
    } catch (error) {
      if (!isNotAvailable(error)) throw undecided(error, 'the block of the transaction');
      header = null;
    }
    if (!header) throw notYet('the block of the transaction');
    // Lesson 7: our own token transfers count only when the balances show them. The reasons
    // are `observe`'s fixed texts (R24), so the proven failure keeps the observed one.
    const reason =
      parsed.err !== null
        ? 'transaction failed'
        : tokenTransfersLanded(parsed, from)
          ? undefined
          : 'token transfer failed';
    return {
      included: true as const,
      success: reason === undefined,
      blockHeight: header.blockHeight,
      blockHash: header.blockhash,
      txHash: signature,
      ...(reason !== undefined ? { reason } : {}),
    };
  };

  const proofs: ProofSource = {
    async finalizedHead() {
      // The one unanchored head (lesson 17): one endpoint's view, trailed by a peer skew.
      const seen = await finalizedHeight(ctx);
      const height = seen > PEER_SKEW ? seen - PEER_SKEW : 0n;
      const block = await attestedBlock(ctx, height, 'finalized');
      if (!block) throw notYet('the finalized head');
      return {
        height,
        hash: block.header.blockhash,
        ...(block.header.blockTime !== undefined
          ? { timestamp: block.header.blockTime }
          : {}),
      };
    },

    async includedFinal(ref, ordering, from) {
      // A malformed signature can never be on chain.
      if (!isSignature(ref.id)) return { included: false };
      const found = await finalTransaction(ctx, ref.id);
      if (found !== null) return included(found, ref.id, from);
      // Lesson 16: an index that shows nothing proves nothing; only the window can.
      const recorded = lastValidOf(ordering);
      if (recorded === undefined) throw notYet('proof that the transaction is absent');
      const remembered = known(ordering);
      if (remembered !== undefined && absent.has(`${ref.id}:${remembered}`)) {
        return { included: false };
      }
      // The window's last block (lastValidBlockHeight + 1, I1) is final everywhere, at the
      // attested height (F5-R10). An early "no" at the recorded one only delays.
      const pastWindow = () => notYet('finality past the transaction window');
      if (remembered === undefined && !(await finalizedPast(ctx, recorded))) {
        throw pastWindow();
      }
      const anchor = await attested(ordering, recorded);
      const last = anchor.lastValidHeight;
      if (last !== recorded || remembered !== undefined) {
        if (!(await finalizedPast(ctx, last))) throw pastWindow();
      }
      const key = `${ref.id}:${last}`;
      if (!absent.has(key)) {
        if (!(await absentFromWindow(ctx, ref.id, anchor))) {
          throw inconsistent(
            'a block of the window holds a transaction its index does not show',
          );
        }
        absent.add(key);
        trim(absent, ABSENT_MEMO);
      }
      return { included: false };
    },

    // Expiry ordering has no slot that another transaction could consume.
    slotConsumed: async () => false,

    async expired(ordering) {
      const recorded = lastValidOf(ordering);
      // "Not expired" is the safe answer: it never declares a transaction dead.
      if (recorded === undefined) return false;
      const remembered = known(ordering);
      if (remembered !== undefined) return finalizedPast(ctx, remembered);
      // An early "no" at the recorded height only delays.
      if (!(await finalizedPast(ctx, recorded))) return false;
      // F5-R10: "expired" rests on the attested height, and its own predicate read.
      const { lastValidHeight } = await attested(ordering, recorded);
      return lastValidHeight === recorded || finalizedPast(ctx, lastValidHeight);
    },

    async blockHash(height, level) {
      // R33: null above the finalized height decides nothing; so does any endpoint that has
      // not finalized `height` yet (the attested read answers nothing there).
      if (level === 'finalized' && !(await finalizedPast(ctx, height - 1n))) return null;
      const block = await attestedBlock(
        ctx,
        height,
        level === 'finalized' ? 'finalized' : 'confirmed',
      );
      return block?.header.blockhash ?? null;
    },
  };
  return {
    finalizedHead: guarded(proofs.finalizedHead),
    includedFinal: guarded(proofs.includedFinal),
    slotConsumed: guarded(proofs.slotConsumed),
    expired: guarded(proofs.expired),
    blockHash: guarded(proofs.blockHash),
  };
}

const changed = (height: bigint) =>
  inconsistent(`block ${height} changed while scanning`);

export function createSolanaBlocks(ctx: SolanaContext): BlockSource {
  return {
    header: async (height) => (await blockAtHeight(ctx, height, MONITOR))?.block ?? null,

    async transactions(block: DriverBlock, filter) {
      const slot = await ctx.heights.slotAt(block.height, 'confirmed', MONITOR);
      if (slot === null) throw changed(block.height);
      let result: unknown;
      try {
        result = await call(
          ctx.transport,
          'getBlock',
          [
            Number(slot),
            { ...parsedOptions('confirmed'), transactionDetails: 'full', rewards: false },
          ],
          MONITOR,
        );
      } catch (error) {
        if (isGone(error)) throw gone(`the block at height ${block.height}`);
        // A slot the index named holds no block: drop the cache it came from.
        if (isSkipped(error)) ctx.heights.forget();
        if (isNotAvailable(error)) throw changed(block.height);
        // Lesson 18, widened: any other node error decides nothing; the scan retries.
        throw undecided(error, `the block at height ${block.height}`);
      }
      const full = result as { blockhash?: unknown; transactions?: unknown } | null;
      if (!full || full.blockhash !== block.hash) throw changed(block.height);
      if (!Array.isArray(full.transactions)) throw malformed('getBlock');
      const wanted = filter?.addresses?.length ? new Set(filter.addresses) : undefined;
      const place = {
        height: block.height,
        hash: block.hash,
        ...(block.timestamp !== undefined ? { blockTime: block.timestamp } : {}),
      };
      // All or nothing: a transaction that does not parse makes the whole block retry
      // (retryable), never a block read short.
      return full.transactions.flatMap((entry) => {
        const parsed = parseTransaction(entry);
        if (isVote(parsed)) return [];
        const decoded = decodeTransaction(parsed, place);
        return !wanted || touches(decoded, parsed, wanted) ? [decoded] : [];
      });
    },
  };
}
