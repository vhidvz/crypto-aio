/**
 * Transaction decoding (spec §6.6, §15): `jsonParsed` transactions, inner instructions
 * included, into `DriverTransaction`s. Decoded transfers are checked against the pre/post
 * lamport and token balances, per account and per mint; any movement they do not explain
 * makes the transaction `decoding: 'partial'`. Locators are `ix:<outer>` and
 * `ix:<outer>.<inner>`.
 *
 * `parseTransaction` validates an answer once. A missing or ill-typed field is a retryable
 * `PROVIDER_UNAVAILABLE`, never a default (lesson 6, sharpened): a truncated or drifted
 * answer never becomes a success or a failure. Every list and text is held to the format's
 * own bound (lesson 20), and account lookups go through one index, so the work stays
 * linear. Nothing here decodes bytes: unparsed instruction data and logs are never read.
 *
 * General decoding reports execution as the chain does (lesson 15). The phantom-success
 * guard (`tokenTransfersLanded`, lesson 7) is applied only on verdict paths.
 */
import type { DriverTransaction, DriverTransfer } from '../../core/driver/types';
import { canonicalJson } from '../../core/util/json';
import {
  MAX_COMPUTE_UNIT_LIMIT,
  MAX_TRANSACTION_SIZE,
  MEMO_PROGRAM,
  MEMO_V1_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  VOTE_PROGRAM,
} from './programs';
import { amountString, inconsistent, malformed, notYet, record, u64 } from './rpc';

type Json = Record<string, unknown>;

/** Account indexes are u8: no transaction names more accounts, loaded ones included. */
const MAX_ACCOUNT_KEYS = 256;
/** The longest base58 text of an address (32 bytes) and of a signature (64 bytes). */
const MAX_ADDRESS_CHARS = 44;
const MAX_SIGNATURE_CHARS = 88;
/**
 * Every outer instruction takes at least 3 bytes of the packet (its program index and its
 * account and data lengths).
 */
const MAX_OUTER_INSTRUCTIONS = Math.floor(MAX_TRANSACTION_SIZE / 3);
/**
 * A generous bound on one instruction's inner instructions that keeps old blocks readable:
 * every CPI costs at least 1,000 compute units, and no instruction ever ran on more than
 * 1.4 M. (Today's runtime also caps a transaction's whole trace at 64.)
 */
const MAX_INNER_INSTRUCTIONS = Number(MAX_COMPUTE_UNIT_LIMIT / 1_000n);
/** A CPI's instruction data is at most 10 KiB (agave `MAX_CPI_INSTRUCTION_DATA_LEN`). */
const MAX_CPI_INSTRUCTION_DATA = 10_240;
/**
 * A real `TransactionError` nests three levels (`{"InstructionError":[0,{"Custom":1}]}`)
 * and holds a few short values: anything far larger is not one.
 */
const MAX_ERROR_DEPTH = 6;
const MAX_ERROR_VALUES = 64;
const MAX_ERROR_TEXT = 256;
/** A `TransactionError` variant name, such as `AccountInUse` or `InstructionError`. */
const ERROR_VARIANT = /^[A-Z][A-Za-z0-9]{0,63}$/;

const TOKEN_PROGRAMS: readonly string[] = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM];

const absent = (value: unknown): value is null | undefined =>
  value === undefined || value === null;

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

function address(value: unknown, what: string): string {
  if (!text(value, MAX_ADDRESS_CHARS)) throw malformed(what);
  return value;
}

const optionalAddress = (value: unknown, what: string): string | undefined =>
  absent(value) ? undefined : address(value, what);

interface Instruction {
  readonly locator: string;
  readonly inner: boolean;
  readonly programId: string;
  readonly type?: string;
  readonly info: Json | null;
  readonly parsedText?: string;
  /** A parsed text (an inner memo) too long for any CPI to carry: not kept. */
  readonly textTooLong?: true;
}

interface TokenBalance {
  readonly mint: string;
  readonly owner?: string;
  /** The program that owns the token account (classic or Token-2022), when reported. */
  readonly programId?: string;
  readonly amount: bigint;
}

