/**
 * Proofs and address history (spec §6.7, §10, D9, D10, D12). Every proof follows lesson 17's
 * final form: a fact is attested at its own height, with a monotone predicate or at a fixed
 * block, and no endpoint proposes a height. The one exception is the unanchored head: one
 * endpoint's masterchain head, trailed by `finalitySkewBlocks` and attested by a quorum read
 * of that block, retried at the transport's own lag tolerance (M1). Every lookup is bound to
 * what it asked for (the board): a header names the block asked, the shard tops cover the
 * basechain, a state is the one at the block asked. Anything not yet decidable (indexer
 * lag, an incomplete trace, a message that may still land, a wallet state that does not
 * show its seqno) throws a retryable `PROVIDER_UNAVAILABLE`, and an answer the chain could
 * not have produced a retryable `PROVIDER_INCONSISTENT`; both decide nothing (lessons 16,
 * 18).
 */
import type { AddressHistorySource, ProofSource } from '../../core/driver/types';
import {
  ProviderError,
  ValidationError,
  isCryptoAioError,
} from '../../core/errors/error';
import type { OrderingData } from '../../core/model/ordering';
import {
  MASTERCHAIN_SHARD,
  MONITOR,
  PROOF,
  READ,
  runResultOf,
  type BlockHeader,
  type BlockId,
  type RunResult,
  type V3Transaction,
} from './api';
import {
  confirmLegs,
  decodeWithJettons,
  findOwnAttempt,
  provenRequest,
  publicKeyAt,
  traceBlock,
  type TonContext,
} from './reader';
import { attemptVerdict, consumesSeqno, isOwnAttempt } from './trace';
import type { TonCallTags } from './types';

/** How far back the consumer of a seqno is searched: pages of `CONSUMER_PAGE` transactions. */
export const CONSUMER_PAGES = 8;
const CONSUMER_PAGE = 64;

/** toncenter v3 refuses a page of more rows ("limit is not allowed: 1001 > 1000", live). */
const HISTORY_PAGE_MAX = 1000;
/** A logical time is a u64 (lesson 19); a history cursor is one, in decimal. */
const MAX_LT = (1n << 64n) - 1n;
const MAX_LT_DIGITS = 20;
/** A wallet seqno is a u32: any other number is no seqno. */
const MAX_WALLET_SEQNO = 0xffff_ffffn;
/** The shard id space of a workchain: 2^64 ids, which its shards partition. */
const SHARD_SPACE = 1n << 64n;

const undecided = (reason: string) =>
  new ProviderError('PROVIDER_UNAVAILABLE', reason, { retryable: true });

const inconsistent = (reason: string) =>
  new ProviderError('PROVIDER_INCONSISTENT', reason, { retryable: true });

const sameBlock = (a: BlockId, b: BlockId): boolean =>
  a.workchain === b.workchain &&
  a.shard === b.shard &&
  a.seqno === b.seqno &&
  a.rootHash === b.rootHash &&
  a.fileHash === b.fileHash;

/**
 * The masterchain block `seqno`, attested by the proof quorum (ids, hashes, time, global
 * id), and bound to the block asked: an answer about another block or network decides
 * nothing.
 */
async function masterchainBlock(ctx: TonContext, seqno: number): Promise<BlockHeader> {
  const header = await ctx.api.masterchainHeader(seqno, PROOF);
  const { id } = header;
  if (
    id.workchain !== -1 ||
    id.shard !== MASTERCHAIN_SHARD ||
    id.seqno !== seqno ||
    header.globalId !== ctx.config.globalId
  ) {
    throw inconsistent('the endpoints answered another block than the one asked');
  }
  return header;
}

/**
 * The one unanchored head (lesson 17): one endpoint's head, trailed by the network's skew
 * and attested by the quorum; when a healthy peer trails further, retried at the transport's
 * lag tolerance, the furthest a proof endpoint may trail (M1). Never a false head, only a
 * later one.
 */
