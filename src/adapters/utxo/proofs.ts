/**
 * Proofs (finalized-state checks behind `proven` verdicts) and the block source.
 *
 * Finality is N confirmations (spec §15). Lesson 17 (final form, R75): every fact is attested
 * at its own height with a monotone predicate quorum key, and no endpoint proposes a height.
 * "Block h is final" is "every proof endpoint holds a block at h + N − 1": the quorum reads
 * the head with the key `head >= h + N − 1`, so endpoints further ahead agree, and one that
 * trails decides nothing. Only `finalizedHead` (no anchor of its own) takes one endpoint's
 * head, trails it by `PEER_SKEW`, then attests it. Lesson 14: one endpoint's head never
 * decides finality.
 *
 * Lesson 16 (sharpened, R77; ruling C1): `includedFinal` answers "not included" only when an
 * input of our Attempt has a quorum-attested final spender that is neither our txid nor a
 * malleated copy of it (C2). Every other case decides nothing (a retryable `ProviderError`):
 * our transaction in a mempool or in a block not yet final, an unknown spender, a lagging or
 * load-balanced backend. A stale inclusion (its block is no longer the block at its height)
 * is a retryable `PROVIDER_INCONSISTENT`, and so is a transaction view that puts ours in a
 * block while another transaction's spend of its input is final: both cannot hold. So
 * `includedFinal` never answers "not included" without its own attestation of a different
 * final spend, which also closes core residual R76 for Bitcoin: an endpoint-set change
 * between `slotConsumed` and `includedFinal` cannot produce a false proven `replaced`.
 *
 * The block source reads chain data leniently (Task 7's parsers) and binds every page to its
 * block: each page has exactly the transactions the block's count leaves for it, no txid
 * twice, each confirmed in that block. A reorg while paging, or a page the endpoint does not
 * have, decides nothing (retryable). Address filters match output and prevout scripts, so a
 * watched address's spend is kept even when no output of it has an address.
 */
import type {
  BlockSource,
  DriverBlock,
  FinalityLevel,
  ProofSource,
} from '../../core/driver/types';
import { ProviderError } from '../../core/errors/error';
import type { OrderingData } from '../../core/model/ordering';
import type { AttemptRef } from '../../core/model/transaction';
import { toHex } from '../../core/util/bytes';
import { decodeAddress } from './address';
import {
  MONITOR,
  PROOF,
  forEachBounded,
  parseOutpoint,
  proofRead,
  withSignal,
  type UtxoContext,
} from './context';
import { decodeTransaction } from './decode';
import {
  isHash,
  isNotFound,
  type EsploraClient,
  malformed,
  parseHash,
  parseHeight,
  parseOutspend,
  parseTx,
} from './esplora';
import { isOwnCopy } from './reader';
import type { EsploraTx } from './types';

/** Blocks `finalizedHead` trails one endpoint's head by, so peers can attest it (as Plan 2). */
export const PEER_SKEW = 2n;

/** Esplora's page of block transactions (electrs' `CHAIN_TXS_PER_PAGE`). */
const PAGE = 25;
/** Consensus: a block's transaction count × 4 is at most `MAX_BLOCK_WEIGHT` (4,000,000). */
const MAX_BLOCK_TXS = 1_000_000;
/** No height is below 0 or beyond what a server parses: such a height is never sent (I2). */
const MAX_HEIGHT = BigInt(Number.MAX_SAFE_INTEGER);
const outOfRange = (height: bigint): boolean => height < 0n || height > MAX_HEIGHT;

const undecided = (reason: string): ProviderError =>
  new ProviderError('PROVIDER_UNAVAILABLE', reason);

/** Two quorum reads that cannot both hold decide nothing (retryable). */
const contradiction = (reason: string): ProviderError =>
  new ProviderError('PROVIDER_INCONSISTENT', reason, { retryable: true });

const stale = (): ProviderError =>
  contradiction('the including block is no longer the block at its height');