/** A parsed transaction's facts, validated once. */
export interface ParsedTransaction {
  /** The first signature: the transaction's id. */
  readonly signature: string;
  readonly keys: readonly string[];
  /** Each account key's position (keys are unique). */
  readonly accountIndex: ReadonlyMap<string, number>;
  /** `null`, or the node's `TransactionError` (a string or a small object). */
  readonly err: unknown;
  readonly fee: bigint;
  readonly preBalances: readonly bigint[];
  readonly postBalances: readonly bigint[];
  readonly preTokens: ReadonlyMap<number, TokenBalance>;
  readonly postTokens: ReadonlyMap<number, TokenBalance>;
  /** Whether the node reported token balances at all (both lists present). */
  readonly tokenBalances: 'present' | 'absent';
  /** Whether the node recorded inner instructions at all. */
  readonly innerInstructions: 'present' | 'absent';
  /** In execution order: each outer instruction, then its inner ones. */
  readonly instructions: readonly Instruction[];
  readonly version: 'legacy' | number;
  readonly slot?: bigint;
  readonly blockTime?: number;
}

/** Whether a node's JSON value stays within `depth` levels and the shared `budget`. */
function bounded(value: unknown, depth: number, budget: { left: number }): boolean {
  if (--budget.left < 0) return false;
  switch (typeof value) {
    case 'number':
    case 'bigint':
    case 'boolean':
      return true;
    case 'string':
      return value.length <= MAX_ERROR_TEXT;
    case 'object': {
      if (value === null) return true;
      if (depth === 0) return false;
      const children: unknown[] = Array.isArray(value) ? value : Object.values(value);
      return children.every((child) => bounded(child, depth - 1, budget));
    }
    default:
      return false;
  }
}

/**
 * `meta.err`: required; `null`, or a `TransactionError`: a unit variant's name
 * (`"AccountInUse"`), or an object with exactly one variant name as its key and a small
 * value (`{"InstructionError":[0,{"Custom":1}]}`). A drifted `{}` or free text is malformed.
 */
function executionError(value: unknown): unknown {
  if (value === null) return null;
  const object = record(value);
  const [variant, ...others] = object ? Object.keys(object) : [];
  const valid =
    typeof value === 'string'
      ? ERROR_VARIANT.test(value)
      : variant !== undefined &&
        others.length === 0 &&
        ERROR_VARIANT.test(variant) &&
        bounded(value, MAX_ERROR_DEPTH, { left: MAX_ERROR_VALUES });
  if (!valid) throw malformed('transaction status');
  return value;
}

/**
 * The deprecated `meta.status` (`{"Ok":null}` or `{"Err":…}`) may be left out; when a node
 * reports it, it must say what `meta.err` says, or the answer drifted.
 */
function checkStatus(status: unknown, err: unknown): void {
  if (absent(status)) return;
  const object = record(status);
  const [variant, ...others] = object ? Object.keys(object) : [];
  const agrees =
    object !== null &&
    others.length === 0 &&
    (err === null
      ? variant === 'Ok' && object.Ok === null
      : variant === 'Err' &&
        canonicalJson(executionError(object.Err)) === canonicalJson(err));
  if (!agrees) throw malformed('transaction status');
}

function tokenBalances(value: unknown, keys: number): Map<number, TokenBalance> {
  if (!Array.isArray(value)) throw malformed('token balances');
  const balances = new Map<number, TokenBalance>();
  for (const entry of value) {
    const balance = record(entry);
    const index = balance?.accountIndex;
    if (
      !balance ||
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= keys ||
      balances.has(index)
    ) {
      throw malformed('token balances');
    }
    const owner = optionalAddress(balance.owner, 'token balances');
    const programId = optionalAddress(balance.programId, 'token balances');
    balances.set(index, {
      mint: address(balance.mint, 'token balances'),
      ...(owner !== undefined ? { owner } : {}),
      ...(programId !== undefined ? { programId } : {}),
      amount: amountString(record(balance.uiTokenAmount)?.amount, 'token amount'),
    });
  }
  return balances;
}

