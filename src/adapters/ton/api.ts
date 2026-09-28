/**
 * The TON driver's only path to the network (spec §11, D1): toncenter API v2 (the `rpc`
 * transport: live liteserver state, get-methods at a fixed masterchain block, fee emulation,
 * sending) and API v3 (the `indexer` transport: message → transaction, traces, history,
 * jetton metadata), as REST calls through the core transports. Each call carries its
 * driver method's tags (R41) and a `route` with no identifiers in it (R14), and reads
 * integers exactly (A12: toncenter writes some u64 values as JSON numbers). Answers are
 * validated here (lesson 6): a malformed one, including a missing or ill-typed field a
 * verdict reads, is a retryable `PROVIDER_UNAVAILABLE`, never a default or a foreign error.
 * Lookups by id keep only what they asked for, so a dropped server-side filter reads as
 * "none yet"; a history that breaks its query is malformed. Numbers, cells and metadata are
 * bounded before use (lesson 20). Under a quorum, every method compares the parsed facts it
 * returns (lesson 2, M5), or the caller's predicate key (lesson 17). SDK-free.
 */
import {
  ProviderError,
  ValidationError,
  isCryptoAioError,
} from '../../core/errors/error';
import type { CallOptions, HttpRequest, Transport } from '../../core/transport/types';
import type { TonCallTags } from './types';

export const READ: TonCallTags = { purpose: 'read', retry: 'safe' };
export const MONITOR: TonCallTags = { purpose: 'monitor', retry: 'safe' };
export const PROOF: TonCallTags = { purpose: 'proof', retry: 'safe', quorum: 'proof' };
export const BROADCAST: TonCallTags = {
  purpose: 'broadcast',
  retry: 'ambiguous-on-failure',
};

export const withSignal = (tags: TonCallTags, signal?: AbortSignal): TonCallTags =>
  signal ? { ...tags, signal } : tags;

/** The masterchain's one shard, as toncenter v2 writes it. */
export const MASTERCHAIN_SHARD = '-9223372036854775808';

/**
 * Lesson 20: the most cells a message body may hold, checked in the BOC header before the
 * SDK parses anything. TON refuses a message of more than 2^13 cells or 2^21 bits (config
 * param 43, "account and message limits", docs.ton.org/foundations/config; the node's
 * defaults `max_msg_cells = 1 << 13` and `max_msg_bits = 1 << 21` in `SizeLimitsConfig`,
 * ton-blockchain/ton `crypto/block/mc-config.h`), so no body the chain carried holds more.
 * The text length alone does not bound the work: minimal cells cost about 4 bytes each,
 * and `Cell.fromBoc` takes about 20-50 µs per cell.
 */
export const MAX_BODY_CELLS = 1 << 13;

/**
 * Lesson 20: the longest message body BOC text `cellFromBoc` decodes. The same limits give
 * at most 2^21 / 8 bytes of data in 2^13 cells, each with 2 descriptor bytes, 4 two-byte
 * refs, a rounding byte and a 3-byte index entry, plus a header and a checksum: under
 * 377,000 bytes, about 502,500 base64 characters.
 */
export const MAX_BODY_BOC_LENGTH = 1 << 19;

/**
 * Lesson 20 and F6-R13: the most cells of a jetton master's content that `jettonData` hands
 * on. The content is part of the master's account state, not a message, and TON caps a state
 * at 2^16 cells and 2^16 × 1023 bits (config param 43, `max_acc_state_cells` and
 * `max_acc_state_bits`, the node's defaults in `SizeLimitsConfig`, ton-blockchain/ton
 * `crypto/block/mc-config.h`), so no content the chain holds is larger.
 */
export const MAX_STATE_CELLS = 1 << 16;

/**
 * Lesson 20 and F6-R13: the longest content BOC text `jettonData` hands on. The same limits
 * give at most 2^16 × 1023 / 8 bytes of data in 2^16 cells, each with 2 descriptor bytes, 4
 * three-byte refs, a rounding byte and a 4-byte index entry, plus a header and a checksum:
 * under 9.7 MB, about 12.9 million base64 characters. Decoding a state of that size takes
 * about 2 s (`@ton/core` 0.63.1, measured); only a master's metadata, read once per token
 * and cached, can be that large.
 */
export const MAX_STATE_BOC_LENGTH = 1 << 24;

/**
 * The cell count a BOC header declares, for the three layouts `@ton/core` reads (magic,
 * then the size byte or flags with the size in their low 3 bits, the offset size, and the
 * count in `size` bytes); undefined for anything else.
 */
function bocCellCount(bytes: Buffer): number | undefined {
  if (bytes.length < 6) return undefined;
  const magic = bytes.readUInt32BE(0);
  const head = bytes[4] as number;
  const size =
    magic === 0xb5ee9c72
      ? head & 0x07
      : magic === 0x68ff65f3 || magic === 0xacc3a728
        ? head
        : 0;
  if (size < 1 || size > 4 || bytes.length < 6 + size) return undefined;
  return bytes.readUIntBE(6, size);
}

/**
 * Lesson 20: a base64 BOC measured against limits, by default one message's (at most
 * `maxLength` characters, and a header, its first 16 characters, declaring at most
 * `maxCells` cells): `oversized` beyond them, `malformed` without a BOC header.
 */
function bocSize(
  boc: string,
  maxCells: number = MAX_BODY_CELLS,
  maxLength: number = MAX_BODY_BOC_LENGTH,
): 'ok' | 'oversized' | 'malformed' {
  if (boc.length === 0) return 'malformed';
  const count = bocCellCount(Buffer.from(boc.slice(0, 16), 'base64'));
  if (count === undefined) return 'malformed';
  return boc.length > maxLength || count > maxCells ? 'oversized' : 'ok';
}

/**
 * Lesson 20: whether a base64 BOC is within one message's limits. SDK-free, so the API layer
 * bounds the cells it hands on (config params, get-method stacks) and `cellFromBoc` the
 * bodies it decodes.
 */
export function bocWithinLimits(boc: string): boolean {
  return bocSize(boc) === 'ok';
}

/**
 * M4: the longest token metadata texts read from the indexer (decimals: 0..255). A longer
 * or ill-typed `symbol` is reported unreadable (F6-R13); a `name` beyond its limit is absent
 * (F6-R8).
 */
