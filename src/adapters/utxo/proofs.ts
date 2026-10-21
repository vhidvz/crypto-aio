/**
 * Proofs (finalized-state checks behind `proven` verdicts) and the block source.
 *
 * Finality is N confirmations. Every fact is attested at its own height with a monotone
 * predicate quorum key, and no endpoint proposes a height. "Block h is final" is "every
 * proof endpoint holds a block at h + N − 1": the quorum reads the head with the key
 * `head >= h + N − 1`, so endpoints further ahead agree, and one that trails decides
 * nothing. Only `finalizedHead` (no anchor of its own) takes one endpoint's head, trails
 * it by `PEER_SKEW`, then attests it. One endpoint's head never decides finality.
 *
 * `includedFinal` answers "not included" only when an input of our Attempt has a
 * quorum-attested final spender that is neither our txid nor a malleated copy of it.
 * Every other case decides nothing (a retryable `ProviderError`): our transaction in a
 * mempool or in a block not yet final, an unknown spender, a lagging or load-balanced
 * backend. A stale inclusion (its block is no longer the block at its height) is a
 * retryable `PROVIDER_INCONSISTENT`, and so is a transaction view that puts ours in a
 * block while another transaction's spend of its input is final: both cannot hold. So
 * `includedFinal` never answers "not included" without its own attestation of a different
 * final spend, and an endpoint-set change between the monitor's `slotConsumed` and
 * `includedFinal` calls cannot produce a false proven `replaced`.
 *
 * The block source delivers only what authenticated bytes say. A block's transactions are
 * decoded from its own bytes (`rawBlock`), which must hash to the block the scan asked for
 * and commit to every transaction and witness, and the header read at its height must be
 * those bytes' own (parent and time). The outputs a delivered transaction's inputs spend,
 * which give its `from`, input values and fee, are read from the block itself or from each
 * previous transaction's bytes, bound to the txid the input names. So no endpoint can add,
 * drop or alter a transaction, an output or a sender of what is delivered. A filtered scan
 * picks transactions by their outputs (the bytes) and by the inputs the index's pages say
 * spend from a watched address; each page must be the bytes' own, confirmed in that block,
 * and its claims must hold for every transaction delivered, so a lying index can at most
 * hide a watched address's spend that pays no watched address. Which block is at a height
 * stays the endpoint's word, as in every family (the proof quorum confirms rollbacks). A
 * reorg while reading, or a block, page or previous transaction the endpoint does not have,
 * decides nothing (retryable). Address filters match output and prevout scripts, so a
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
import { decodeTransaction, scriptType } from './decode';
import {
  MAX_MONEY,
  isHash,
  isNotFound,
  type EsploraClient,
  malformed,
  parseHash,
  parseHeight,
  parseOutspend,
  parseTx,
  type TxOutput,
} from './esplora';
import { isNullOutpoint, type RawBlock } from './rawblock';
import type { ParsedTx } from './rawtx';
import { isOwnCopy } from './reader';
import type { EsploraInput, EsploraOutput, EsploraStatus, EsploraTx } from './types';

/** Blocks `finalizedHead` trails one endpoint's head by, so peers can attest it. */
export const PEER_SKEW = 2n;

/** Esplora's page of block transactions (electrs' `CHAIN_TXS_PER_PAGE`). */
const PAGE = 25;
/**
 * How many previous transactions a block scan reads at once: a full block's delivered
 * transactions spend outputs of thousands. The transport's rate limit still paces them.
 */
const PREVIOUS_READS = 8;
/** No height is below 0 or beyond what a server parses: such a height is never sent. */
const MAX_HEIGHT = BigInt(Number.MAX_SAFE_INTEGER);
const outOfRange = (height: bigint): boolean => height < 0n || height > MAX_HEIGHT;

const undecided = (reason: string): ProviderError =>
  new ProviderError('PROVIDER_UNAVAILABLE', reason);

/** Two quorum reads that cannot both hold decide nothing (retryable). */
const contradiction = (reason: string): ProviderError =>
  new ProviderError('PROVIDER_INCONSISTENT', reason, { retryable: true });

const stale = (): ProviderError =>
  contradiction('the including block is no longer the block at its height');

/** The block a scan reads is gone from the endpoint's chain, or was never on it. */
const changed = (block: DriverBlock): ProviderError =>
  contradiction(`block ${block.height} changed while scanning`);

/**
 * An output of a block's or a previous transaction's bytes as an Esplora page shows it.
 * Its value is in range (consensus), so out of range the bytes are not chain data.
 */
function outputView(output: TxOutput): EsploraOutput {
  if (output.value < 0n || output.value > MAX_MONEY) throw malformed('output value');
  return {
    script: toHex(output.script),
    type: scriptType(output.script),
    value: output.value,
  };
}