function instruction(value: unknown, locator: string, inner: boolean): Instruction {
  const ix = record(value);
  if (!ix) throw malformed('instruction');
  const programId = address(ix.programId, 'instruction');
  const { parsed } = ix;
  const object = record(parsed);
  if (!absent(parsed) && !object && typeof parsed !== 'string') {
    throw malformed('instruction');
  }
  // A parsed memo is its UTF-8 text. The packet bounds an outer one, so a longer one is
  // malformed. An inner one is a CPI's data, and a reader never refuses what the chain
  // accepts: past the CPI data limit, the text is not kept and the decoding is partial.
  const tooLong =
    typeof parsed === 'string' &&
    parsed.length > (inner ? MAX_CPI_INSTRUCTION_DATA : MAX_TRANSACTION_SIZE);
  if (tooLong && !inner) throw malformed('instruction');
  return {
    locator,
    inner,
    programId,
    ...(typeof object?.type === 'string' ? { type: object.type } : {}),
    info: record(object?.info),
    ...(typeof parsed === 'string'
      ? tooLong
        ? { textTooLong: true as const }
        : { parsedText: parsed }
      : {}),
  };
}

/** Outer instructions, each followed by its inner ones (a group per outer instruction). */
function instructions(outer: readonly unknown[], groups: unknown): Instruction[] {
  if (outer.length > MAX_OUTER_INSTRUCTIONS) throw malformed('instructions');
  const inner = new Map<number, readonly unknown[]>();
  if (!absent(groups)) {
    if (!Array.isArray(groups)) throw malformed('inner instructions');
    for (const group of groups) {
      const g = record(group);
      const index = g?.index;
      if (
        !g ||
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= outer.length ||
        inner.has(index) ||
        !Array.isArray(g.instructions) ||
        g.instructions.length > MAX_INNER_INSTRUCTIONS
      ) {
        throw malformed('inner instructions');
      }
      inner.set(index, g.instructions);
    }
  }
  return outer.flatMap((ix, i) => [
    instruction(ix, `ix:${i}`, false),
    ...(inner.get(i) ?? []).map((child, j) => instruction(child, `ix:${i}.${j}`, true)),
  ]);
}

/**
 * Validates a `jsonParsed` transaction (from `getTransaction` or a block's list). With
 * `signature`, the answer must be that transaction: a lookup answered with another one
 * decides nothing (a retryable "not yet"), never reads as ours.
 */
export function parseTransaction(value: unknown, signature?: string): ParsedTransaction {
  const tx = record(value);
  const meta = record(tx?.meta);
  const transaction = record(tx?.transaction);
  const message = record(transaction?.message);
  if (!tx || !meta || !transaction || !message) throw malformed('transaction');
  const signatures = transaction.signatures;
  const id: unknown = Array.isArray(signatures) ? signatures[0] : undefined;
  if (!text(id, MAX_SIGNATURE_CHARS)) throw malformed('transaction signatures');
  if (signature !== undefined && id !== signature) {
    throw notYet('the transaction asked for');
  }
  const accountKeys = message.accountKeys;
  if (
    !Array.isArray(accountKeys) ||
    accountKeys.length === 0 ||
    accountKeys.length > MAX_ACCOUNT_KEYS
  ) {
    throw malformed('account keys');
  }
  const accountIndex = new Map<string, number>();
  const keys = accountKeys.map((key: unknown, i) => {
    const pubkey = address(record(key)?.pubkey ?? key, 'account keys');
    if (accountIndex.has(pubkey)) throw malformed('account keys');
    accountIndex.set(pubkey, i);
    return pubkey;
  });
  const balances = (field: unknown) => {
    if (!Array.isArray(field) || field.length !== keys.length) {
      throw malformed('balances');
    }
    return field.map((v) => u64(v, 'balance'));
  };
  const { preTokenBalances, postTokenBalances } = meta;
  if (absent(preTokenBalances) !== absent(postTokenBalances)) {
    throw malformed('token balances');
  }
  if (!Array.isArray(message.instructions)) throw malformed('instructions');
  const version =
    tx.version === undefined || tx.version === 'legacy' ? 'legacy' : tx.version;
  if (
    version !== 'legacy' &&
    (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0)
  ) {
    throw malformed('version');
  }
  const err = executionError(meta.err);
  checkStatus(meta.status, err);
  return {
    signature: id,
    keys,
    accountIndex,
    err,
    fee: u64(meta.fee, 'fee'),
    preBalances: balances(meta.preBalances),
    postBalances: balances(meta.postBalances),
    preTokens: absent(preTokenBalances)
      ? new Map()
      : tokenBalances(preTokenBalances, keys.length),
    postTokens: absent(postTokenBalances)
      ? new Map()
      : tokenBalances(postTokenBalances, keys.length),
    tokenBalances: absent(preTokenBalances) ? 'absent' : 'present',
    innerInstructions: absent(meta.innerInstructions) ? 'absent' : 'present',
    instructions: instructions(message.instructions, meta.innerInstructions),
    version,
    ...(tx.slot !== undefined ? { slot: u64(tx.slot, 'slot') } : {}),
    ...(typeof tx.blockTime === 'number' && Number.isSafeInteger(tx.blockTime)
      ? { blockTime: tx.blockTime }
      : {}),
  };
}

