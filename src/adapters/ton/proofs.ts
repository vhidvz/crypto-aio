/**
 * Proofs and address history (spec §6.7, §10, D9, D10, D12). Every proof follows lesson 17's
 * final form: a fact is attested at its own height, with a monotone predicate or at a fixed
 * block, and no endpoint proposes a height. The one exception is the unanchored head: one
 * endpoint's masterchain head, trailed by `finalitySkewBlocks` and attested by a quorum read
 * of that block, retried at the transport's own lag tolerance (M1). Every lookup is bound to
 * what it asked for (the board): a header names the block asked, the shard tops cover the
 * basechain, a state and a get-method name the block asked and the state read there.
 *
 * "Not included" rests only on authenticated chain data, never on an indexer's records
 * (F6-R21): at an attested block where the message is expired, the account's own chain of
 * transactions, as the liteserver serves their cells, each hashed here and linked by its
 * `prev_trans` fields back from the attested state's last transaction. A wallet can be
 * reset (deleted, or destroyed to uninitialized, then re-deployed from its public
 * `StateInit` with seqno 0), so an activation, a destruction or a chain start inside what
 * the proof must see decides nothing, unless the chain itself shows our transaction.
 * Anything not yet decidable throws a retryable `PROVIDER_UNAVAILABLE`, and an answer the
 * chain could not have produced a retryable `PROVIDER_INCONSISTENT`; both decide nothing
 * (lessons 16, 18).
 */
import { Cell, loadTransaction, type Message, type Transaction } from '@ton/core';
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
  boundRunResultOf,
  runResultOf,
  type AccountState,
  type BlockHeader,
  type BlockId,
  type BoundRunResult,
  type RawTransaction,
  type RunResult,
  type TransactionId,
  type V3Transaction,
} from './api';
import { OP } from './messages';
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
import { externalHashOf, requestIsOwn } from './wallets';

/** How far back the consumer of a seqno is searched: pages of `CONSUMER_PAGE` transactions. */
export const CONSUMER_PAGES = 8;
const CONSUMER_PAGE = 64;

/** How far the chain is walked (F6-R21): pages of `WALK_PAGE` transactions. */
export const WALK_PAGES = 16;
const WALK_PAGE = 32;
/** How far an anchored indexer history is read: pages of `HISTORY_PAGE` transactions. */
const HISTORY_PAGES = 8;
const HISTORY_PAGE = 64;

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

/** M9: a lifetime is a positive chain time; the reservation's placeholder 0 is none. */
const hasLifetime = (validUntil: number): boolean =>
  Number.isSafeInteger(validUntil) && validUntil > 0;

/**
 * D9: no block after `header` can include a message valid until `validUntil`: the
 * masterchain block and every shard top it commits are at least that old, every later block
 * of a shard is younger than its top (the collator's `now` rises), and a wallet rejects a
 * message once `valid_until <= now()`. The shard tops are asked for the attested block's
 * seqno; toncenter's answer names no block (live), so only the proof quorum binds the list
 * to it (M6), and it must cover the basechain. Each top's header is read under the quorum
 * and bound to the id the list gives. A lifetime that is no time decides nothing (M9).
 */
