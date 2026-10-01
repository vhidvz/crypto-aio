/**
 * Proofs (the finalized-state checks behind `proven` verdicts) and the block source.
 *
 * Snowman never reverts an accepted block, so with the default policy (1 confirmation) an
 * accepted transaction is final. Every fact is read under the proof quorum (lesson 14: one
 * endpoint's word never decides), each at its own height (lesson 17): "block h is final" is
 * "every proof endpoint holds a block at h + N − 1".
 *
 * - `includedFinal` answers "included" only when the proof endpoints agree the transaction
 *   is accepted and the block at its located height is the located block and holds it. It
 *   answers "not included" only when one of its inputs is gone from the sender's outputs on
 *   every proof endpoint and, read after that, the transaction is still not accepted: then
 *   another transaction spent the input, and ours can never be accepted. Every other case
 *   decides nothing (a retryable `ProviderError`).
 * - `slotConsumed` reads the sender's outputs: an input missing from them is spent.
 * - The block source reads blocks by height; their transactions are read by id from the
 *   node, as bytes that hash to that id. A P-Chain proposal transaction counts as failed
 *   when its proposal was aborted.
 */
import type {
  BlockSource,
  DriverBlock,
  DriverTransaction,
  FinalityLevel,
  ProofSource,
} from '../../core/driver/types';
import type { OrderingData } from '../../core/model/ordering';
import type { AttemptRef } from '../../core/model/transaction';
import { normalizeAddress } from './address';
import {
  decodeChecked,
  parseBlock,
  parseHeight,
  parsePlatformStatus,
  type NodeBlock,
} from './api';
import { isId } from './cb58';
import { utxoKey, utxoKeyOf } from './codec';
import {
  MONITOR,
  PROOF,
  contradiction,
  locate,
  proofRead,
  undecided,
  type AvalancheContext,
} from './context';
import { decodeTransaction } from './decode';
import { toDriverBlock } from './reader';
import type { AvalancheCallTags } from './types';

/** Blocks `finalizedHead` trails one endpoint's head by, so peers can attest it. */
export const PEER_SKEW = 1n;
/** Transactions of one block read at once. */
const TX_READS = 4;
const MAX_HEIGHT = BigInt(Number.MAX_SAFE_INTEGER);
const outOfRange = (height: bigint): boolean => height < 0n || height > MAX_HEIGHT;

/** A block as the proof quorum compares it: the consensus facts the verdicts use. */
const blockKey = (answer: unknown): string => {
  const b = parseBlock(answer);
  return `${b.height}:${b.id}:${b.parentId}:${b.txIds.join(',')}`;
};

/** Splits an `inputs` ordering entry (`txID:outputIndex`); malformed data decides nothing. */
export function parseInput(input: string): { txId: string; outputIndex: number } {
  const match = /^([1-9A-HJ-NP-Za-km-z]{32,50}):(0|[1-9][0-9]{0,9})$/.exec(input);
  if (!match || !isId(match[1]) || Number(match[2]) > 0xffffffff) {
    throw undecided('malformed input in the ordering');
  }
  return { txId: match[1] as string, outputIndex: Number(match[2]) };
}

/** The `utxoId`s (`txID:outputIndex`) in a page of `getUTXOs`. */
function keysOfPage(answer: unknown): string[] {
  const utxos = (answer as { utxos?: unknown } | null)?.utxos;
  if (!Array.isArray(utxos)) return [];
  return utxos.map((text) => utxoKeyOf(decodeChecked(text, 'utxo')));
}

/**
 * The reads a proof attests under the proof quorum, each fact at its own height (lesson 17).
 */
export function attestedReads(ctx: AvalancheContext) {
  const { node, config } = ctx;
  const depth = BigInt(config.confirmations) - 1n;
  /** "I hold a block at `height`" (monotone in the head, so endpoints further ahead agree). */
  const holds = async (height: bigint): Promise<boolean> =>
    (await node.height({
      ...PROOF,
      quorumKey: (answer) =>
        parseHeight((answer as { height?: unknown } | null)?.height) >= height,
    })) >= height;
  /** The block at `height` on the proof endpoints' chain. */
  const blockAt = (height: bigint): Promise<NodeBlock | null> =>
    node.blockAt(height, { ...PROOF, quorumKey: blockKey });
  /** Whether the block at `height` is final (N − 1 blocks above it on every proof endpoint). */
  const final = (height: bigint): Promise<boolean> => holds(height + depth);
  return { holds, blockAt, final };
}