interface NativeMove {
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
}

interface TokenMove {
  readonly source: string;
  readonly destination: string;
  readonly authority?: string;
  readonly mint?: string;
  readonly amount: bigint;
}

function nativeMove(ix: Instruction): NativeMove | null {
  if (ix.programId !== SYSTEM_PROGRAM || !ix.info) return null;
  const { info } = ix;
  const to =
    ix.type === 'transfer' || ix.type === 'transferWithSeed'
      ? info.destination
      : ix.type === 'createAccount' || ix.type === 'createAccountWithSeed'
        ? info.newAccount
        : undefined;
  if (to === undefined) return null;
  return {
    from: address(info.source, 'system instruction'),
    to: address(to, 'system instruction'),
    amount: u64(info.lamports, 'lamports'),
  };
}

function tokenMove(ix: Instruction): TokenMove | null {
  if (ix.programId !== TOKEN_PROGRAM || !ix.info) return null;
  if (ix.type !== 'transfer' && ix.type !== 'transferChecked') return null;
  const { info } = ix;
  const authority = optionalAddress(
    info.authority ?? info.multisigAuthority,
    'token instruction',
  );
  const mint = optionalAddress(info.mint, 'token instruction');
  const raw = ix.type === 'transfer' ? info.amount : record(info.tokenAmount)?.amount;
  return {
    source: address(info.source, 'token instruction'),
    destination: address(info.destination, 'token instruction'),
    ...(authority !== undefined ? { authority } : {}),
    ...(mint !== undefined ? { mint } : {}),
    amount: amountString(raw, 'token amount'),
  };
}

/** A parsed memo instruction (its text kept, or too long to keep). */
const isMemo = (ix: Instruction): boolean =>
  (ix.programId === MEMO_PROGRAM || ix.programId === MEMO_V1_PROGRAM) &&
  (ix.parsedText !== undefined || ix.textTooLong === true);

/** A token program ran, or could have: named by an instruction, or keyed for a CPI. */
const tokenProgramKeyed = (tx: ParsedTransaction): boolean =>
  TOKEN_PROGRAMS.some((program) => tx.accountIndex.has(program)) ||
  tx.instructions.some((ix) => TOKEN_PROGRAMS.includes(ix.programId));

const add = (totals: Map<string, bigint>, key: string, amount: bigint): void => {
  totals.set(key, (totals.get(key) ?? 0n) + amount);
};

/** Token amounts moved per account and mint (`<index>:<mint>`), as the balances report. */
function reportedTokenMoves(tx: ParsedTransaction): Map<string, bigint> {
  const moved = new Map<string, bigint>();
  for (const [index, balance] of tx.preTokens) {
    add(moved, `${index}:${balance.mint}`, -balance.amount);
  }
  for (const [index, balance] of tx.postTokens) {
    add(moved, `${index}:${balance.mint}`, balance.amount);
  }
  return moved;
}