export async function attestedHead(ctx: TonContext): Promise<BlockHeader> {
  const head = await ctx.api.masterchainHead(MONITOR);
  const skew = ctx.config.finalitySkewBlocks;
  const lag = ctx.api.lagTolerance;
  let last: unknown;
  for (const trail of lag > skew ? [skew, lag] : [skew]) {
    try {
      return await masterchainBlock(ctx, Math.max(1, head - trail));
    } catch (error) {
      if (!isCryptoAioError(error) || !error.retryable) throw error;
      last = error;
    }
  }
  throw last;
}

/**
 * Whether the basechain shards among `tops` partition its whole id space: a shard id is its
 * prefix, then a 1 bit, then zeros, so it covers `id ± lowest set bit` (unsigned). A set that
 * leaves a shard out would hide that shard's time (D9).
 */
function coversBasechain(tops: readonly BlockId[]): boolean {
  const ranges: (readonly [bigint, bigint])[] = [];
  for (const top of tops) {
    if (top.workchain !== 0) continue;
    const id = BigInt.asUintN(64, BigInt(top.shard));
    const half = id & -id;
    if (half === 0n) return false;
    ranges.push([id - half, id + half]);
  }
  ranges.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let next = 0n;
  for (const [start, end] of ranges) {
    if (start !== next) return false;
    next = end;
  }
  return next === SHARD_SPACE;
}

/**
 * D9: no block after `header` can include a message valid until `validUntil`: the
 * masterchain block and every shard top it commits are at least that old, every later block
 * of a shard is younger than its top (the collator's `now` rises), and a wallet rejects a
 * message once `valid_until <= now()`. Each shard top is read under the proof quorum and
 * bound to the id the attested block commits; a shard set that does not cover the
 * basechain decides nothing.
 */
export async function expiredAt(
  ctx: TonContext,
  header: BlockHeader,
  validUntil: number,
): Promise<boolean> {
  if (validUntil > header.genUtime) return false;
  const tops = await ctx.api.shards(header.id.seqno, PROOF);
  if (!coversBasechain(tops)) {
    throw inconsistent('the shard tops do not cover the basechain');
  }
  for (const top of tops) {
    const shard = await ctx.api.blockHeader(top, PROOF);
    if (!sameBlock(shard.id, top) || shard.globalId !== ctx.config.globalId) {
      throw inconsistent('the endpoints answered another shard block than the one asked');
    }
    if (validUntil > shard.genUtime) return false;
  }
  return true;
}

/** The seqno a `seqno` get-method answers; undefined when it answers none (I6). */
function seqnoIn(result: RunResult): bigint | undefined {
  const first = result.stack[0];
  return result.exitCode === 0 &&
    first?.type === 'num' &&
    first.value >= 0n &&
    first.value <= MAX_WALLET_SEQNO
    ? first.value
    : undefined;
}

/**
 * F3-R12: what endpoints must agree on for a seqno read is the seqno the verdict uses. It
 * never throws: an answer that does not parse is itself a fact, which the parse refuses.
 */
function seqnoKey(body: unknown): unknown {
  try {
    return seqnoIn(runResultOf(body))?.toString() ?? null;
  } catch {
    return 'malformed';
  }
}

/** Proof reads under the quorum, keyed on the seqno itself. */
const SEQNO_PROOF: TonCallTags = { ...PROOF, quorumKey: seqnoKey };

/** An Attempt id (a 32-byte hash in hex, either case) in lower case; undefined otherwise. */
const attemptId = (id: string): string | undefined =>
  /^[0-9a-fA-F]{64}$/.test(id) ? id.toLowerCase() : undefined;

/**
 * The wallet transaction that consumed `seqno`, searched newest-first below the wallet's
 * last transaction at the attested block `head` (a fixed window, so honest indexers agree),
 * on the indexer's pages as served (F6-R12: rows it leaves out never end the search). Only
 * a proven request counts (`provenRequest`: A23, the final review, C8-2): an external one
 * that consumed its seqno, or a W5 request relayed internally that the wallet ran, in
 * either case signed by the wallet's key at `head` for this very wallet. A forged or
 * made-up request that claims the seqno is skipped, so it can never pass for the consumer.
 * A consumer whose request had expired by its transaction's time contradicts the chain (a
 * wallet refuses it). `undefined` when the consumer is not (yet) indexed.
 */