/**
 * F3-R12 M1 (the board's "quorum on what you parse"): a block hash read under the proof
 * quorum is compared as `parseHash` reads it, so two honest endpoints that differ only by
 * whitespace agree, and the key is exactly the value the verdict uses.
 */
const HASH_PROOF = { ...PROOF, quorumKey: parseHash };

/** A transaction view as the proof quorum compares it: its txid, and its block and height. */
const txViewKey = (answer: unknown): string => {
  const t = parseTx(answer);
  return t.status.confirmed
    ? `${t.txid}@${t.status.blockHash}:${t.status.blockHeight}`
    : `${t.txid}:unconfirmed`;
};

/**
 * The reads a proof attests under the proof quorum, each fact at its own height (lesson 17,
 * final form, R75). The proof source and the builder share them (F3-R24 F1): the builder's
 * proof-tagged reads are this module's, never a copy.
 */
export function attestedReads(ctx: UtxoContext, signal?: AbortSignal) {
  const { esplora } = ctx;
  /** "I hold a block at `height`" (monotone in the head, so endpoints further ahead agree). */
  const holds = async (height: bigint): Promise<boolean> => {
    const head = await esplora.tipHeight({
      ...withSignal(PROOF, signal),
      quorumKey: (answer) => parseHeight(answer) >= height,
    });
    return head >= height;
  };
  /** The hash of the block at `height` on the proof endpoints' chain. */
  const hashAt = (height: bigint): Promise<string | null> =>
    esplora.blockHashAt(height, withSignal(HASH_PROOF, signal));
  /** The quorum's hash at `height` must be `hash`; otherwise the answer was stale. */
  const assertCanonical = async (height: bigint, hash: string): Promise<void> => {
    if ((await hashAt(height)) !== hash) throw stale();
  };
  /** A transaction and the block it is in, as the proof endpoints agree on it. */
  const txView = (txid: string): Promise<EsploraTx | null> =>
    esplora.tx(txid, { ...withSignal(PROOF, signal), quorumKey: txViewKey });
  return { holds, hashAt, assertCanonical, txView };
}

/** F3-R24 F1: how many parents `assertConfirmed` reads at once, and keeps once final. */
const PARENT_READS = 4;
const FINAL_PARENTS = 10_000;
const finalParents = new WeakMap<EsploraClient, Map<string, true>>();

const notConfirmed = (): ProviderError =>
  new ProviderError(
    'PROVIDER_UNAVAILABLE',
    "an input's previous transaction is not in a block the proof endpoints hold yet",
  );

/**
 * F3-R24 F1: each of `txids` (the previous transactions of the inputs a build adds) is in a
 * block, attested under the proof quorum at its own height: the proof endpoints agree on the
 * transaction and its block, all hold a block `confirmations − 1` above it, and have that
 * block at that height. Its bytes authenticate themselves (F3-R14), but only this proves a
 * chain holds it: an indexer's invented transaction, or one a reorg took out, would stall an
 * Attempt for good, since nothing would ever spend its outpoint. Anything short of that is a
 * retryable `PROVIDER_UNAVAILABLE` (a stale view `PROVIDER_INCONSISTENT`), and every read
 * decides nothing on failure (lesson 18). A parent found final is not read again.
 */
export async function assertConfirmed(
  ctx: UtxoContext,
  txids: readonly string[],
  confirmations: number,
  signal?: AbortSignal,
): Promise<void> {
  let final = finalParents.get(ctx.esplora);
  if (!final) {
    final = new Map();
    finalParents.set(ctx.esplora, final);
  }
  const known = final;
  const pending = [...new Set(txids)].filter((txid) => !known.has(txid));
  if (pending.length === 0) return;
  await proofRead(async () => {
    const reads = attestedReads(ctx, signal);
    const blocks = new Map<string, bigint>();
    let top = 0n;
    await forEachBounded(pending, PARENT_READS, async (txid) => {
      const tx = await reads.txView(txid);
      if (!tx?.status.confirmed) throw notConfirmed();
      const height = tx.status.blockHeight as bigint;
      blocks.set(tx.status.blockHash as string, height);
      if (height > top) top = height;
    });
    // Monotone: the proof endpoints hold `top + confirmations − 1` only if they hold every
    // lower height, so one read attests every parent's depth.
    if (!(await reads.holds(top + BigInt(Math.max(1, confirmations)) - 1n))) {
      throw notConfirmed();
    }
    for (const [hash, height] of blocks) await reads.assertCanonical(height, hash);
    if (await reads.holds(top + BigInt(ctx.config.confirmations) - 1n)) {
      for (const txid of pending) {
        known.set(txid, true);
        if (known.size > FINAL_PARENTS) known.delete(known.keys().next().value as string);
      }
    }
  });
}