function tokensReconcile(
  tx: ParsedTransaction,
  moves: readonly { readonly move: TokenMove; readonly mint: string }[],
): boolean {
  const expected = new Map<string, bigint>();
  for (const { move, mint } of moves) {
    const from = tx.accountIndex.get(move.source);
    const to = tx.accountIndex.get(move.destination);
    if (from === undefined || to === undefined) return false;
    add(expected, `${from}:${mint}`, -move.amount);
    add(expected, `${to}:${mint}`, move.amount);
  }
  const actual = reportedTokenMoves(tx);
  for (const key of new Set([...actual.keys(), ...expected.keys()])) {
    if ((actual.get(key) ?? 0n) !== (expected.get(key) ?? 0n)) return false;
  }
  return true;
}

function lamportsReconcile(tx: ParsedTransaction, moves: readonly NativeMove[]): boolean {
  const expected = new Map<number, bigint>([[0, -tx.fee]]);
  for (const move of moves) {
    const from = tx.accountIndex.get(move.from);
    const to = tx.accountIndex.get(move.to);
    if (from === undefined || to === undefined) return false;
    expected.set(from, (expected.get(from) ?? 0n) - move.amount);
    expected.set(to, (expected.get(to) ?? 0n) + move.amount);
  }
  return tx.keys.every(
    (_, i) =>
      (tx.postBalances[i] as bigint) - (tx.preBalances[i] as bigint) ===
      (expected.get(i) ?? 0n),
  );
}

/**
 * A vote transaction: consensus traffic, moving nothing but its fee (skipped by scans). A
 * vote-program transaction that moves value, such as a vote-account withdrawal, is not one:
 * a scan must still see it (I4).
 */
export const isVote = (tx: ParsedTransaction): boolean =>
  tx.instructions.length > 0 &&
  tx.instructions.every((ix) => ix.programId === VOTE_PROGRAM) &&
  lamportsReconcile(tx, []) &&
  tokensReconcile(tx, []);

const tokenAt = (tx: ParsedTransaction, address: string) => {
  const index = tx.accountIndex.get(address);
  return index === undefined
    ? {}
    : { pre: tx.preTokens.get(index), post: tx.postTokens.get(index) };
};

const ownerOf = (tx: ParsedTransaction, address: string): string | undefined => {
  const { pre, post } = tokenAt(tx, address);
  return post?.owner ?? pre?.owner;
};

const mintOf = (tx: ParsedTransaction, move: TokenMove): string | undefined => {
  if (move.mint !== undefined) return move.mint;
  for (const address of [move.source, move.destination]) {
    const { pre, post } = tokenAt(tx, address);
    const mint = post?.mint ?? pre?.mint;
    if (mint !== undefined) return mint;
  }
  return undefined;
};

/** Where a transaction sits: the block's dense height and hash (never the slot). */
export interface BlockPlace {
  readonly height: bigint;
  readonly hash: string;
  readonly blockTime?: number;
}

