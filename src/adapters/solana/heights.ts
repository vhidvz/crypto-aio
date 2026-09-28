/**
 * Dense block heights over Solana's slots (handoff §3: "use block height, not slot, on
 * Solana"). Slots can be skipped; block heights count only produced blocks, so every height
 * up to the head has exactly one block. The index maps a height to its slot with
 * `getBlocks`, which lists the produced slots of a range: anchored on a known block at
 * the head, the block `k` places before it in that list is `k` heights lower.
 *
 * A list can have gaps (a ledger jump to a snapshot, a long-term-storage gap, pruning), so
 * no pair is believed until a read of the list's first block confirms its height (I3). Only
 * finalized, verified pairs are cached (immutable chain data, spec §7), which makes a
 * forward scan cost one `getBlock` per height. A height the endpoint no longer holds is a
 * retryable error that decides nothing, never `null` (`null` means "not visible yet").
 * Every read is a single endpoint's view (lesson 17): verdicts quorum-read the block at the
 * resolved slot. Any other RPC error decides nothing either (lesson 18, widened): proofs
 * reach this index, and agave answers `getBlocks` below its local ledger with `-32602
 * "BigTable query failed"` when long-term storage fails. Such a page starts again at the
 * endpoint's first available block (liveness), so a height inside its ledger still
 * resolves.
 */
import { isCryptoAioError } from '../../core/errors/error';
import type { Transport } from '../../core/transport/types';
import {
  blockHeader,
  call,
  gone,
  headerOptions,
  inconsistent,
  isGone,
  isNotYet,
  isSkipped,
  malformed,
  notYet,
  u64,
  undecided,
  type BlockHeader,
} from './rpc';
import type { Commitment, SolanaCallTags } from './types';

/** `getBlocks` accepts at most this many slots per call (agave). */
const MAX_RANGE = 500_000n;
/** At most this many `getBlocks` pages below the head (about 8 M slots). */
const MAX_PAGES = 16;
/** Verified finalized height → slot pairs kept per driver. */
const CACHE_SIZE = 8_192;

export interface HeadBlock {
  readonly slot: bigint;
  readonly header: BlockHeader;
}