const CONTENT_LIMITS = { symbol: 256, name: 256 } as const;

type Json = Record<string, unknown>;

function malformed(route: string): ProviderError {
  return new ProviderError(
    'PROVIDER_UNAVAILABLE',
    `malformed toncenter answer to ${route}`,
    {
      retryable: true,
    },
  );
}

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Checks, else throws the retryable malformed-answer error. */
function need<T>(value: T | undefined | null, route: string): T {
  if (value === undefined || value === null) throw malformed(route);
  return value;
}

/** An optional field: absent (undefined or null), else `read` must accept it (lesson 6). */
function optional<T>(
  value: unknown,
  read: (value: unknown) => T | undefined,
  route: string,
): T | undefined {
  return value === undefined || value === null ? undefined : need(read(value), route);
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const bool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;
const record = (value: unknown): Json | undefined =>
  isRecord(value) ? value : undefined;
const int = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : typeof value === 'string' && /^-?\d{1,15}$/.test(value)
      ? Number(value)
      : undefined;
/**
 * An integer as a decimal string, a safe number or (A12) an exactly read bigint. Lesson 20:
 * at most 80 digits (the core's exact-integer cap; u256 has 78), refused before `BigInt`.
 */
const big = (value: unknown): bigint | undefined =>
  typeof value === 'bigint'
    ? value
    : typeof value === 'string' && /^-?\d{1,80}$/.test(value)
      ? BigInt(value)
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? BigInt(value)
        : undefined;

const COINS_MAX = 2n ** 120n - 1n;
const U64_MAX = 2n ** 64n - 1n;

/** M1: an unsigned integer up to `max`. */
function unsigned(value: unknown, max: bigint): bigint | undefined {
  const n = big(value);
  return n !== undefined && n >= 0n && n <= max ? n : undefined;
}
/** An amount of nanograms (`Coins`, a VarUInteger 16: below 2^120). */
const coins = (value: unknown): bigint | undefined => unsigned(value, COINS_MAX);
/** A logical time (u64). */
const u64 = (value: unknown): bigint | undefined => unsigned(value, U64_MAX);

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** A shard id (a signed 64-bit integer) as canonical decimal, however it was written (M5). */
function shardOf(value: unknown): string | undefined {
  const shard = big(value);
  return shard !== undefined && shard >= INT64_MIN && shard <= INT64_MAX
    ? shard.toString()
    : undefined;
}

/** A 32-byte hash given in base64 (toncenter's form) as lower-case hex. */
export function hashHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) return undefined;
  const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return bytes.length === 32 ? bytes.toString('hex') : undefined;
}

/** toncenter v3 writes raw addresses in upper case; the canonical form is lower case. */
export function rawOf(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(0|-1):[0-9a-fA-F]{64}$/.test(value))
    return undefined;
  return value.toLowerCase();
}

/**
 * M2: a lookup that filters its answer by address needs the address's raw form (the
 * codec's canonical form); anything else is refused before any request, never retried as a
 * provider fault.
 */
function rawAddress(address: string): string {
  const raw = rawOf(address);
  if (!raw) {
    throw new ValidationError(
      'INVALID_ADDRESS',
      'a toncenter lookup needs a raw address',
    );
  }
  return raw;
}

// ---- wire types (validated) ---------------------------------------------------------------

export interface BlockId {
  readonly workchain: number;
  /** A signed 64-bit shard id in canonical decimal (the masterchain's: `MASTERCHAIN_SHARD`). */
  readonly shard: string;
  readonly seqno: number;
  /** Lower-case hex. */
  readonly rootHash: string;
  readonly fileHash: string;
}

export interface BlockHeader {
  readonly id: BlockId;
  readonly globalId: number;
  /** Seconds. */
  readonly genUtime: number;
  readonly prev: readonly BlockId[];
}

export type AccountStatus = 'active' | 'uninitialized' | 'frozen';

export interface AccountState {
  readonly balance: bigint;
  readonly status: AccountStatus;
  readonly lastLt: bigint;
  /** Lower-case hex; all zeros for an account that never had a transaction. */
  readonly lastHash: string;
  /** The masterchain block the state was read at. */
  readonly blockSeqno: number;
  /** That block's full id (F6-R21 M7): a proof binds the state to the block it asked for. */
  readonly block: BlockId;
  /** The state's time (seconds): the chain's `now` for the next message. */
  readonly syncUtime: number;
}

export type StackEntry =
  | { readonly type: 'num'; readonly value: bigint }
  /** A cell or slice (base64 BOC), within one message's limits (lesson 20). */
  | { readonly type: 'cell'; readonly boc: string }
  | { readonly type: 'other' };

export interface RunResult {
  readonly exitCode: number;
  readonly stack: readonly StackEntry[];
}

/** A transaction's id: its logical time and hash (lower-case hex). */
export interface TransactionId {
  readonly lt: bigint;
  readonly hash: string;
}

/**
 * A get-method's result with what it was run on (F6-R21 I2): the masterchain block and the
 * account's last transaction there, as live toncenter answers name them.
 */
export interface BoundRunResult extends RunResult {
  readonly block: BlockId;
  readonly lastTransaction: TransactionId;
}

/**
 * One transaction as the liteserver serves it (v2 `getTransactions`): its id and its raw
 * cell (base64 BOC, within an account state's limits, lesson 20), which a caller hashes
 * itself: only a cell whose hash is the id it expects authenticates anything (F6-R21).
 */
export interface RawTransaction {
  readonly lt: bigint;
  readonly hash: string;
  readonly boc: string;
}

/** toncenter v3's account statuses (`orig_status`, `end_status`). */
export type V3AccountStatus = 'nonexist' | 'uninit' | 'active' | 'frozen';

export interface SourceFees {
  readonly importFee: bigint;
  readonly storageFee: bigint;
  readonly gasFee: bigint;
  readonly forwardFee: bigint;
}

export interface SentMessage {
  readonly hash: string;
  readonly hashNorm: string;
}

export interface V3Message {
  readonly hash: string;
  readonly hashNorm?: string;
  readonly source: string | null;
  readonly destination: string | null;
  readonly value: bigint | null;
  readonly bounce: boolean | null;
  readonly bounced: boolean | null;
  /** Body hash (hex) and body (base64 BOC), when the indexer has them. */
  readonly bodyHash?: string;
  readonly body?: string;
}