/** Decodes a parsed transaction as the chain reports it (lesson 15). */
export function decodeTransaction(
  tx: ParsedTransaction,
  place: BlockPlace,
): DriverTransaction {
  const success = tx.err === null;
  const memos = tx.instructions.filter(isMemo);
  // The one memo, when its text was kept.
  const memo = memos.length === 1 ? memos[0]?.parsedText : undefined;
  // A failed transaction moved nothing but its fee. A successful one can be checked only
  // with its inner instructions, and with its token balances when a token program ran. A
  // text too long to keep is unexplained too.
  let complete =
    (!success ||
      (tx.innerInstructions === 'present' &&
        (tx.tokenBalances === 'present' || !tokenProgramKeyed(tx)))) &&
    !tx.instructions.some((ix) => ix.textTooLong);
  const natives: NativeMove[] = [];
  const tokens: { readonly move: TokenMove; readonly mint: string }[] = [];
  const transfers: DriverTransfer[] = [];
  for (const ix of success ? tx.instructions : []) {
    const native = nativeMove(ix);
    if (native) {
      natives.push(native);
      transfers.push({
        locator: ix.locator,
        from: [native.from],
        to: native.to,
        asset: 'native',
        amount: native.amount,
        source: ix.inner ? 'internal' : 'native',
        ...(memo !== undefined ? { memo } : {}),
      });
      continue;
    }
    const move = tokenMove(ix);
    if (!move) continue;
    const mint = mintOf(tx, move);
    if (mint === undefined) {
      complete = false;
      continue;
    }
    tokens.push({ move, mint });
    const from = ownerOf(tx, move.source);
    const to = ownerOf(tx, move.destination);
    // Without the owners the node did not report, the token accounts stand in for them.
    if (from === undefined || to === undefined) complete = false;
    transfers.push({
      locator: ix.locator,
      from: [from ?? move.source],
      to: to ?? move.destination,
      asset: { standard: 'spl', contract: mint },
      amount: move.amount,
      source: 'token-event',
      ...(memo !== undefined ? { memo } : {}),
    });
  }
  if (!lamportsReconcile(tx, natives) || !tokensReconcile(tx, tokens)) complete = false;
  return {
    id: tx.signature,
    observation: {
      seen: 'block',
      txHash: tx.signature,
      blockHeight: place.height,
      blockHash: place.hash,
      success,
      ...(success ? {} : { reason: 'transaction failed' }),
    },
    fee: [{ asset: 'native', amount: tx.fee }],
    transfers,
    decoding: complete ? 'complete' : 'partial',
    ...(place.blockTime !== undefined ? { timestamp: place.blockTime } : {}),
    details: {
      ...(tx.slot !== undefined ? { slot: tx.slot } : {}),
      version: tx.version,
      ...(success ? {} : { err: canonicalJson(tx.err) }),
    },
  };
}

/**
 * The scan filter (handoff §3: "at least every transaction with a transfer from or to"
 * the addresses), a conservative superset (I4) over wallets and token accounts alike: a
 * decoded transfer names a watched address; a successful token transfer moves tokens into
 * or out of a watched token account (its decoded transfer names the owners instead, final
 * review I1); the decoding is partial and a watched address is among the account keys; a
 * watched account's lamports changed; the node reported no token balances and a token
 * program ran or was keyed (a deposit into an existing token account names no owner then,
 * R4); or a token holding changed (per account and mint) whose owner is watched or was not
 * reported (it cannot be attributed). A watched token account's holding cannot change
 * unnoticed: a change no parsed transfer explains makes the decoding partial, and the
 * account is a key.
 */