async function consumerOf(
  ctx: TonContext,
  from: string,
  seqno: bigint,
  head: BlockHeader,
  lastLt: bigint,
): Promise<V3Transaction | undefined> {
  const keyAtHead = publicKeyAt(ctx, from, PROOF, head.id.seqno);
  const key = () => keyAtHead();
  let endLt = lastLt;
  for (let page = 0; page < CONSUMER_PAGES; page++) {
    const { transactions, next } = await ctx.api.accountTransactionsPage(
      from,
      { limit: CONSUMER_PAGE, endLt },
      PROOF,
    );
    for (const tx of transactions) {
      const request = await provenRequest(ctx, tx, from, key);
      if (!request) continue;
      const claimed = BigInt(request.seqno);
      if (claimed > seqno) continue;
      if (claimed < seqno) return undefined;
      if (request.validUntil <= tx.now) {
        throw inconsistent('the seqno consumer ran after its request expired');
      }
      return tx;
    }
    if (next === undefined) return undefined;
    endLt = next;
  }
  ctx.log.warn('the seqno consumer is beyond the search window', {
    code: 'SEQNO_CONSUMER_NOT_FOUND',
  });
  return undefined;
}

type Included = Extract<
  Awaited<ReturnType<ProofSource['includedFinal']>>,
  { included: true }
>;

/**
 * Our indexed transaction that consumed its seqno, proven: a complete trace, whose last
 * block the endpoints attest they hold (lesson 17), and the verdict, its jetton wallets
 * confirmed at that block under the proof quorum (Task 8, D6).
 */
async function proveIncluded(
  ctx: TonContext,
  tx: V3Transaction,
  from: string,
): Promise<Included> {
  const trace = await ctx.api.trace(tx.hash, PROOF);
  if (!trace || !trace.complete) throw undecided('the message trace is not complete yet');
  const last = traceBlock(tx, trace);
  if (!(await ctx.api.reachedMasterchain(last, PROOF))) {
    throw undecided('the endpoints have not reached the trace yet');
  }
  const verdict = await confirmLegs(ctx, attemptVerdict(tx, trace), from, PROOF, last);
  if (verdict.kind === 'pending')
    throw undecided('the message trace is not complete yet');
  const header = await masterchainBlock(ctx, tx.mcSeqno);
  return {
    included: true,
    success: verdict.kind === 'success',
    blockHeight: BigInt(tx.mcSeqno),
    blockHash: header.id.rootHash,
    txHash: tx.hash,
    ...(verdict.kind === 'failed' ? { reason: verdict.reason } : {}),
  };
}

const seqnoOrdering = (ordering: OrderingData) =>
  ordering.kind === 'seqno' ? ordering : undefined;