/**
 * Whether a page's transaction is `own`, the one the block's bytes hold at its place: the
 * same txid, and the same inputs (outpoints, sequences, coinbase) and outputs.
 */
function samePageTx(page: EsploraTx, own: ParsedTx): boolean {
  return (
    page.txid === own.txid &&
    page.version === own.version &&
    page.locktime === own.locktime &&
    page.vin.length === own.inputs.length &&
    page.vout.length === own.outputs.length &&
    page.vin.every((input, n) => {
      const mine = own.inputs[n];
      return (
        mine !== undefined &&
        input.txid === mine.txid &&
        input.vout === mine.vout &&
        input.sequence === mine.sequence &&
        input.coinbase === isNullOutpoint(mine)
      );
    }) &&
    page.vout.every((output, n) => {
      const mine = own.outputs[n];
      return (
        mine !== undefined &&
        output.value === mine.value &&
        output.script === toHex(mine.script)
      );
    })
  );
}

/**
 * A block hash read under the proof quorum is compared as `parseHash` reads it, so two
 * honest endpoints that differ only by whitespace agree, and the key is exactly the value
 * the verdict uses. Compared as raw text, one endpoint's trailing newline would split the
 * quorum forever.
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
 * The reads a proof attests under the proof quorum, each fact at its own height. The
 * proof source and the builder share them: the builder's proof-tagged reads are this
 * module's, never a copy.
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

/** How many parents `assertConfirmed` reads at once, and keeps once final. */
const PARENT_READS = 4;
const FINAL_PARENTS = 10_000;
const finalParents = new WeakMap<EsploraClient, Map<string, true>>();

const notConfirmed = (): ProviderError =>
  new ProviderError(
    'PROVIDER_UNAVAILABLE',
    "an input's previous transaction is not in a block the proof endpoints hold yet",
  );