export interface V3Transaction {
  readonly hash: string;
  readonly lt: bigint;
  readonly account: string;
  readonly now: number;
  readonly mcSeqno: number;
  /** The trace's id (its root transaction's hash), lower-case hex. */
  readonly traceId: string;
  readonly totalFees: bigint;
  readonly aborted: boolean;
  /**
   * The compute phase. A skipped one is `{ skipped: true, success: false }`, and so is the
   * missing phase of a transaction type that has none (storage, split, merge).
   */
  readonly compute: {
    readonly skipped: boolean;
    readonly success: boolean;
    readonly exitCode?: number;
  };
  readonly action?: {
    readonly success: boolean;
    readonly resultCode: number;
    readonly skippedActions: number;
    readonly msgsCreated: number;
  };
  /** The bounce phase's type (`ok`, `nofunds`, `negfunds`), when there was one. */
  readonly bounce?: string;
  /** The account's status before and after, when the indexer writes them (F6-R21). */
  readonly origStatus?: V3AccountStatus;
  readonly endStatus?: V3AccountStatus;
  readonly inMsg: V3Message | null;
  readonly outMsgs: readonly V3Message[];
}

export interface V3Trace {
  /** Lower-case hex. */
  readonly traceId: string;
  readonly complete: boolean;
  readonly transactions: readonly V3Transaction[];
}

/** One page of an account's history, newest first. */
export interface TransactionPage {
  /** The page's committed transactions (not yet finalized ones are left out). */
  readonly transactions: V3Transaction[];
  /**
   * The `endLt` of the next page, when the indexer's page was full. F6-R12: counted on the
   * page as the indexer served it, before the transactions not yet final were left out, so
   * a pager never stops early and never skips an older final transaction.
   */
  readonly next?: bigint;
}

/** A jetton master's TEP-64 content cell, as `get_jetton_data` returns it (entry 3). */
export type JettonContentCell =
  | { readonly kind: 'cell'; readonly boc: string }
  /** Beyond one message's limits (lesson 20): never decoded. */
  | { readonly kind: 'oversized' };

export interface JettonData {
  readonly exitCode: number;
  /** Absent when the get-method failed or its fourth entry is not a cell. */
  readonly content?: JettonContentCell;
}

/**
 * A token's metadata as the indexer fetched it (for a jetton: its off-chain JSON). `null`
 * marks a field the token's metadata holds but that is not one (ill-typed, out of range or
 * over its limit): the token's own data, which every endpoint agrees on, for the caller to
 * judge only if it uses that field (F6-R13).
 */
export interface TokenInfo {
  readonly symbol?: string | null;
  /** 0..255, in decimal. */
  readonly decimals?: string | null;
  readonly name?: string;
}

// ---- parsers ------------------------------------------------------------------------------
// Lesson 6, sharpened: a field a verdict reads is required, or optional and then well
// typed; a missing or ill-typed one is malformed (retryable), never `false` or `0`. Every
// endpoint running the same indexer would agree on a drifted answer, so a quorum does not
// catch what the parser lets through.

function blockIdOf(value: unknown, route: string): BlockId {
  const v = need(record(value), route);
  return {
    workchain: need(int(v.workchain), route),
    shard: need(shardOf(v.shard), route),
    seqno: need(int(v.seqno), route),
    rootHash: need(hashHex(v.root_hash), route),
    fileHash: need(hashHex(v.file_hash), route),
  };
}

function v2Result(body: unknown, route: string): unknown {
  if (!isRecord(body) || body.ok !== true || !('result' in body)) throw malformed(route);
  return body.result;
}

/** A cell's base64 BOC, within one message's limits (M4, lesson 20). */
function cellOf(value: unknown, route: string): string {
  const boc = need(str(value), route);
  if (!bocWithinLimits(boc)) throw malformed(route);
  return boc;
}

function stackOf(value: unknown, route: string): StackEntry[] {
  if (!Array.isArray(value)) throw malformed(route);
  return value.map((entry): StackEntry => {
    if (!Array.isArray(entry) || entry.length !== 2) throw malformed(route);
    const [type, data] = entry as [unknown, unknown];
    if (type === 'num') {
      const text = need(str(data), route);
      const negative = text.startsWith('-');
      const digits = negative ? text.slice(1) : text;
      // Lesson 20: a TVM integer has 257 bits (65 hex digits); bounded before `BigInt`.
      if (!/^0x[0-9a-fA-F]{1,80}$/.test(digits)) throw malformed(route);
      const value = BigInt(digits);
      return { type: 'num', value: negative ? -value : value };
    }
    if (
      type === 'cell' ||
      type === 'slice' ||
      type === 'tvm.Cell' ||
      type === 'tvm.Slice'
    ) {
      return { type: 'cell', boc: cellOf(isRecord(data) ? data.bytes : data, route) };
    }
    return { type: 'other' };
  });
}