export function proofSource(ctx: AvalancheContext): ProofSource {
  const { node, config } = ctx;
  const depth = BigInt(config.confirmations) - 1n;
  const { holds, blockAt, final } = attestedReads(ctx);

  /** Accepted, aborted (P-Chain) or not, as the proof endpoints agree. */
  const acceptance = async (txId: string): Promise<'accepted' | 'aborted' | 'not'> => {
    if (config.vm === 'avm') {
      const tags: AvalancheCallTags = {
        ...PROOF,
        quorumKey: (answer) => (answer as { tx?: unknown } | null)?.tx,
      };
      return (await node.txBytes(txId, tags)) === null ? 'not' : 'accepted';
    }
    const status = await node.txStatus(txId, {
      ...PROOF,
      quorumKey: (answer) => {
        const s = parsePlatformStatus(answer);
        return s === 'Committed' || s === 'Aborted' ? s : 'not';
      },
    });
    return status === 'Committed' ? 'accepted' : status === 'Aborted' ? 'aborted' : 'not';
  };

  /** Which of `inputs` the proof endpoints (or, at `latest`, one) still list for `from`. */
  const unspentOf = async (
    from: string,
    inputs: readonly string[],
    level: FinalityLevel,
  ): Promise<Set<string>> => {
    const wanted = new Set(inputs);
    const tags: AvalancheCallTags =
      level === 'latest'
        ? MONITOR
        : {
            ...PROOF,
            quorumKey: (answer) =>
              keysOfPage(answer)
                .filter((key) => wanted.has(key))
                .sort()
                .join(','),
          };
    const listed = await node.utxos(normalizeAddress(from, config).canonical, tags);
    const present = new Set<string>();
    for (const bytes of listed) {
      const key = utxoKeyOf(bytes);
      if (wanted.has(key)) present.add(key);
    }
    return present;
  };

  const inputsOf = (ordering: OrderingData): string[] =>
    ordering.kind === 'inputs'
      ? ordering.inputs.map((input) => {
          const { txId, outputIndex } = parseInput(input);
          return utxoKey(txId, outputIndex);
        })
      : [];

  const source: ProofSource = {
    async finalizedHead() {
      const anchor = (await node.height(MONITOR)) - PEER_SKEW;
      if (anchor < 0n || !(await holds(anchor))) {
        throw undecided('the proof endpoints have not reached the head');
      }
      const height = anchor - depth < 0n ? 0n : anchor - depth;
      const block = await blockAt(height);
      if (!block)
        throw undecided('the final block is not visible to the proof endpoints');
      return {
        height,
        hash: block.id,
        ...(block.timestamp !== undefined ? { timestamp: block.timestamp } : {}),
      };
    },

    async includedFinal(ref: AttemptRef, ordering: OrderingData, from: string) {
      if (!isId(ref.id)) throw undecided('malformed transaction id');
      const status = await acceptance(ref.id);
      if (status !== 'not') {
        const location = await locate(ctx, ref.id, MONITOR);
        if (!location || location === 'no-block') {
          throw undecided('the block of the transaction is not located yet');
        }
        const block = await blockAt(location.height);
        if (!block || block.id !== location.hash || !block.txIds.includes(ref.id)) {
          ctx.located.forget(ref.id);
          throw contradiction('the located block of the transaction is not on the chain');
        }
        if (!(await final(location.height))) {
          throw undecided('the transaction is not final yet');
        }
        return {
          included: true,
          success: status === 'accepted',
          blockHeight: location.height,
          blockHash: location.hash,
          txHash: ref.id,
          ...(status === 'aborted' ? { reason: 'the transaction was aborted' } : {}),
        };
      }
      // Not accepted: only a spent input proves it never will be.
      const inputs = inputsOf(ordering);
      if (inputs.length === 0) throw undecided('the transaction is not accepted yet');
      const unspent = await unspentOf(from, inputs, 'finalized');
      if (inputs.every((input) => unspent.has(input))) {
        throw undecided('the transaction is not accepted yet');
      }
      // Read after the spend: had ours spent the input, it would be accepted by now.
      if ((await acceptance(ref.id)) !== 'not') {
        throw undecided('the transaction was accepted meanwhile');
      }
      return { included: false };
    },

    async slotConsumed(ordering, from, level) {
      const inputs = inputsOf(ordering);
      if (inputs.length === 0) return false;
      const unspent = await unspentOf(from, inputs, level);
      return inputs.some((input) => !unspent.has(input));
    },

    expired: async () => false,

    async blockHash(height, level) {
      if (outOfRange(height)) return null;
      if (level === 'finalized' && !(await final(height))) return null;
      return (await blockAt(height))?.id ?? null;
    },
  };

  // Lesson 18: every read of every proof decides nothing on "not available here".
  return {
    finalizedHead: () => proofRead(() => source.finalizedHead()),
    includedFinal: (ref, ordering, from) =>
      proofRead(() => source.includedFinal(ref, ordering, from)),
    slotConsumed: (ordering, from, level) =>
      proofRead(() => source.slotConsumed(ordering, from, level)),
    expired: (ordering) => source.expired(ordering),
    blockHash: (height, level) => proofRead(() => source.blockHash(height, level)),
  };
}