export class HeightIndex {
  readonly #transport: Transport;
  readonly #final = new Map<bigint, bigint>();

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** The block at the endpoint's `commitment` head (one `getSlot`, one `getBlock`). */
  async head(commitment: Commitment, tags: SolanaCallTags): Promise<HeadBlock> {
    const slot = u64(
      await call(this.#transport, 'getSlot', [{ commitment }], tags),
      'getSlot',
    );
    const header = await this.header(slot, commitment, tags);
    if (!header) throw notYet(`the ${commitment} head block`);
    return { slot, header };
  }

  /**
   * The block at `slot`, or `null` while the endpoint has not reached it at `commitment`.
   * A pruned or missing block is a retryable error (decides nothing); a slot the endpoint
   * calls skipped means a list named a slot with no block, so the cache is dropped.
   */
  async header(
    slot: bigint,
    commitment: Commitment,
    tags: SolanaCallTags,
  ): Promise<BlockHeader | null> {
    let result: unknown;
    try {
      result = await call(
        this.#transport,
        'getBlock',
        [Number(slot), headerOptions(commitment)],
        tags,
      );
    } catch (error) {
      if (isNotYet(error)) return null;
      if (isGone(error)) throw gone(`the block at slot ${slot}`);
      if (isSkipped(error)) {
        this.forget();
        throw inconsistent(`slot ${slot} holds no block`);
      }
      throw undecided(error, `the block at slot ${slot}`);
    }
    return result === null ? null : blockHeader(result);
  }

  /**
   * The slot of the block at `height` on the endpoint's chain at `commitment`, or `null`
   * while that chain has no block at `height` yet. A `confirmed` lookup at or below the
   * endpoint's finalized height resolves on the finalized chain, which fills the cache.
   */
  async slotAt(
    height: bigint,
    commitment: Commitment,
    tags: SolanaCallTags,
  ): Promise<bigint | null> {
    if (height < 0n) return null;
    const cached = this.#final.get(height);
    if (cached !== undefined) return cached;
    const final = await this.head('finalized', tags);
    if (height <= final.header.blockHeight) {
      return this.#resolve(height, final, 'finalized', tags);
    }
    if (commitment === 'finalized') return null;
    const top = await this.head('confirmed', tags);
    if (height > top.header.blockHeight) return null;
    return this.#resolve(height, top, 'confirmed', tags);
  }

  /** Counts back from `top` through verified `getBlocks` pages to the block at `height`. */
  async #resolve(
    height: bigint,
    top: HeadBlock,
    commitment: Commitment,
    tags: SolanaCallTags,
  ): Promise<bigint> {
    let anchorSlot = top.slot;
    let anchorHeight = top.header.blockHeight;
    if (height === anchorHeight) return anchorSlot;
    let span = anchorHeight - height + (anchorHeight - height) / 4n + 64n;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (span > MAX_RANGE) span = MAX_RANGE;
      const want = anchorSlot > span ? anchorSlot - span : 0n;
      const { from, slots } = await this.#page(want, anchorSlot, commitment, tags);
      const last = slots.length - 1;
      // agave lists nothing when the range ends above what the endpoint holds at
      // `commitment` (a backend whose root trails the anchor): that list ends nowhere.
      if (last < 0 || slots[last] !== anchorSlot) {
        throw inconsistent(`getBlocks does not end at slot ${anchorSlot}`);
      }
      // A list that adds nothing below its anchor: the endpoint holds nothing older.
      if (last === 0) throw gone(`the block at height ${height}`);
      // I3: the list's first block must sit exactly `last` heights below the anchor, or
      // the list has a gap; nothing from it is believed or cached.
      const firstHeight = anchorHeight - BigInt(last);
      const first = await this.header(slots[0] as bigint, commitment, tags);
      if (!first) throw notYet(`the block at slot ${slots[0]}`);
      if (first.blockHeight !== firstHeight) {
        throw inconsistent(`the blocks listed below slot ${anchorSlot} have a gap`);
      }
      slots.forEach((slot, i) => {
        const at = firstHeight + BigInt(i);
        // Keep the pairs a forward scan from `height` needs next.
        if (at >= height && at < height + BigInt(CACHE_SIZE)) {
          this.#remember(commitment, at, slot);
        }
      });
      if (height >= firstHeight) return slots[Number(height - firstHeight)] as bigint;
      // The list started at slot 0, or at the endpoint's first available block.
      if (from === 0n || from > want) throw gone(`the block at height ${height}`);
      anchorHeight = firstHeight;
      anchorSlot = slots[0] as bigint;
      span *= 2n;
    }
    throw gone(`the block at height ${height} (too far below the head)`);
  }

  /**
   * One verified-shape page of produced slots from `from` to `to`, and where it starts.
   * When the endpoint cannot list from `from` (a definitive RPC error: agave answers
   * `-32602 "BigTable query failed"` below its local ledger when long-term storage fails),
   * the page starts once more at the endpoint's first available block, when that lies
   * inside the range (X-note, liveness only). Every other error, and a second failure,
   * decides nothing (lesson 18, widened).
   */
  async #page(
    from: bigint,
    to: bigint,
    commitment: Commitment,
    tags: SolanaCallTags,
  ): Promise<{ readonly from: bigint; readonly slots: bigint[] }> {
    try {
      return { from, slots: await this.#blocks(from, to, commitment, tags) };
    } catch (error) {
      if (!isCryptoAioError(error, 'RPC_ERROR')) throw error;
      const first = await this.#firstAvailable(tags);
      if (first === null || first <= from || first > to) {
        throw undecided(error, `the blocks from slot ${from}`);
      }
      try {
        return { from: first, slots: await this.#blocks(first, to, commitment, tags) };
      } catch (retry) {
        throw undecided(retry, `the blocks from slot ${first}`);
      }
    }
  }

  /** The endpoint's first available block: a hint only, `null` when it cannot say. */
  async #firstAvailable(tags: SolanaCallTags): Promise<bigint | null> {
    try {
      return u64(
        await call(this.#transport, 'getFirstAvailableBlock', [], tags),
        'getFirstAvailableBlock',
      );
    } catch (error) {
      if (tags.signal?.aborted) throw error;
      return null;
    }
  }

  /** `getBlocks` from `from` to `to`: strictly increasing slots inside the range. */
  async #blocks(
    from: bigint,
    to: bigint,
    commitment: Commitment,
    tags: SolanaCallTags,
  ): Promise<bigint[]> {
    const result = await call(
      this.#transport,
      'getBlocks',
      [Number(from), Number(to), { commitment }],
      tags,
    );
    if (!Array.isArray(result)) throw malformed('getBlocks');
    const slots = result.map((slot) => u64(slot, 'getBlocks slot'));
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i] as bigint;
      if (slot < from || slot > to || (i > 0 && slot <= (slots[i - 1] as bigint))) {
        throw malformed('getBlocks');
      }
    }
    return slots;
  }

  /** Drops every cached pair: a later read contradicted one (cheap to rebuild). */
  forget(): void {
    this.#final.clear();
  }

  #remember(commitment: Commitment, height: bigint, slot: bigint): void {
    if (commitment !== 'finalized' || this.#final.has(height)) return;
    this.#final.set(height, slot);
    if (this.#final.size > CACHE_SIZE) {
      const oldest = this.#final.keys().next().value as bigint;
      this.#final.delete(oldest);
    }
  }
}