/**
 * Each of `txids` (the previous transactions of the inputs a build adds) is in a
 * block, attested under the proof quorum at its own height: the proof endpoints agree on the
 * transaction and its block, all hold a block `confirmations − 1` above it, and have that
 * block at that height. Its bytes authenticate themselves, but only this proves a
 * chain holds it: an indexer's invented transaction, or one a reorg took out, would stall an
 * Attempt for good, since nothing would ever spend its outpoint. Anything short of that is a
 * retryable `PROVIDER_UNAVAILABLE` (a stale view `PROVIDER_INCONSISTENT`), and every read
 * decides nothing on failure. A parent found final is not read again.
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
      // malleated copy of ours is our payment; any other transaction proves ours dead,
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

  // Every read of every proof decides nothing on "not available here".
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

  /**
   * The places of `raw`'s transactions that touch `wanted`, with each one's page: an output
   * to it, read from the block's own bytes, or an input that, by the index's pages, spends
   * from it. Every page is bound to the bytes: exactly the transactions they hold at its
   * places, with the same inputs and outputs, confirmed in this block. So a page only claims
   * which outputs the block's inputs spend, and `viewOf` checks the claims of every
   * transaction delivered against the previous transactions' own bytes: all a lying index
   * can do is hide a spend from a watched address that pays no watched address.
   */
  const touching = async (
    block: DriverBlock,
    raw: RawBlock,
    wanted: ReadonlySet<string>,
  ): Promise<Map<number, EsploraTx>> => {
    const picked = new Map<number, EsploraTx>();
    for (let start = 0; start < raw.txs.length; start += PAGE) {
      let page: EsploraTx[];
      try {
        page = await esplora.blockTxs(block.hash, start, MONITOR);
      } catch (error) {
        // A backend that does not have the block (lagging, load-balanced) decides nothing.
        if (isNotFound(error)) throw changed(block);
        throw error;
      }
      // Each page holds exactly what the block leaves for it.
      if (page.length !== Math.min(PAGE, raw.txs.length - start)) {
        throw malformed('block txs page');
      }
      page.forEach((tx, offset) => {
        const own = raw.txs[start + offset] as ParsedTx;
        if (!samePageTx(tx, own)) {
          throw contradiction("a block page differs from the block's own bytes");
        }
        const { status } = tx;
        if (
          !status.confirmed ||
          status.blockHash !== block.hash ||
          status.blockHeight !== block.height
        ) {
          throw changed(block);
        }
        if (
          own.outputs.some((output) => wanted.has(toHex(output.script))) ||
          tx.vin.some((input) => input.prevout && wanted.has(input.prevout.script))
        ) {
          picked.set(start + offset, tx);
        }
      });
    }
    return picked;
  };

  /**
   * The outputs the inputs of `txs` spend, by previous txid: a transaction of the block
   * itself, or the previous transaction's own bytes, bound to its txid (`outputsOf`). One
   * endpoint answers, so one that does not have a previous transaction decides nothing.
   */
  const spentOutputs = async (
    raw: RawBlock,
    txs: readonly ParsedTx[],
  ): Promise<ReadonlyMap<string, readonly TxOutput[]>> => {
    const known = new Map<string, readonly TxOutput[]>(
      raw.txs.map((tx) => [tx.txid, tx.outputs]),
    );
    const missing = new Set<string>();
    for (const tx of txs) {
      for (const input of tx.inputs) {
        if (!isNullOutpoint(input) && !known.has(input.txid)) missing.add(input.txid);
      }
    }
    await forEachBounded([...missing], PREVIOUS_READS, async (txid) => {
      const outputs = await esplora.outputsOf(txid, MONITOR);
      if (!outputs) throw undecided("an input's previous transaction is not available");
      known.set(txid, outputs);
    });
    return known;
  };

  /**
   * A transaction of the block as Esplora shows it, from its own bytes and the outputs its
   * inputs spend, so it decodes as a page of it would. A page's claims about those outputs
   * (`page`) must be what the previous transactions hold.
   */
  const viewOf = (
    tx: ParsedTx,
    spent: ReadonlyMap<string, readonly TxOutput[]>,
    status: EsploraStatus,
    page: EsploraTx | undefined,
  ): EsploraTx => {
    const vout = tx.outputs.map(outputView);
    let coinbase = false;
    let fee = -vout.reduce((sum, output) => sum + output.value, 0n);
    const vin = tx.inputs.map((input, n): EsploraInput => {
      const outpoint = { txid: input.txid, vout: input.vout, sequence: input.sequence };
      if (isNullOutpoint(input)) {
        coinbase = true;
        return { ...outpoint, coinbase: true };
      }
      const output = spent.get(input.txid)?.[input.vout];
      if (!output)
        throw contradiction('a block input spends an output that does not exist');
      const prevout = outputView(output);
      const claim = page?.vin[n]?.prevout;
      if (claim && (claim.script !== prevout.script || claim.value !== prevout.value)) {
        throw contradiction(
          'the index names another output than the one an input spends',
        );
      }
      fee += prevout.value;
      return { ...outpoint, coinbase: false, prevout };
    });
    // Esplora's convention: a coinbase's fee is 0.
    if (coinbase) fee = 0n;
    if (fee < 0n || fee > MAX_MONEY) throw malformed('tx fee');
    return {
      txid: tx.txid,
      version: tx.version,
      locktime: tx.locktime,
      weight: tx.strippedSize * 3 + tx.bytes.length,
      fee,
      vin,
      vout,
      status,
    };
  };

  return {
    async header(height): Promise<DriverBlock | null> {
      if (outOfRange(height)) return null;
      const hash = await esplora.blockHashAt(height, MONITOR);
      if (!hash) return null;
      const block = await esplora.block(hash, MONITOR);
      if (!block) return null;
      // The block at `height` must say it is at `height`.
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
      // `filter.assets` is a hint: a list without the native asset wants tokens only, and a
      // Bitcoin block has none, so nothing is read.
      if (filter?.assets?.length && !filter.assets.includes('native')) return [];
      // The block's own bytes, bound to its hash (`rawBlock`): every transaction delivered
      // is the block's, byte for byte, whatever the index's pages say.
      const raw = await esplora.rawBlock(block.hash, MONITOR);
      // A backend that does not have the block (lagging, load-balanced, or a full-mode
      // electrs, which serves its best chain's only) decides nothing.
      if (!raw) throw changed(block);
      // The header read at this height must be the bytes' own, so the block delivered (its
      // parent link and time) is the one its hash names.
      if (raw.parentHash !== block.parentHash || raw.time !== block.timestamp) {
        throw contradiction(`the header of block ${block.height} is not its own`);
      }
      const wanted = scriptsOf(filter?.addresses);
      const picked = wanted && (await touching(block, raw, wanted));
      const txs = picked ? raw.txs.filter((_, i) => picked.has(i)) : raw.txs;
      const spent = await spentOutputs(raw, txs);
      // Checked after the reads, so a reorg while reading is caught.
      if ((await esplora.blockHashAt(block.height, MONITOR)) !== block.hash) {
        throw changed(block);
      }
      const status: EsploraStatus = {
        confirmed: true,
        blockHeight: block.height,
        blockHash: block.hash,
        blockTime: raw.time,
      };
      return raw.txs.flatMap((tx, i) =>
        picked && !picked.has(i)
          ? []
          : [
              decodeTransaction(
                viewOf(tx, spent, status, picked?.get(i)),
                config.address,
              ),
            ],
      );
    },
  };
}