/**
 * Runs `work` on each item, at most `limit` at a time. After a failure the other runners
 * stop at their next step, and the first failure is thrown.
 */
async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const runner = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        await work(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
}

export function blockSource(ctx: AvalancheContext): BlockSource {
  const { node, config } = ctx;
  return {
    async header(height): Promise<DriverBlock | null> {
      if (outOfRange(height)) return null;
      const block = await node.blockAt(height, MONITOR);
      return block ? toDriverBlock(block) : null;
    },

    async transactions(block, filter) {
      const inconsistent = () =>
        contradiction(`block ${block.height} changed while scanning`);
      const current = await node.blockAt(block.height, MONITOR);
      if (!current || current.id !== block.hash) throw inconsistent();
      // `filter.assets` is a hint: a list without the native asset wants tokens only.
      if (filter?.assets?.length && !filter.assets.includes('native')) return [];
      const txs: DriverTransaction[] = new Array(current.txIds.length);
      await forEachBounded(current.txIds, TX_READS, async (txId, index) => {
        const bytes = await node.txBytes(txId, MONITOR);
        // An accepted block's transaction is accepted: a node without it is behind.
        if (!bytes) throw inconsistent();
        let success = true;
        if (config.vm === 'pvm') {
          const status = await node.txStatus(txId, MONITOR);
          if (status !== 'Committed' && status !== 'Aborted') throw inconsistent();
          success = status === 'Committed';
        }
        txs[index] = decodeTransaction(bytes, config, {
          seen: 'block',
          txHash: txId,
          blockHeight: current.height,
          blockHash: current.id,
          success,
          ...(success ? {} : { reason: 'the transaction was aborted' }),
        });
      });
      // Checked after the reads, so a node that switched blocks meanwhile is caught.
      if ((await node.blockAt(block.height, MONITOR))?.id !== block.hash) {
        throw inconsistent();
      }
      const watched = new Set<string>();
      for (const address of filter?.addresses ?? []) {
        try {
          watched.add(normalizeAddress(address, config).canonical);
        } catch {
          // Not an address of this chain: it matches nothing.
        }
      }
      if ((filter?.addresses?.length ?? 0) === 0) return txs;
      return txs.filter(
        (tx) =>
          tx.transfers.some((t) => watched.has(t.to)) ||
          ((tx.details.signers as readonly string[] | undefined) ?? []).some((s) =>
            watched.has(s),
          ),
      );
    },
  };
}