export function touches(
  decoded: DriverTransaction,
  tx: ParsedTransaction,
  addresses: ReadonlySet<string>,
): boolean {
  const named = decoded.transfers.some(
    (transfer) =>
      addresses.has(transfer.to) || transfer.from.some((f) => addresses.has(f)),
  );
  if (named) return true;
  // `decodeTransaction` already read these instructions: none of them throws here.
  const account =
    tx.err === null &&
    tx.instructions.some((ix) => {
      const move = tokenMove(ix);
      return (
        move !== null && (addresses.has(move.source) || addresses.has(move.destination))
      );
    });
  if (account) return true;
  const keyed = tx.keys.some((key) => addresses.has(key));
  if (keyed && decoded.decoding === 'partial') return true;
  const lamportsMoved = tx.keys.some(
    (key, i) => addresses.has(key) && tx.preBalances[i] !== tx.postBalances[i],
  );
  if (lamportsMoved) return true;
  if (tx.tokenBalances === 'absent' && tokenProgramKeyed(tx)) return true;
  const indexes = new Set([...tx.preTokens.keys(), ...tx.postTokens.keys()]);
  for (const index of indexes) {
    const pre = tx.preTokens.get(index);
    const post = tx.postTokens.get(index);
    const moved =
      pre?.mint === post?.mint
        ? (pre?.amount ?? 0n) !== (post?.amount ?? 0n)
        : (pre?.amount ?? 0n) !== 0n || (post?.amount ?? 0n) !== 0n;
    if (!moved) continue;
    for (const balance of [pre, post]) {
      if (balance && (balance.owner === undefined || addresses.has(balance.owner))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * An account's balance of `mint` before and after, as the classic Token program holds it.
 * The owning program comes from each balance's `programId`, which the provider must report
 * (current agave does). Through a provider that leaves it out, no SPL verdict ever decides:
 * a cost in liveness only, never a wrong verdict.
 */
function holding(
  tx: ParsedTransaction,
  address: string,
  mint: string,
): { readonly pre?: bigint; readonly post: bigint } {
  const index = tx.accountIndex.get(address);
  if (index === undefined) throw notYet('the accounts of the token transfer');
  const pre = tx.preTokens.get(index);
  const post = tx.postTokens.get(index);
  // A successful transfer leaves both accounts in place: no balance is missing evidence.
  if (!post) throw notYet('the token balances of the transfer');
  for (const balance of [pre, post]) {
    if (!balance) continue;
    if (balance.programId === undefined) {
      throw notYet('the token balances of the transfer');
    }
    if (balance.mint !== mint || balance.programId !== TOKEN_PROGRAM) {
      throw inconsistent('the token balances do not match the signed transfer');
    }
  }
  return { ...(pre ? { pre: pre.amount } : {}), post: post.amount };
}

/** One of the sender's transfers, read from the balances by account, mint and program. */
function landed(tx: ParsedTransaction, move: TokenMove): boolean {
  // We sign `transferChecked` only, which names its mint.
  if (move.mint === undefined) {
    throw inconsistent('the token instructions do not match the signed transaction');
  }
  const source = holding(tx, move.source, move.mint);
  const destination = holding(tx, move.destination, move.mint);
  // The sender's account held the tokens before the transfer (only a recipient's account
  // can be created by the same transaction).
  if (source.pre === undefined) throw notYet('the token balances of the transfer');
  // A zero-amount record moved nothing; a transfer to itself cannot show in balances.
  if (move.amount === 0n) return false;
  if (move.source === move.destination) return true;
  return source.post - source.pre < 0n && destination.post - (destination.pre ?? 0n) > 0n;
}

/**
 * The phantom-success guard (lessons 7 and 15; the board's final wording), for verdict
 * paths only: a token transfer counts as executed only when the balances show a transfer
 * of a positive amount from the sender's account to the intended recipient's account, of
 * the signed mint, in accounts the classic Token program owns. The exact amount is not
 * required (fee-on-transfer tokens exist). The intended recipient is the destination of
 * the sender's own signed instruction. Missing evidence (no token balances, a balance or
 * its owning program not reported, an unparsed instruction, accounts not in the keys)
 * decides nothing (a retryable `PROVIDER_UNAVAILABLE`), and so does an answer that
 * contradicts the signed message: token instructions, none of them by the sender, where
 * the sender signed its own `transferChecked`, or balances of another mint or program
 * (lesson 18, widened; a retryable `PROVIDER_INCONSISTENT`). Seeing no transfer never
 * passes; a failed transaction never lands; a native transfer keeps the chain's status.
 * The balances must carry `programId` (current agave reports it): without it, SPL verdicts
 * through that provider never decide, which costs liveness only.
 */
export function tokenTransfersLanded(tx: ParsedTransaction, from: string): boolean {
  if (tx.err !== null) return false;
  const tokenInstructions = tx.instructions.filter(
    (ix) => !ix.inner && TOKEN_PROGRAMS.includes(ix.programId),
  );
  // A native transfer: the chain's own status is the verdict.
  if (tokenInstructions.length === 0) return true;
  if (tokenInstructions.some((ix) => !ix.info)) {
    throw notYet('the parsed token instructions');
  }
  const ours = tokenInstructions.flatMap((ix) => {
    const move = tokenMove(ix);
    return move && move.authority === from ? [move] : [];
  });
  if (ours.length === 0) {
    throw inconsistent('the token instructions do not match the signed transaction');
  }
  if (tx.tokenBalances === 'absent') throw notYet('the token balances');
  return ours.every((move) => landed(tx, move));
}