function messageOf(value: unknown, route: string): V3Message {
  const m = need(record(value), route);
  const content = optional(m.message_content, record, route);
  const source = rawOf(m.source ?? null);
  const destination = rawOf(m.destination ?? null);
  if (source === undefined || destination === undefined) throw malformed(route);
  const hashNorm = optional(m.hash_norm, hashHex, route);
  const bodyHash = content ? optional(content.hash, hashHex, route) : undefined;
  const body = content ? optional(content.body, str, route) : undefined;
  return {
    hash: need(hashHex(m.hash), route),
    ...(hashNorm !== undefined ? { hashNorm } : {}),
    source,
    destination,
    value: optional(m.value, coins, route) ?? null,
    bounce: optional(m.bounce, bool, route) ?? null,
    bounced: optional(m.bounced, bool, route) ?? null,
    ...(bodyHash !== undefined ? { bodyHash } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

/** Transaction types with a compute phase (block.tlb `trans_ord`, `trans_tick_tock`). */
const COMPUTING: ReadonlySet<string> = new Set(['ord', 'tick_tock']);
/** Bounce phase types (block.tlb `tr_phase_bounce_ok`, `_nofunds`, `_negfunds`). */
const BOUNCES: ReadonlySet<string> = new Set(['ok', 'nofunds', 'negfunds']);

/** I1: the compute phase; an ord or tick-tock transaction always has one. */
function computeOf(d: Json, route: string): V3Transaction['compute'] {
  const type = need(str(d.type), route);
  if (d.compute_ph === undefined || d.compute_ph === null) {
    if (COMPUTING.has(type)) throw malformed(route);
    return { skipped: true, success: false };
  }
  const c = need(record(d.compute_ph), route);
  const skipped = need(bool(c.skipped), route);
  // A skipped phase (`tr_phase_compute_skipped`) carries only its reason.
  const success = skipped
    ? (optional(c.success, bool, route) ?? false)
    : need(bool(c.success), route);
  const exitCode = optional(c.exit_code, int, route);
  return { skipped, success, ...(exitCode !== undefined ? { exitCode } : {}) };
}

/** I1: the action phase, when there was one, with every field a verdict reads. */
function actionOf(value: unknown, route: string): V3Transaction['action'] {
  const a = optional(value, record, route);
  if (!a) return undefined;
  return {
    success: need(bool(a.success), route),
    resultCode: need(int(a.result_code), route),
    skippedActions: need(int(a.skipped_actions), route),
    msgsCreated: need(int(a.msgs_created), route),
  };
}

/** M4: the bounce phase's type, one of block.tlb's three. */
function bounceOf(value: unknown, route: string): string | undefined {
  const b = optional(value, record, route);
  if (!b) return undefined;
  const type = need(str(b.type), route);
  if (!BOUNCES.has(type)) throw malformed(route);
  return type;
}

const V3_STATUSES: ReadonlySet<unknown> = new Set([
  'nonexist',
  'uninit',
  'active',
  'frozen',
]);

/** A v3 account status: one of the four (lesson 6: well typed when present). */
const accountStatus = (value: unknown): V3AccountStatus | undefined =>
  V3_STATUSES.has(value) ? (value as V3AccountStatus) : undefined;

export function transactionOf(value: unknown, route: string): V3Transaction {
  const t = need(record(value), route);
  const d = need(record(t.description), route);
  const action = actionOf(d.action, route);
  const bounce = bounceOf(d.bounce, route);
  const origStatus = optional(t.orig_status, accountStatus, route);
  const endStatus = optional(t.end_status, accountStatus, route);
  return {
    hash: need(hashHex(t.hash), route),
    lt: need(u64(t.lt), route),
    account: need(rawOf(t.account) ?? undefined, route),
    now: need(int(t.now), route),
    mcSeqno: need(int(t.mc_block_seqno), route),
    traceId: need(hashHex(t.trace_id), route),
    totalFees: need(coins(t.total_fees), route),
    aborted: need(bool(d.aborted), route),
    compute: computeOf(d, route),
    ...(action ? { action } : {}),
    ...(bounce !== undefined ? { bounce } : {}),
    ...(origStatus !== undefined ? { origStatus } : {}),
    ...(endStatus !== undefined ? { endStatus } : {}),
    inMsg:
      t.in_msg === null || t.in_msg === undefined ? null : messageOf(t.in_msg, route),
    outMsgs: need(Array.isArray(t.out_msgs) ? t.out_msgs : undefined, route).map((m) =>
      messageOf(m, route),
    ),
  };
}

/**
 * Whether a v3 `finality` is the masterchain's: live answers name the state (`finalized`),
 * the swagger declares an int enum (0 pending, 1 confirmed, 2 finalized). An indexer that
 * writes none is read as before: every transaction still needs its masterchain block.
 */
function finalized(f: unknown): boolean {
  return f === undefined || f === null || f === 'finalized' || f === 2;
}

/**
 * Only chain evidence counts: an emulated (pending) transaction is toncenter's guess, and
 * one not yet `finalized` (a shard block the masterchain has not committed) is not final;
 * either reads as "not yet" (lesson 16), and a trace holding one is incomplete.
 */
const committed = (value: unknown): boolean =>
  !(isRecord(value) && (value.emulated === true || !finalized(value.finality)));

/**
 * A v3 transaction list, emulated or not yet finalized ones dropped; more than `limit`
 * items is malformed (M3).
 */
function transactionsOf(body: unknown, route: string, limit: number): V3Transaction[] {
  if (
    !isRecord(body) ||
    !Array.isArray(body.transactions) ||
    body.transactions.length > limit
  ) {
    throw malformed(route);
  }
  return body.transactions.filter(committed).map((t) => transactionOf(t, route));
}

/** A block header, parsed. */
function headerOf(result: unknown, route: string): BlockHeader {
  const h = need(record(result), route);
  return {
    id: blockIdOf(h.id, route),
    globalId: need(int(h.global_id), route),
    genUtime: need(int(h.gen_utime), route),
    prev: Array.isArray(h.prev_blocks)
      ? h.prev_blocks.map((p) => blockIdOf(p, route))
      : [],
  };
}

/** The newest masterchain block a `getMasterchainInfo` result names. */
function lastOf(result: unknown, route: string): BlockId {
  return blockIdOf(need(isRecord(result) ? result.last : undefined, route), route);
}

/** An account state, parsed. */
function accountOf(result: unknown, route: string): AccountState {
  const r = need(record(result), route);
  const state = r.state;
  const status: AccountStatus | undefined =
    state === 'active' || state === 'frozen'
      ? state
      : state === 'uninitialized' || state === 'uninit' || state === 'nonexist'
        ? 'uninitialized'
        : undefined;
  const last = transactionIdOf(r.last_transaction_id, route);
  const block = blockIdOf(r.block_id, route);
  return {
    balance: need(coins(r.balance), route),
    status: need(status, route),
    lastLt: last.lt,
    lastHash: last.hash,
    blockSeqno: block.seqno,
    block,
    syncUtime: need(int(r.sync_utime), route),
  };
}

/** A v2 `internal.transactionId`: lt and hash. */
function transactionIdOf(value: unknown, route: string): TransactionId {
  const id = need(record(value), route);
  return { lt: need(u64(id.lt), route), hash: need(hashHex(id.hash), route) };
}

function runOf(result: unknown, route: string): RunResult {
  if (!isRecord(result)) throw malformed(route);
  return {
    exitCode: need(int(result.exit_code), route),
    stack: stackOf(result.stack, route),
  };
}

/** A v2 `runGetMethod` answer body, parsed; for callers' quorum predicates (lesson 17). */
export function runResultOf(body: unknown): RunResult {
  return runOf(v2Result(body, '/runGetMethod'), '/runGetMethod');
}

/** A get-method's result with its block and the account's last transaction (I2). */
function boundRunOf(result: unknown, route: string): BoundRunResult {
  const r = need(record(result), route);
  return {
    ...runOf(result, route),
    block: blockIdOf(r.block_id, route),
    lastTransaction: transactionIdOf(r.last_transaction_id, route),
  };
}

/** A v2 `runGetMethod` answer body with its binding, parsed; for callers' quorum keys. */
export function boundRunResultOf(body: unknown): BoundRunResult {
  return boundRunOf(v2Result(body, '/runGetMethod'), '/runGetMethod');
}

/**
 * A v2 `getTransactions` result: at most `limit` rows, each with its id and a raw cell
 * within an account state's limits, checked in the BOC header before anyone decodes it
 * (lesson 20). What the rows are is for the caller to prove by their hashes.
 */
function rawTransactionsOf(
  result: unknown,
  route: string,
  limit: number,
): RawTransaction[] {
  if (!Array.isArray(result) || result.length > limit) throw malformed(route);
  return result.map((item): RawTransaction => {
    const row = need(record(item), route);
    const { lt, hash } = transactionIdOf(row.transaction_id, route);
    const boc = need(str(row.data), route);
    if (bocSize(boc, MAX_STATE_CELLS, MAX_STATE_BOC_LENGTH) !== 'ok')
      throw malformed(route);
    return { lt, hash, boc };
  });
}

/**
 * `get_jetton_data`'s exit code and content cell (TEP-74: total supply, mintable, admin,
 * content, wallet code). Only the content is read, so no other entry (a supply, a large
 * wallet code) is held to anything. A content cell beyond an account state's limits
 * (`MAX_STATE_CELLS`, `MAX_STATE_BOC_LENGTH`) is reported `oversized`, never decoded
 * (lesson 20): no chain content is that large, and a caller that agrees on it under the
 * proof quorum takes it as the token's own (lesson 13), not as an answer to retry forever.
 * A stack that is not one, or a content entry without a BOC header, is malformed.
 */
function jettonDataFrom(result: unknown, route: string): JettonData {
  const r = need(record(result), route);
  const exitCode = need(int(r.exit_code), route);
  const stack = need(Array.isArray(r.stack) ? r.stack : undefined, route);
  if (exitCode !== 0) return { exitCode };
  const entry: unknown = stack[3];
  if (entry === undefined) return { exitCode };
  if (!Array.isArray(entry) || entry.length !== 2) throw malformed(route);
  const [type, data] = entry as [unknown, unknown];
  if (
    type !== 'cell' &&
    type !== 'slice' &&
    type !== 'tvm.Cell' &&
    type !== 'tvm.Slice'
  ) {
    return { exitCode };
  }
  const boc = need(str(isRecord(data) ? data.bytes : data), route);
  const size = bocSize(boc, MAX_STATE_CELLS, MAX_STATE_BOC_LENGTH);
  if (size === 'malformed') throw malformed(route);
  return {
    exitCode,
    content: size === 'oversized' ? { kind: 'oversized' } : { kind: 'cell', boc },
  };
}

/** A v2 `get_jetton_data` answer body, parsed; for callers' quorum keys (lesson 2). */
export function jettonDataOf(body: unknown): JettonData {
  return jettonDataFrom(v2Result(body, '/runGetMethod'), '/runGetMethod');
}

/**
 * A trace, parsed: its transactions in trace order, each listed once under its own hash
 * (a transaction counted twice would count its transfer twice). An emulated or not yet
 * finalized one is left out and leaves the trace incomplete.
 */
function traceOf(value: unknown, route: string): V3Trace {
  const t = need(record(value), route);
  const info = isRecord(t.trace_info) ? t.trace_info : {};
  const txs = need(record(t.transactions), route);
  const order = need(
    Array.isArray(t.transactions_order) ? t.transactions_order : undefined,
    route,
  );
  const listed = new Set<string>();
  const entries = order.map((item) => {
    const key = need(str(item), route);
    const hash = need(hashHex(key), route);
    if (listed.has(hash) || !Object.hasOwn(txs, key)) throw malformed(route);
    listed.add(hash);
    const value = txs[key];
    if (!committed(value)) return undefined;
    const tx = transactionOf(value, route);
    if (tx.hash !== hash) throw malformed(route);
    return tx;
  });
  return {
    traceId: need(hashHex(t.trace_id), route),
    complete:
      t.is_incomplete === false &&
      info.trace_state === 'complete' &&
      entries.every((tx) => tx !== undefined),
    transactions: entries.filter((tx): tx is V3Transaction => tx !== undefined),
  };
}

/**
 * M4, F6-R8 and F6-R13: one `/metadata` token entry, the indexer's copy of the token's
 * off-chain JSON. Only the fields a caller may use are read, and each as the token wrote it:
 * a symbol or decimals that are not one are `null` (the token's own data, which every
 * endpoint agrees on, so never malformed and retried forever); a name beyond its limit is
 * absent. toncenter writes the JSON's decimals under `extra` (live, 2026-09-28).
 */
function tokenInfoOf(token: Json): TokenInfo {
  const info: { symbol?: string | null; decimals?: string | null; name?: string } = {};
  const { symbol, name, extra } = token;
  if (symbol !== undefined && symbol !== null) {
    info.symbol =
      typeof symbol === 'string' && symbol.length <= CONTENT_LIMITS.symbol
        ? symbol
        : null;
  }
  if (typeof name === 'string' && name.length <= CONTENT_LIMITS.name) info.name = name;
  if (extra !== undefined && extra !== null) {
    const decimals = isRecord(extra) ? extra.decimals : null;
    const value = int(decimals);
    if (!isRecord(extra)) info.decimals = null;
    else if (decimals !== undefined && decimals !== null) {
      info.decimals =
        value !== undefined && value >= 0 && value <= 255 ? String(value) : null;
    }
  }
  return info;
}

// ---- quorum facts (lesson 2) ---------------------------------------------------------------
// Each method's key is its parsed value (M5, M6): honest endpoints that format a fact
// differently (a number or a string, `uninit` or `uninitialized`, v2's `@extra`) agree, and
// a key that throws is a disagreement. A key covers every field a verdict reads (C1);
// message bodies are left out (their serialization varies) and are bound to the keyed body
// hash where they are decoded (`messageBody`). The transport compares keys as canonical
// JSON, bigints included.

/** Every fact of a transaction a verdict or a decoding reads, bodies as their hashes. */
function factsOf(tx: V3Transaction): unknown {
  const { inMsg, outMsgs, ...facts } = tx;
  const message = (m: V3Message | null) => {
    if (!m) return null;
    const { body: _body, ...rest } = m;
    return rest;
  };
  return { ...facts, inMsg: message(inMsg), outMsgs: outMsgs.map(message) };
}

/** A trace's id, completeness and every transaction's facts, in trace order (C1). */
function traceFacts(trace: V3Trace | null): unknown {
  return trace && { ...trace, transactions: trace.transactions.map(factsOf) };
}

// ---- the client ---------------------------------------------------------------------------

/** Validates an answer body; `route` labels a malformed one. */
type Parse<T> = (body: unknown, route: string) => T;

const itself = (value: unknown): unknown => value;

/** The most transactions a message hash can name (a few forks of one external, retried). */
const BY_MESSAGE_LIMIT = 8;

export class TonApi {
  constructor(
    private readonly rpc: Transport,
    private readonly indexer: Transport,
  ) {}

  /** The rpc transport's lag tolerance (R36: the pool resolves it); proofs' last skew. */
  get lagTolerance(): number {
    return this.rpc.maxLagBlocks;
  }

  async #call(
    transport: Transport,
    request: HttpRequest,
    tags: TonCallTags,
    quorumKey: (result: unknown) => unknown,
  ): Promise<unknown> {
    // The caller's key (a predicate, lesson 17) replaces the call's consensus facts.
    const key = tags.quorumKey ?? quorumKey;
    const options: CallOptions = {
      ...tags,
      exactIntegers: true,
      ...(tags.quorum !== undefined ? { quorumKey: key } : {}),
    };
    try {
      return await transport.http<unknown>(request, options);
    } catch (error) {
      // M2 and lesson 18 (widened): on a proof or monitor read, any definitive RPC error,
      // whatever its text (a block the endpoint does not hold yet, pruned state, a provider
      // that answers 4xx rather than toncenter's 500), decides nothing. TON's negatives come
      // only from attested state (D12), never from an error, so no error text is read here.
      // A misconfigured endpoint (`PROVIDER_MISCONFIGURED`) still surfaces as the
      // configuration error it is.
      if (
        (tags.purpose === 'proof' || tags.purpose === 'monitor') &&
        isCryptoAioError(error, 'RPC_ERROR') &&
        !error.retryable
      ) {
        throw new ProviderError(
          'PROVIDER_UNAVAILABLE',
          `${request.route ?? 'a state read'} was refused; deciding nothing`,
          { retryable: true, cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * One request whose answer `parse` validates (lesson 6). Under a quorum, each endpoint's
   * answer is keyed on `facts` of its parsed value: the fields a verdict reads, never the
   * envelope (lesson 2, M5, M6).
   */
  async #read<T>(
    transport: Transport,
    request: HttpRequest & { readonly route: string },
    tags: TonCallTags,
    parse: Parse<T>,
    facts: (value: T) => unknown = itself,
  ): Promise<T> {
    const body = await this.#call(transport, request, tags, (answer) =>
      facts(parse(answer, 'quorum')),
    );
    return parse(body, request.route);
  }

  #v2<T>(
    route: string,
    query: Record<string, string>,
    tags: TonCallTags,
    parse: Parse<T>,
    facts?: (value: T) => unknown,
  ): Promise<T> {
    return this.#read(
      this.rpc,
      { method: 'GET', path: route, query, route },
      tags,
      (body, label) => parse(v2Result(body, label), label),
      facts,
    );
  }

  #v2Post<T>(
    route: string,
    body: Json,
    tags: TonCallTags,
    parse: Parse<T>,
    facts?: (value: T) => unknown,
  ): Promise<T> {
    return this.#read(
      this.rpc,
      { method: 'POST', path: route, body, route },
      tags,
      (answer, label) => parse(v2Result(answer, label), label),
      facts,
    );
  }

  #v3<T>(
    route: string,
    query: Record<string, string>,
    tags: TonCallTags,
    parse: Parse<T>,
    facts?: (value: T) => unknown,
  ): Promise<T> {
    return this.#read(
      this.indexer,
      { method: 'GET', path: route, query, route },
      tags,
      parse,
      facts,
    );
  }

  /** The newest masterchain block the liteserver knows. */
  masterchainHead(tags: TonCallTags): Promise<number> {
    return this.#v2(
      '/getMasterchainInfo',
      {},
      tags,
      (result, route) => lastOf(result, route).seqno,
    );
  }

  /**
   * Whether the liteserver holds masterchain block `seqno` (every masterchain block is
   * final once it exists). Under a quorum the key is this predicate (lesson 17): endpoints
   * past `seqno` agree whatever their heads.
   */
  reachedMasterchain(seqno: number, tags: TonCallTags): Promise<boolean> {
    return this.#v2(
      '/getMasterchainInfo',
      {},
      tags,
      (result, route) => lastOf(result, route).seqno >= seqno,
    );
  }

  /** A block's header; `seqno` above the endpoint's head fails (retryable). */
  blockHeader(
    block: { readonly workchain: number; readonly shard: string; readonly seqno: number },
    tags: TonCallTags,
  ): Promise<BlockHeader> {
    return this.#v2(
      '/getBlockHeader',
      {
        workchain: String(block.workchain),
        shard: block.shard,
        seqno: String(block.seqno),
      },
      tags,
      headerOf,
      // The facts a proof reads; `prev_blocks` only feeds `getBlock`'s parent hash (a `read`).
      ({ prev: _prev, ...facts }) => facts,
    );
  }

  masterchainHeader(seqno: number, tags: TonCallTags): Promise<BlockHeader> {
    return this.blockHeader({ workchain: -1, shard: MASTERCHAIN_SHARD, seqno }, tags);
  }

  /** The shard blocks masterchain block `seqno` commits. */
  shards(seqno: number, tags: TonCallTags): Promise<BlockId[]> {
    return this.#v2('/getShards', { seqno: String(seqno) }, tags, (result, route) =>
      need(
        isRecord(result) && Array.isArray(result.shards) ? result.shards : undefined,
        route,
      ).map((s) => blockIdOf(s, route)),
    );
  }

  /** A config param's cell (base64 BOC, within one message's limits). */
  configParam(param: number, tags: TonCallTags, seqno?: number): Promise<string> {
    return this.#v2(
      '/getConfigParam',
      {
        param: String(param),
        ...(seqno !== undefined ? { seqno: String(seqno) } : {}),
      },
      tags,
      (result, route) =>
        cellOf(
          need(isRecord(result) ? record(result.config) : undefined, route).bytes,
          route,
        ),
    );
  }

  /** An account's state, at masterchain block `seqno` when given. */
  account(address: string, tags: TonCallTags, seqno?: number): Promise<AccountState> {
    return this.#v2(
      '/getAddressInformation',
      { address, ...(seqno !== undefined ? { seqno: String(seqno) } : {}) },
      tags,
      accountOf,
      // `sync_utime` is when the endpoint answered, not a fact of the state at that block.
      ({ syncUtime: _syncUtime, ...facts }) => facts,
    );
  }

  /** A get-method, at masterchain block `seqno` when given. */
  runGetMethod(
    address: string,
    method: string,
    stack: readonly (readonly [string, string])[],
    tags: TonCallTags,
    seqno?: number,
  ): Promise<RunResult> {
    return this.#v2Post(
      '/runGetMethod',
      { address, method, stack, ...(seqno !== undefined ? { seqno } : {}) },
      tags,
      runOf,
    );
  }

  /**
   * A get-method at masterchain block `seqno`, with the block and the account's last
   * transaction the answer names (F6-R21 I2): a caller binds the result to the state it
   * read, since an endpoint that drops the block answers at its own latest state.
   */
  runGetMethodAt(
    address: string,
    method: string,
    stack: readonly (readonly [string, string])[],
    tags: TonCallTags,
    seqno: number,
  ): Promise<BoundRunResult> {
    return this.#v2Post(
      '/runGetMethod',
      { address, method, stack, seqno },
      tags,
      boundRunOf,
    );
  }

  /**
   * Up to `limit` of an account's transactions (a raw address, M2) from `from` back, as the
   * liteserver serves them (v2 `getTransactions`), each with its raw cell. Under a quorum
   * the endpoints agree on the ids; the cells are the caller's to hash (F6-R21).
   */
  async rawTransactions(
    address: string,
    from: TransactionId,
    limit: number,
    tags: TonCallTags,
  ): Promise<RawTransaction[]> {
    rawAddress(address);
    return this.#v2(
      '/getTransactions',
      { address, lt: from.lt.toString(), hash: from.hash, limit: String(limit) },
      tags,
      (result, route) => rawTransactionsOf(result, route, limit),
      (rows) => rows.map(({ lt, hash }) => ({ lt, hash })),
    );
  }

  /** A jetton master's `get_jetton_data`: its exit code and content cell (`jettonDataOf`). */
  jettonData(master: string, tags: TonCallTags, seqno?: number): Promise<JettonData> {
    return this.#v2Post(
      '/runGetMethod',
      {
        address: master,
        method: 'get_jetton_data',
        stack: [],
        ...(seqno !== undefined ? { seqno } : {}),
      },
      tags,
      jettonDataFrom,
    );
  }

  /** The emulated source fees of an external message body (signature check skipped). */
  estimateFee(
    request: {
      readonly address: string;
      readonly body: string;
      readonly initCode?: string;
      readonly initData?: string;
    },
    tags: TonCallTags,
  ): Promise<SourceFees> {
    return this.#v2Post(
      '/estimateFee',
      {
        address: request.address,
        body: request.body,
        init_code: request.initCode ?? '',
        init_data: request.initData ?? '',
        ignore_chksig: true,
      },
      tags,
      (result, route): SourceFees => {
        // toncenter writes these fees as JSON numbers: read exactly (A12), as coins (M1).
        const fees = need(
          isRecord(result) ? record(result.source_fees) : undefined,
          route,
        );
        return {
          importFee: need(coins(fees.in_fwd_fee), route),
          storageFee: need(coins(fees.storage_fee), route),
          gasFee: need(coins(fees.gas_fee), route),
          forwardFee: need(coins(fees.fwd_fee), route),
        };
      },
    );
  }

  /** Sends an external message; resolves with the node's hashes (hex). */
  send(boc: string, tags: TonCallTags): Promise<SentMessage> {
    return this.#v2Post('/sendBocReturnHash', { boc }, tags, (result, route) => {
      const r = need(record(result), route);
      return {
        hash: need(hashHex(r.hash), route),
        hashNorm: need(hashHex(r.hash_norm), route),
      };
    });
  }

  /** The indexer's newest indexed masterchain block and the network's global id. */
  indexerHead(
    tags: TonCallTags,
  ): Promise<{ readonly seqno: number; readonly globalId: number }> {
    return this.#v3('/masterchainInfo', {}, tags, (body, route) => {
      const last = need(isRecord(body) ? record(body.last) : undefined, route);
      return {
        seqno: need(int(last.seqno), route),
        globalId: need(int(last.global_id), route),
      };
    });
  }

  /**
   * Whether the indexer has indexed masterchain block `seqno`. Under a quorum the key is
   * this predicate (lesson 17): indexers past `seqno` agree whatever their heads.
   */
  indexerReached(seqno: number, tags: TonCallTags): Promise<boolean> {
    return this.#v3('/masterchainInfo', {}, tags, (body, route) => {
      const last = need(isRecord(body) ? record(body.last) : undefined, route);
      return need(int(last.seqno), route) >= seqno;
    });
  }

  /** The seqno of the masterchain block with this root hash (hex); null if unknown. */
  masterchainSeqnoOf(rootHash: string, tags: TonCallTags): Promise<number | null> {
    const wanted = hashHex(rootHash);
    return this.#v3(
      '/blocks',
      { workchain: '-1', root_hash: rootHash, limit: '1' },
      tags,
      (body, route) => {
        if (!isRecord(body) || !Array.isArray(body.blocks) || body.blocks.length > 1) {
          throw malformed(route);
        }
        for (const item of body.blocks) {
          const block = need(record(item), route);
          const workchain = need(int(block.workchain), route);
          // A lookup by id keeps only the block asked for (I2).
          if (workchain === -1 && need(hashHex(block.root_hash), route) === wanted) {
            return need(int(block.seqno), route);
          }
        }
        return null;
      },
    );
  }

  /**
   * Committed transactions whose inbound message has this raw or normalized hash (hex).
   * I2: only those; a dropped filter's strangers read as "none yet".
   */
  transactionsByMessage(hash: string, tags: TonCallTags): Promise<V3Transaction[]> {
    const wanted = hashHex(hash);
    return this.#v3(
      '/transactionsByMessage',
      { msg_hash: hash, direction: 'in', limit: String(BY_MESSAGE_LIMIT) },
      tags,
      (body, route) =>
        transactionsOf(body, route, BY_MESSAGE_LIMIT).filter(
          (tx) =>
            wanted !== undefined &&
            tx.inMsg !== null &&
            (tx.inMsg.hash === wanted || tx.inMsg.hashNorm === wanted),
        ),
      (txs) => txs.map(factsOf),
    );
  }

  /** The committed transaction with this hash; null when the indexer has none (yet). */
  transaction(hash: string, tags: TonCallTags): Promise<V3Transaction | null> {
    const wanted = hashHex(hash);
    return this.#v3(
      '/transactions',
      { hash, limit: '1' },
      tags,
      (body, route) =>
        transactionsOf(body, route, 1).find((tx) => tx.hash === wanted) ?? null,
      (tx) => (tx ? factsOf(tx) : null),
    );
  }

  /**
   * One page of an account's transactions (a raw address, M2), newest first, at or below
   * `endLt` when given, with the next page's `endLt` when this one was full. An answer that
   * breaks the query (another account, an lt out of order or above `endLt`, more than
   * `limit`), counting the transactions not yet final, is malformed: a verdict reads it as
   * the account's history. F6-R12: `next` comes from the page as served, so a page whose
   * newest transactions are not yet final still leads to the older ones.
   */
  async accountTransactionsPage(
    account: string,
    options: { readonly limit: number; readonly endLt?: bigint },
    tags: TonCallTags,
  ): Promise<TransactionPage> {
    const wanted = rawAddress(account);
    return this.#v3(
      '/transactions',
      {
        account,
        limit: String(options.limit),
        sort: 'desc',
        ...(options.endLt !== undefined ? { end_lt: options.endLt.toString() } : {}),
      },
      tags,
      (body, route): TransactionPage => {
        if (
          !isRecord(body) ||
          !Array.isArray(body.transactions) ||
          body.transactions.length > options.limit
        ) {
          throw malformed(route);
        }
        const transactions: V3Transaction[] = [];
        let below = options.endLt === undefined ? undefined : options.endLt + 1n;
        let last: bigint | undefined;
        for (const item of body.transactions) {
          const t = need(record(item), route);
          const lt = need(u64(t.lt), route);
          if (rawOf(t.account) !== wanted || (below !== undefined && lt >= below)) {
            throw malformed(route);
          }
          below = lt;
          last = lt;
          if (committed(item)) transactions.push(transactionOf(item, route));
        }
        const full = body.transactions.length === options.limit;
        return {
          transactions,
          ...(full && last !== undefined && last > 0n ? { next: last - 1n } : {}),
        };
      },
      (page) => ({
        transactions: page.transactions.map(factsOf),
        next: page.next ?? null,
      }),
    );
  }

  /** An account's committed transactions: one page (`accountTransactionsPage`). */
  async accountTransactions(
    account: string,
    options: { readonly limit: number; readonly endLt?: bigint },
    tags: TonCallTags,
  ): Promise<V3Transaction[]> {
    return (await this.accountTransactionsPage(account, options, tags)).transactions;
  }

  /** The trace that holds this transaction; null when the indexer has none (yet). */
  trace(txHash: string, tags: TonCallTags): Promise<V3Trace | null> {
    const wanted = hashHex(txHash);
    return this.#v3(
      '/traces',
      { tx_hash: txHash, include_actions: 'false', limit: '1' },
      tags,
      (body, route) => {
        if (!isRecord(body) || !Array.isArray(body.traces) || body.traces.length > 1) {
          throw malformed(route);
        }
        for (const value of body.traces) {
          const trace = traceOf(value, route);
          // A lookup by id keeps only the trace asked for (I2).
          if (trace.transactions.some((tx) => tx.hash === wanted)) return trace;
        }
        return null;
      },
      traceFacts,
    );
  }

  /**
   * The indexer's metadata for a raw token address (M2): its first valid jetton entry
   * (`tokenInfoOf`). Undefined while the indexer has none: no entry (an unknown address, a
   * lagging index or a dropped filter all read alike, I2), an entry not indexed yet, or no
   * valid metadata fetched (yet), so a caller never takes it for a definitive answer.
   */
  async tokenInfo(address: string, tags: TonCallTags): Promise<TokenInfo | undefined> {
    const wanted = rawAddress(address);
    return this.#v3(
      '/metadata',
      { address },
      tags,
      (body, route) => {
        if (!isRecord(body)) throw malformed(route);
        for (const [key, value] of Object.entries(body)) {
          // The answer is keyed by address; a lookup by id reads only its own entry (I2).
          if (rawOf(key) !== wanted) continue;
          const entry = need(record(value), route);
          if (optional(entry.is_indexed, bool, route) === false) return undefined;
          const info =
            optional(
              entry.token_info,
              (v) => (Array.isArray(v) ? v : undefined),
              route,
            ) ?? [];
          for (const item of info) {
            const token = need(record(item), route);
            const type = optional(token.type, str, route);
            if (
              token.valid === false ||
              (type !== undefined && type !== 'jetton_masters')
            ) {
              continue;
            }
            return tokenInfoOf(token);
          }
        }
        return undefined;
      },
      (info) => info ?? null,
    );
  }
}