export function proofSource(ctx: UtxoContext): ProofSource {
  const { esplora, config } = ctx;
  const depth = BigInt(config.confirmations) - 1n;
  const { holds, hashAt, assertCanonical, txView } = attestedReads(ctx);

  /** The transaction that spent `input` in a final, canonical block (quorum-attested). */
  const finalSpender = async (input: {
    txid: string;
    vout: number;
  }): Promise<{ txid: string; height: bigint; hash: string } | undefined> => {
    const spend = await esplora.outspend(input.txid, input.vout, {
      ...PROOF,
      quorumKey: (answer) => {
        const s = parseOutspend(answer);
        return s.spent && s.status?.confirmed
          ? `${s.txid}@${s.status.blockHash}:${s.status.blockHeight}`
          : 'not-in-a-block';
      },
    });
    const status = spend.status;
    if (!spend.spent || spend.txid === undefined || !status?.confirmed) return undefined;
    const height = status.blockHeight as bigint;
    const hash = status.blockHash as string;
    if (!(await holds(height + depth))) return undefined;
    await assertCanonical(height, hash);
    return { txid: spend.txid, height, hash };
  };

  const inputsOf = (ordering: OrderingData): { txid: string; vout: number }[] =>
    ordering.kind === 'inputs' ? ordering.inputs.map(parseOutpoint) : [];

  const source: ProofSource = {
    async finalizedHead() {
      const anchor = (await esplora.tipHeight(MONITOR)) - PEER_SKEW;
      if (anchor < 0n || !(await holds(anchor))) {
        throw undecided('the proof endpoints have not reached the head');
      }
      const final = anchor - depth;
      const height = final < 0n ? 0n : final;
      const hash = await hashAt(height);
      if (hash === null)
        throw undecided('the final block is not visible to the proof endpoints');
      return { height, hash };
    },

    async includedFinal(ref: AttemptRef, ordering: OrderingData, from: string) {
      if (!isHash(ref.id)) throw undecided('malformed transaction id');
      const tx = await txView(ref.id);
      if (tx?.status.confirmed) {
        const height = tx.status.blockHeight as bigint;
        const hash = tx.status.blockHash as string;
        if (await holds(height + depth)) {
          await assertCanonical(height, hash);
          // A transaction in a block has executed; its txid commits to its outputs.
          return {
            included: true,
            success: true,
            blockHeight: height,
            blockHash: hash,
            txHash: tx.txid,
          };
        }
      }
      // Unknown, in a mempool, or not yet final: only a final spender of one of our inputs
      // decides. Our own txid there means the views are inconsistent (decide nothing); a
      // malleated copy of ours (C2) is our payment; any other transaction proves ours dead,
      // unless the quorum also puts ours in a block (the views contradict each other).
      for (const input of inputsOf(ordering)) {
        const spender = await finalSpender(input);
        if (spender === undefined) continue;
        if (spender.txid === ref.id) {
          throw undecided('the spend and the transaction views disagree');
        }
        if (await isOwnCopy(ctx, ref.id, from, spender.txid, PROOF)) {
          return {
            included: true,
            success: true,
            blockHeight: spender.height,
            blockHash: spender.hash,
            txHash: spender.txid,
          };
        }
        if (tx?.status.confirmed) {
          throw contradiction(
            'the transaction is in a block while another spend of its input is final',
          );
        }
        return { included: false };
      }
      throw undecided(
        tx
          ? 'the transaction is not final yet'
          : 'the indexer does not know this transaction yet',
      );
    },

    async slotConsumed(ordering, _from, level: FinalityLevel) {
      for (const input of inputsOf(ordering)) {
        if (level === 'latest') {
          if ((await esplora.outspend(input.txid, input.vout, MONITOR)).spent)
            return true;
        } else if ((await finalSpender(input)) !== undefined) {
          return true;
        }
      }
      return false;
    },

    expired: async () => false,

    async blockHash(height, level) {
      if (outOfRange(height)) return null;
      if (level === 'finalized' && !(await holds(height + depth))) return null;
      return hashAt(height);
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

export function blockSource(ctx: UtxoContext): BlockSource {
  const { esplora, config } = ctx;

  /** The output scripts of the watched addresses; `undefined` means no filter. */
  const scriptsOf = (addresses: readonly string[] | undefined) => {
    if (addresses === undefined || addresses.length === 0) return undefined;
    const scripts = new Set<string>();
    for (const address of addresses) {
      try {
        scripts.add(toHex(decodeAddress(address, config.address).script));
      } catch {
        // Not an address of this network: it matches nothing.
      }
    }
    return scripts;
  };

  return {
    async header(height): Promise<DriverBlock | null> {
      if (outOfRange(height)) return null;
      const hash = await esplora.blockHashAt(height, MONITOR);
      if (!hash) return null;
      const block = await esplora.block(hash, MONITOR);
      if (!block) return null;
      // I2: the block at `height` must say it is at `height`.
      if (block.height !== height) {
        throw contradiction(`block ${height} changed while reading`);
      }
      return {
        height: block.height,
        hash: block.hash,
        parentHash: block.parentHash,
        timestamp: block.timestamp,
      };
    },

    async transactions(block, filter) {
      const inconsistent = () =>
        contradiction(`block ${block.height} changed while scanning`);
      const meta = await esplora.block(block.hash, MONITOR);
      if (!meta || meta.height !== block.height) throw inconsistent();
      // Every block has a coinbase; none holds more than consensus allows. Bounded work.
      if (meta.txCount < 1 || meta.txCount > MAX_BLOCK_TXS) {
        throw malformed('block.tx_count');
      }
      // `filter.assets` is a hint: a list without the native asset wants tokens only, and a
      // Bitcoin block has none, so nothing is paged (F3-R12 M2).
      if (filter?.assets?.length && !filter.assets.includes('native')) return [];
      const txs: EsploraTx[] = [];
      const seen = new Set<string>();
      for (let start = 0; start < meta.txCount; start += PAGE) {
        let page: EsploraTx[];
        try {
          page = await esplora.blockTxs(block.hash, start, MONITOR);
        } catch (error) {
          // A backend that does not have the block (lagging, load-balanced) decides nothing.
          if (isNotFound(error)) throw inconsistent();
          throw error;
        }
        // Each page holds exactly what the count leaves for it, and no txid twice.
        if (page.length !== Math.min(PAGE, meta.txCount - start)) {
          throw malformed('block txs page');
        }
        for (const tx of page) {
          if (seen.has(tx.txid)) throw malformed('block txs page');
          seen.add(tx.txid);
          const { status } = tx;
          if (
            !status.confirmed ||
            status.blockHash !== block.hash ||
            status.blockHeight !== block.height
          ) {
            throw inconsistent();
          }
          txs.push(tx);
        }
      }
      // Checked after the pages, so a reorg while paging is caught.
      if ((await esplora.blockHashAt(block.height, MONITOR)) !== block.hash)
        throw inconsistent();
      const wanted = scriptsOf(filter?.addresses);
      const touches = (tx: EsploraTx) =>
        wanted === undefined ||
        tx.vout.some((output) => wanted.has(output.script)) ||
        tx.vin.some((input) => input.prevout && wanted.has(input.prevout.script));
      return txs.filter(touches).map((tx) => decodeTransaction(tx, config.address));
    },
  };
}