export function createTonProofs(ctx: TonContext): ProofSource {
  const { api } = ctx;
  const walletOf = (from: string) => ctx.codec.normalize(from).canonical;
  return {
    async finalizedHead() {
      const header = await attestedHead(ctx);
      return {
        height: BigInt(header.id.seqno),
        hash: header.id.rootHash,
        timestamp: header.genUtime,
      };
    },

    async includedFinal(ref, ordering, from) {
      const wallet = walletOf(from);
      // C1: only our own wallet transaction, its hash computed here from the bound body. A
      // run that did not consume its seqno (a failed action phase) moved nothing and may run
      // again until the message expires: only the seqno decides it (Task 7).
      const own = await findOwnAttempt(ctx, ref, wallet, PROOF);
      if (own && consumesSeqno(own)) return proveIncluded(ctx, own, wallet);
      const id = attemptId(ref.id);
      if (id === undefined) throw undecided('a TON attempt needs its message hash');
      const slot = seqnoOrdering(ordering);
      if (!slot) throw undecided('a TON attempt needs its seqno ordering');
      // Not proven under our hash. Decide only from state at an attested block (D12).
      const head = await attestedHead(ctx);
      const state = await api.account(wallet, PROOF, head.id.seqno);
      if (state.blockSeqno !== head.id.seqno) {
        throw inconsistent('the endpoints answered the state at another block');
      }
      let seqno: bigint | undefined;
      if (state.status === 'active') {
        seqno = seqnoIn(
          await api.runGetMethod(wallet, 'seqno', [], SEQNO_PROOF, head.id.seqno),
        );
      } else if (state.status === 'uninitialized' && slot.seqno === 0n) {
        seqno = 0n; // never deployed: our first message did not run
      }
      // I6: a frozen wallet, or an uninitialized one past seqno 0 (deleted), shows no seqno.
      if (seqno === undefined)
        throw undecided('the wallet state does not show its seqno');
      if (seqno <= slot.seqno) {
        // Unconsumed at `head`: absent for good only once nothing later can include it.
        if (await expiredAt(ctx, head, slot.validUntil)) return { included: false };
        throw undecided('the message may still be included');
      }
      const consumer = await consumerOf(ctx, wallet, slot.seqno, head, state.lastLt);
      if (!consumer) {
        throw undecided('the transaction that consumed the seqno is not indexed yet');
      }
      if (isOwnAttempt(consumer, wallet, id)) return proveIncluded(ctx, consumer, wallet);
      return { included: false };
    },

    async slotConsumed(ordering, from, level) {
      const slot = seqnoOrdering(ordering);
      if (!slot) return false;
      // I4: masterchain state is final once it exists, so TON gives no separate `latest`
      // evidence: our own landed-but-unindexed message is never observed as `replaced`.
      if (level === 'latest') return false;
      const above = (result: RunResult): boolean => {
        const value = seqnoIn(result);
        return value !== undefined && value > slot.seqno;
      };
      // Lesson 17: "my seqno at the final state is above n", a monotone predicate; the key
      // is the verdict itself (F3-R12), and never throws.
      const key = (body: unknown): unknown => {
        try {
          return above(runResultOf(body));
        } catch {
          return 'malformed';
        }
      };
      return above(
        await api.runGetMethod(walletOf(from), 'seqno', [], { ...PROOF, quorumKey: key }),
      );
    },

    async expired(ordering) {
      const slot = seqnoOrdering(ordering);
      if (!slot) return false;
      return expiredAt(ctx, await attestedHead(ctx), slot.validUntil);
    },

    async blockHash(height) {
      // Every masterchain block is final once it exists: both levels read the same.
      if (height < 0n || height > BigInt(await api.masterchainHead(MONITOR))) return null;
      return (await masterchainBlock(ctx, Number(height))).id.rootHash;
    },
  };
}

/** A history cursor: the next page's `end_lt`, a u64 in decimal (lessons 19, 20). */
function cursorLt(cursor: string | undefined): bigint | undefined {
  if (cursor === undefined) return undefined;
  if (
    cursor.length === 0 ||
    cursor.length > MAX_LT_DIGITS ||
    !/^\d+$/.test(cursor) ||
    BigInt(cursor) > MAX_LT
  ) {
    throw new ValidationError('INVALID_INTENT', 'not a TON history cursor');
  }
  return BigInt(cursor);
}

/**
 * An address's transactions from the indexer, newest first, decoded with jettons only for
 * verified jetton wallets. The cursor is the next page's `end_lt`, taken from the page as
 * the indexer served it (F6-R12), so rows not final yet never end the history early; a page
 * is at most what toncenter serves.
 */
export function createTonHistory(ctx: TonContext): AddressHistorySource {
  return {
    async list(address, options) {
      const endLt = cursorLt(options.cursor);
      const account = ctx.codec.normalize(address).canonical;
      const page = await ctx.api.accountTransactionsPage(
        account,
        {
          limit: Math.min(options.limit, HISTORY_PAGE_MAX),
          ...(endLt !== undefined ? { endLt } : {}),
        },
        READ,
      );
      const items = [];
      for (const tx of page.transactions) {
        items.push(await decodeWithJettons(ctx, tx, READ));
      }
      return {
        items,
        ...(page.next !== undefined ? { next: page.next.toString() } : {}),
      };
    },
  };
}