export async function expiredAt(
  ctx: TonContext,
  header: BlockHeader,
  validUntil: number,
): Promise<boolean> {
  if (!hasLifetime(validUntil)) throw undecided('a TON attempt needs its lifetime');
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
 * The account state at the attested block `head`, bound to it (I3, M7): the block the
 * answer names is `head`, its workchain, shard, seqno and hashes.
 */
async function stateAt(
  ctx: TonContext,
  wallet: string,
  head: BlockHeader,
): Promise<AccountState> {
  const state = await ctx.api.account(wallet, PROOF, head.id.seqno);
  if (!sameBlock(state.block, head.id)) {
    throw inconsistent('the endpoints answered the state at another block');
  }
  return state;
}

/**
 * The wallet's seqno in the attested `state` (I2): the get-method's answer must name the
 * attested block and the state's last transaction, so it is the state whose status was
 * read, never an endpoint's latest one. The quorum key is the seqno and that binding
 * (F3-R12); it never throws.
 */
async function seqnoAt(
  ctx: TonContext,
  wallet: string,
  head: BlockHeader,
  state: AccountState,
): Promise<bigint | undefined> {
  const bound = (result: BoundRunResult): boolean =>
    sameBlock(result.block, head.id) &&
    result.lastTransaction.lt === state.lastLt &&
    result.lastTransaction.hash === state.lastHash;
  const key = (body: unknown): unknown => {
    try {
      const result = boundRunResultOf(body);
      return { seqno: seqnoIn(result)?.toString() ?? null, bound: bound(result) };
    } catch {
      return 'malformed';
    }
  };
  const result = await ctx.api.runGetMethodAt(
    wallet,
    'seqno',
    [],
    { ...PROOF, quorumKey: key },
    head.id.seqno,
  );
  if (!bound(result)) {
    throw inconsistent('the seqno was read at another state than the attested one');
  }
  return seqnoIn(result);
}

/** An Attempt id (a 32-byte hash in hex, either case) in lower case; undefined otherwise. */
const attemptId = (id: string): string | undefined =>
  /^[0-9a-fA-F]{64}$/.test(id) ? id.toLowerCase() : undefined;

/**
 * A positive-path hint only (F6-R21 e): the wallet transaction the indexer lists as the
 * consumer of `seqno`, searched newest-first below the wallet's last transaction at the
 * attested block `head`, on the indexer's pages as served (F6-R12). Only a proven request
 * counts (`provenRequest`: A23, the final review, C8-2), and one whose request had expired
 * by its transaction's time contradicts the chain. The caller takes it only when it is our
 * own; it is never the basis of "not included". `undefined` when none is indexed.
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

// ---- the account's own chain (F6-R21) -----------------------------------------------------

const hex256 = (value: bigint): string => value.toString(16).padStart(64, '0');

/**
 * A transaction the liteserver served, authenticated (F6-R21 a): its cell (capped by the
 * API before this decodes it, lesson 20) hashes to the id expected, and it is the account's
 * own at the lt expected. Anything else is not the chain's.
 */
function authenticated(
  row: RawTransaction,
  expected: TransactionId,
  account: bigint,
): Transaction {
  const notTheChains = () =>
    inconsistent("the liteserver answered a transaction that is not the chain's");
  if (row.lt !== expected.lt || row.hash !== expected.hash) throw notTheChains();
  let cell: Cell;
  let tx: Transaction;
  try {
    const cells = Cell.fromBoc(Buffer.from(row.boc, 'base64'));
    if (cells.length !== 1) throw notTheChains();
    cell = cells[0] as Cell;
    tx = loadTransaction(cell.beginParse());
  } catch {
    throw notTheChains();
  }
  if (
    cell.hash().toString('hex') !== expected.hash ||
    tx.lt !== expected.lt ||
    tx.address !== account
  ) {
    throw notTheChains();
  }
  return tx;
}

/**
 * The account's chain from `from` back, one authenticated transaction at a time, each naming
 * the next by its `prev_trans_lt`/`prev_trans_hash`; `visit` returns true to stop. Ends at
 * the chain's start (`prev_trans_lt` 0: the account's first transaction, or its first since
 * a deletion, transaction.cpp `init_new`), or after `WALK_PAGES` pages.
 */
async function walkChain(
  ctx: TonContext,
  wallet: string,
  from: TransactionId,
  visit: (tx: Transaction, hash: string) => Promise<boolean>,
): Promise<'stopped' | 'start' | 'exhausted'> {
  const account = BigInt(`0x${wallet.slice(wallet.indexOf(':') + 1)}`);
  let expected = from;
  for (let page = 0; page < WALK_PAGES; page++) {
    const rows = await ctx.api.rawTransactions(wallet, expected, WALK_PAGE, PROOF);
    if (rows.length === 0) {
      throw undecided('the liteserver does not hold the transaction asked');
    }
    for (const row of rows) {
      const tx = authenticated(row, expected, account);
      if (await visit(tx, expected.hash)) return 'stopped';
      if (tx.prevTransactionLt === 0n) return 'start';
      expected = { lt: tx.prevTransactionLt, hash: hex256(tx.prevTransactionHash) };
    }
  }
  return 'exhausted';
}

const CODE: ReadonlySet<string> = new Set(['active', 'frozen']);
const NO_CODE: ReadonlySet<string> = new Set(['uninitialized', 'non-existing']);

/** What a transaction did, as the chain records it. */
function phasesOf(tx: Transaction) {
  const d = tx.description;
  const compute = 'computePhase' in d ? d.computePhase : undefined;
  const vm = compute?.type === 'vm' ? compute : undefined;
  return {
    /** The wallet's code ran: the chain runs it only when code exists or a StateInit
     * activates the account (transaction.cpp). */
    ran: vm !== undefined,
    /** A request ran to the end, so a seqno moved (the action phase keeps it, M1). */
    consumed:
      d.type === 'generic' && vm?.success === true && d.actionPhase?.success === true,
    /** The account had code before or after. */
    lived: CODE.has(tx.oldStatus) || CODE.has(tx.endStatus),
    /** A re-deploy from no code: the seqno starts again (transaction.cpp activation). */
    activation: NO_CODE.has(tx.oldStatus) && tx.endStatus === 'active',
    /** The code went (+32 destroy, storage deletion): the seqno goes with it. */
    destruction:
      (CODE.has(tx.oldStatus) && NO_CODE.has(tx.endStatus)) ||
      ('destroyed' in d && d.destroyed),
  };
}

/**
 * M8: the seqno a request the wallet ran claims, read from its signed header alone (so a
 * v4r2 plugin request or a W5 extended-action request counts too): an external request, or
 * a W5 `internal_signed` one, signed by the wallet's key for this very wallet
 * (`requestIsOwn`, A23: a v5r1 wallet runs a forged relayed body and ignores it).
 */
async function claimedSeqno(
  ctx: TonContext,
  wallet: string,
  message: Message | null | undefined,
  key: () => Promise<Uint8Array | undefined>,
): Promise<bigint | undefined> {
  if (!message) return undefined;
  const { body } = message;
  const op = body.bits.length >= 32 ? body.beginParse().preloadUint(32) : undefined;
  const w5 = op === OP.w5SignedExternal || op === OP.w5SignedInternal;
  if (
    message.info.type === 'internal'
      ? op !== OP.w5SignedInternal
      : message.info.type !== 'external-in'
  ) {
    return undefined;
  }
  let seqno: number;
  try {
    const s = body.beginParse();
    // W5: op, wallet id, valid_until, seqno; v4r2: signature, subwallet id, valid_until, seqno.
    s.skip(w5 ? 32 + 32 + 32 : 512 + 32 + 32);
    seqno = s.loadUint(32);
  } catch {
    return undefined;
  }
  const publicKey = await key();
  return publicKey && requestIsOwn(wallet, body, publicKey, ctx.config.globalId)
    ? BigInt(seqno)
    : undefined;
}

type Absence = { readonly ours: string } | { readonly absent: true };

interface ChainQuestion {
  readonly wallet: string;
  readonly id: string;
  readonly slot: { readonly seqno: bigint; readonly validUntil: number };
  readonly head: BlockHeader;
  readonly state: AccountState;
  readonly active: boolean;
  /** The seqno at `head` (0 for an uninitialized wallet). */
  readonly seqno: bigint;
}

const resetSuspected = (ctx: TonContext) => {
  ctx.log.warn('the wallet may have been reset since our message', {
    code: 'WALLET_RESET_SUSPECTED',
  });
  return undecided('the wallet may have been reset since our message');
};

const walkExhausted = (ctx: TonContext) => {
  ctx.log.warn('the wallet history is beyond the proof window', {
    code: 'TX_CHAIN_WALK_EXHAUSTED',
  });
  return undecided('the wallet history is beyond the proof window');
};

/** The indexer has indexed the attested block, so its history up to `head` is whole. */
async function indexedThrough(ctx: TonContext, head: BlockHeader): Promise<void> {
  if (!(await ctx.api.indexerReached(head.id.seqno, PROOF))) {
    throw undecided('the indexer has not reached the attested block yet');
  }
}

/**
 * F6-R21 (c): the chain began at lt `start` inside what the proof must see. A genuine first
 * creation has no earlier history; any earlier row (anchored below `start`, under the proof
 * quorum) is an earlier incarnation, which decides nothing.
 */
async function noEarlierHistory(
  ctx: TonContext,
  wallet: string,
  head: BlockHeader,
  start: bigint,
): Promise<void> {
  await indexedThrough(ctx, head);
  const page = await ctx.api.accountTransactionsPage(
    wallet,
    { limit: 1, endLt: start - 1n },
    PROOF,
  );
  if (page.transactions.length > 0 || page.next !== undefined) throw resetSuspected(ctx);
}

/**
 * F6-R21 (d): the wallet's code never ran in the history the indexer holds below lt
 * `below` (all of it without one), under the proof quorum: no compute phase that ran, and
 * no status with code. A row without its statuses, or a history past the window, decides
 * nothing.
 */
async function neverRanBefore(
  ctx: TonContext,
  wallet: string,
  head: BlockHeader,
  below: bigint | undefined,
): Promise<void> {
  await indexedThrough(ctx, head);
  let endLt = below === undefined ? undefined : below - 1n;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const { transactions, next } = await ctx.api.accountTransactionsPage(
      wallet,
      { limit: HISTORY_PAGE, ...(endLt !== undefined ? { endLt } : {}) },
      PROOF,
    );
    for (const tx of transactions) {
      const { origStatus, endStatus } = tx;
      if (
        !tx.compute.skipped ||
        origStatus === undefined ||
        endStatus === undefined ||
        origStatus === 'active' ||
        origStatus === 'frozen' ||
        endStatus === 'active' ||
        endStatus === 'frozen'
      ) {
        throw resetSuspected(ctx);
      }
    }
    if (next === undefined) return;
    endLt = next;
  }
  throw walkExhausted(ctx);
}

/**
 * F6-R21 (a, b): at an attested block where the message is expired, whether our message
 * consumed its seqno, from the account's own chain alone, walked back from the attested
 * state's last transaction:
 * - our message (its TEP-467 hash computed here) run to the end: ours, proven by the caller;
 * - otherwise "absent" only when the chain shows no reset: the walk reaches the earliest
 *   time our message could have run (`validUntil − validForSeconds`, the builder's chain
 *   time, D8) with, when our seqno is consumed at `head`, its consumer found (another
 *   request, by its signed header, M8); or it reaches the chain's start, which the anchored
 *   indexer history settles (c, d).
 * An activation, a destruction, or a consumer of a lower seqno first is a reset: from then
 * on the wallet must never have run, as far as the chain goes; a walk past its cap decides
 * nothing. An uninitialized wallet (d) must never have run at all.
 */
async function fromTheChain(ctx: TonContext, q: ChainQuestion): Promise<Absence> {
  const needConsumer = q.active && q.seqno > q.slot.seqno;
  if (q.state.lastLt === 0n) {
    // No chain at `head`: never created, or deleted with its last transaction (d).
    if (q.active) throw inconsistent('an active account without a transaction');
    await neverRanBefore(ctx, q.wallet, q.head, undefined);
    return { absent: true };
  }
  const windowStart = q.slot.validUntil - ctx.config.validForSeconds;
  const key = publicKeyAt(ctx, q.wallet, PROOF, q.head.id.seqno);
  let neverRan = !q.active;
  let consumerFound = false;
  let reset = false;
  let ours: string | undefined;
  let first = q.state.lastLt;
  const end = await walkChain(
    ctx,
    q.wallet,
    { lt: q.state.lastLt, hash: q.state.lastHash },
    async (tx, hash) => {
      first = tx.lt;
      const t = phasesOf(tx);
      const inbound = tx.inMessage;
      if (
        t.consumed &&
        inbound?.info.type === 'external-in' &&
        externalHashOf(q.wallet, inbound.body) === q.id
      ) {
        ours = hash;
        return true;
      }
      if (!neverRan && tx.now < windowStart && (!needConsumer || consumerFound)) {
        return true;
      }
      if (neverRan) {
        if (t.ran || t.lived || t.destruction) reset = true;
        return false;
      }
      if (t.destruction) reset = true;
      if (needConsumer && !consumerFound && t.consumed) {
        const claimed = await claimedSeqno(ctx, q.wallet, inbound, key);
        if (claimed === q.slot.seqno) consumerFound = true;
        else if (claimed !== undefined && claimed < q.slot.seqno) reset = true;
      }
      if (t.activation) {
        if (needConsumer && !consumerFound) reset = true;
        neverRan = true;
      }
      return false;
    },
  );
  if (ours !== undefined) return { ours };
  if (end === 'exhausted') throw walkExhausted(ctx);
  if (reset || (needConsumer && !consumerFound)) throw resetSuspected(ctx);
  if (end === 'start') {
    if (q.active) await noEarlierHistory(ctx, q.wallet, q.head, first);
    else await neverRanBefore(ctx, q.wallet, q.head, first);
  }
  return { absent: true };
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

/**
 * Our transaction the chain itself holds (`hash`), proven through the indexer's record of
 * that very transaction, which must be our message and have consumed its seqno.
 */
async function proveOurs(
  ctx: TonContext,
  hash: string,
  wallet: string,
  id: string,
): Promise<Included> {
  const record = await ctx.api.transaction(hash, PROOF);
  if (!record) throw undecided('our transaction is not indexed yet');
  if (!isOwnAttempt(record, wallet, id) || !consumesSeqno(record)) {
    throw inconsistent("the indexer's record is not the chain's transaction");
  }
  return proveIncluded(ctx, record, wallet);
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
      if (!hasLifetime(slot.validUntil))
        throw undecided('a TON attempt needs its lifetime');
      // Not proven under our hash: decide only from state at an attested block (D12).
      const head = await attestedHead(ctx);
      const state = await stateAt(ctx, wallet, head);
      const active = state.status === 'active';
      // I6: a frozen wallet, or an uninitialized one past seqno 0, shows no seqno.
      if (!active && (state.status === 'frozen' || slot.seqno !== 0n)) {
        throw undecided('the wallet state does not show its seqno');
      }
      const seqno = active ? await seqnoAt(ctx, wallet, head, state) : 0n;
      if (seqno === undefined)
        throw undecided('the wallet state does not show its seqno');
      if (seqno > slot.seqno) {
        // (e) the indexer's consumer search: a hint that finds ours, never a "no".
        const hint = await consumerOf(ctx, wallet, slot.seqno, head, state.lastLt);
        if (hint && isOwnAttempt(hint, wallet, id))
          return proveIncluded(ctx, hint, wallet);
      }
      // Never "not included" while the message may still run: a reset of the wallet could
      // bring its seqno back to ours.
      if (!(await expiredAt(ctx, head, slot.validUntil))) {
        throw undecided('the message may still be included');
      }
      const chain = await fromTheChain(ctx, {
        wallet,
        id,
        slot,
        head,
        state,
        active,
        seqno,
      });
      if ('ours' in chain) return proveOurs(ctx, chain.ours, wallet, id);
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
