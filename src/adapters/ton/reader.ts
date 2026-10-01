/**
 * TON addresses, reads, seqnos, jetton lookups and the `ext.ton` API. Every call carries the
 * tags of the `ChainDriver` contract table (`src/core/driver/types.ts`): `read` for point
 * queries, `monitor` for heights, observations and seqnos. Jetton metadata, which the
 * core caches for the container's life, is a `read` under the proof quorum.
 */
import { Cell, Dictionary, type Transaction } from '@ton/core';
import { createHash } from 'node:crypto';
import type {
  AddressCodec,
  ChainReader,
  DriverBlock,
  DriverTxObservation,
  SequenceSource,
  WalletOptions,
} from '../../core/driver/types';
import {
  ChainError,
  ProviderError,
  ValidationError,
  isCryptoAioError,
  withContext,
} from '../../core/errors/error';
import type { Logger } from '../../core/events/logger';
import type { AssetMetadata, AssetRef, TokenRef } from '../../core/model/asset';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import type { AttemptRef } from '../../core/model/transaction';
import type { Clock } from '../../core/util/clock';
import { createTonAddressCodec } from './address';
import {
  MASTERCHAIN_SHARD,
  MONITOR,
  PROOF,
  READ,
  jettonDataOf,
  runResultOf,
  sameBlock,
  type AccountState,
  type BlockHeader,
  type BlockId,
  type BoundRunResult,
  type RunResult,
  type TonApi,
  type V3Trace,
  type V3Transaction,
} from './api';
import {
  decodeTransaction,
  executed,
  jettonWalletToVerify,
  ran,
  type VerifiedJettonWallet,
} from './decode';
import {
  addressArgument,
  addressFromBoc,
  decodeWalletRequest,
  messageBody,
  type WalletRequest,
} from './messages';
import type { TonNetworkConfig } from './network';
import {
  REASONS,
  attemptVerdict,
  consumesSeqno,
  isOwnAttempt,
  type Verdict,
} from './trace';
import type { TonCallTags, TonExt } from './types';
import { requestIsOwn, resolveIdentity, walletAddress } from './wallets';

/**
 * What every TON port is built from. Drivers are shared: the caches hold only immutable
 * chain data, values the proof quorum attested or transactions bound to their own hash
 * (`chainTxs`); a single `read` or `monitor` answer is used once and never cached. The one
 * record of anything else is `assembled`, for the replay guard: what this driver itself
 * built and sent.
 */
export interface TonContext {
  readonly api: TonApi;
  readonly chain: ChainInfo;
  readonly network: NetworkInfo;
  readonly config: TonNetworkConfig;
  readonly log: Logger;
  readonly clock: Clock;
  readonly codec: AddressCodec;
  /** `master|owner` → the jetton wallet the master names, as the quorum attested it. */
  readonly jettonWallets: Map<string, string>;
  /** jetton wallet → its owner and master, verified under the quorum. */
  readonly verified: Map<string, VerifiedJettonWallet>;
  /**
   * Wallet transactions the chain walk authenticated, by `lt:hash`. A
   * transaction is immutable and its cell hashes to its id, so a kept one is as good as one
   * fetched again; each walk fetches only what it has not seen (bounded, `CHAIN_MEMO`).
   */
  readonly chainTxs: Map<string, Transaction>;
  /**
   * The external messages this driver assembled, by TEP-467 hash: the build's recorded
   * chain time and whether they were ever handed to a send (bounded, `ASSEMBLED_MEMO`).
   * Known gap: the `Broadcaster` port carries only the bytes, never the Attempt's
   * ordering, so the replay guard keeps this memo; bytes this driver did not assemble, or
   * has evicted, are guarded with the widest window (one day).
   */
  readonly assembled: Map<string, AssembledMessage>;
}

/** What `assemble` recorded about a message it made. */
export interface AssembledMessage {
  /** `TonSeqnoOrdering.validFrom`, as the ordering bound to the signed bytes holds it. */
  readonly validFrom: number;
  /**
   * The driver's clock when `assemble` ran, in ms: a first send skips the replay guard only
   * within `FIRST_SEND_MS` of it.
   */
  readonly assembledAt: number;
  /** Set before the first send; never cleared. */
  sent: boolean;
}

/** The most authenticated transactions a driver keeps (each at most `MEMO_TX_LENGTH`). */
export const CHAIN_MEMO = 4_096;
/** The longest transaction BOC text kept: a wallet transaction takes about 1-2 KB. */
export const MEMO_TX_LENGTH = 16_384;
/** The most assembled messages a driver remembers; an evicted one is guarded as foreign. */
export const ASSEMBLED_MEMO = 4_096;

/** Keeps `value` in a bounded memo, dropping the oldest entry beyond `size`. */
export function keep<K, V>(memo: Map<K, V>, key: K, value: V, size: number): void {
  memo.set(key, value);
  if (memo.size > size) memo.delete(memo.keys().next().value as K);
}

export function createTonContext(args: {
  readonly api: TonApi;
  readonly chain: ChainInfo;
  readonly network: NetworkInfo;
  readonly config: TonNetworkConfig;
  readonly log: Logger;
  readonly clock: Clock;
}): TonContext {
  const codec = createTonAddressCodec({
    testnet: args.config.testnet,
    fromPublicKey: (publicKey: Uint8Array, wallet?: WalletOptions) =>
      walletAddress(resolveIdentity(wallet, args.config.globalId), publicKey),
  });
  return {
    ...args,
    codec,
    jettonWallets: new Map(),
    verified: new Map(),
    chainTxs: new Map(),
    assembled: new Map(),
  };
}

const assetError = (reason: string) => new ValidationError('ASSET_RESOLUTION', reason);

const notYet = (reason: string) =>
  new ProviderError('PROVIDER_UNAVAILABLE', reason, { retryable: true });

/**
 * Metadata the indexer does not have, for a token read anywhere (`jettonMetadata`):
 * non-retryable, so the core reports a transfer of it unresolved instead of failing the
 * read, and not `ASSET_RESOLUTION`, so the core never caches it.
 */
const unresolvable = (reason: string) =>
  new ProviderError('PROVIDER_UNAVAILABLE', reason, { retryable: false });

/**
 * The core caches a token's metadata,
 * and its "no such token", for the container's life, so one lagging or buggy endpoint must
 * never decide it. Balances stay plain reads.
 */
const METADATA: TonCallTags = { ...READ, quorum: 'proof' };

/**
 * A token's own failure (a missing account, a TVM exit code, content that does
 * not parse) is `ASSET_RESOLUTION`; `PROVIDER_MISCONFIGURED` and already retryable errors
 * propagate unchanged; any other definitive node answer is made retryable.
 */
function asRetryable(error: unknown): unknown {
  if (
    isCryptoAioError(error) &&
    error.category === 'provider' &&
    !error.retryable &&
    error.code !== 'PROVIDER_MISCONFIGURED'
  ) {
    return withContext(error, {}, { retryable: true });
  }
  return error;
}

async function tokenCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asRetryable(error);
  }
}

const cellStack = (entry: RunResult['stack'][number] | undefined): string | undefined =>
  entry?.type === 'cell' ? entry.boc : undefined;

/** A lookup id (a 32-byte hash in hex, either case) in lower case; undefined otherwise. */
const hashId = (id: string): string | undefined =>
  typeof id === 'string' && /^[0-9a-fA-F]{64}$/.test(id) ? id.toLowerCase() : undefined;

/** The wallet address a `get_wallet_address` answer names; null when it names none. */
function namedWallet(result: RunResult): string | null {
  const boc = result.exitCode === 0 ? cellStack(result.stack[0]) : undefined;
  return boc ? addressFromBoc(boc) : null;
}

/**
 * What endpoints must agree on for `get_wallet_address`: the exit code and the
 * address it names, never the slice's serialization. It never throws: an answer that does
 * not parse is itself a fact, which the parse then refuses (retryable).
 */
function walletAddressKey(body: unknown): unknown {
  try {
    const result = runResultOf(body);
    return { exitCode: result.exitCode, wallet: namedWallet(result) };
  } catch {
    return 'malformed';
  }
}

/**
 * The jetton wallet `master` assigns to `owner` (`get_wallet_address`), at masterchain
 * block `block` when given. Cached only when the proof quorum attested it: the builder
 * sends jettons to it and the verdict checks it, so one endpoint's answer must never stick.
 * Under a quorum the endpoints agree on the address itself (`walletAddressKey`).
 */
export async function jettonWalletAddress(
  ctx: TonContext,
  master: string,
  owner: string,
  tags: TonCallTags,
  block?: number,
): Promise<string> {
  const key = `${master}|${owner}`;
  const cached = ctx.jettonWallets.get(key);
  if (cached) return cached;
  const keyed =
    tags.quorum !== undefined && tags.quorumKey === undefined
      ? { ...tags, quorumKey: walletAddressKey }
      : tags;
  const result = await tokenCall(() =>
    ctx.api.runGetMethod(
      master,
      'get_wallet_address',
      [['tvm.Slice', addressArgument(owner)]],
      keyed,
      block,
    ),
  );
  const address = namedWallet(result);
  if (!address) throw assetError('the jetton master gives no wallet address');
  if (tags.quorum !== undefined) ctx.jettonWallets.set(key, address);
  return address;
}

/**
 * `owner`'s jetton balance; 0 while its jetton wallet is not deployed. The state and the
 * balance are read at one block, so a load-balanced endpoint never mixes two views.
 */
export async function jettonBalance(
  ctx: TonContext,
  master: string,
  owner: string,
  tags: TonCallTags,
): Promise<bigint> {
  const wallet = await jettonWalletAddress(ctx, master, owner, tags);
  const state = await tokenCall(() => ctx.api.account(wallet, tags));
  if (state.status === 'uninitialized') return 0n;
  const data = await tokenCall(() =>
    ctx.api.runGetMethod(wallet, 'get_wallet_data', [], tags, state.blockSeqno),
  );
  const first = data.stack[0];
  if (data.exitCode === 0 && first?.type === 'num' && first.value >= 0n) {
    return first.value;
  }
  throw assetError('the jetton wallet gives no balance');
}

/**
 * What the get-methods at masterchain block `block` say about a jetton wallet:
 * - `verified`: it names an owner and a master, and that master names it for that owner;
 * - `foreign`: it names an owner and a master that parse, and that master names another
 *   wallet for that owner: positive evidence that it is not the master's;
 * - `unknown`: no evidence either way. `get_wallet_data` exited with `exitCode` (toncenter
 *   answers -13 for an account it holds no state for at that block), or named no owner
 *   or master that parses, or the master named no wallet.
 * Both get-methods run at `block`, one at which the wallet had already run a transaction
 * (a fact at its own height): an endpoint that lags behind it refuses
 * (retryable), where a read at its own head would take a wallet it has not seen yet for a
 * fake. Cached once verified under the quorum.
 */
export type JettonWalletFacts =
  | { readonly kind: 'verified'; readonly wallet: VerifiedJettonWallet }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'unknown'; readonly exitCode?: number };

/** toncenter's exit code for an account it holds no state for at the block asked. */
export const NO_STATE_EXIT = -13;

export async function jettonWalletFacts(
  ctx: TonContext,
  address: string,
  tags: TonCallTags,
  block: number,
): Promise<JettonWalletFacts> {
  const known = ctx.verified.get(address);
  if (known) return { kind: 'verified', wallet: known };
  const data = await tokenCall(() =>
    ctx.api.runGetMethod(address, 'get_wallet_data', [], tags, block),
  );
  if (data.exitCode !== 0) return { kind: 'unknown', exitCode: data.exitCode };
  const ownerBoc = cellStack(data.stack[1]);
  const masterBoc = cellStack(data.stack[2]);
  const owner = ownerBoc ? addressFromBoc(ownerBoc) : null;
  const master = masterBoc ? addressFromBoc(masterBoc) : null;
  if (!owner || !master) return { kind: 'unknown' };
  let named: string;
  try {
    named = await jettonWalletAddress(ctx, master, owner, tags, block);
  } catch (error) {
    if (isCryptoAioError(error, 'ASSET_RESOLUTION')) return { kind: 'unknown' };
    throw error;
  }
  if (named !== address) return { kind: 'foreign' };
  const verified = { address, owner, master };
  if (tags.quorum !== undefined) ctx.verified.set(address, verified);
  return { kind: 'verified', wallet: verified };
}

/**
 * The lenient reading for history: a wallet the master names, else `undefined` (any
 * other contract; the transaction is then `partial`), so a fake contract never stalls a
 * page. One exception: "no state at this block" (exit -13) for the jetton
 * wallet whose own transaction this is (`ranHere`) contradicts the chain, which shows it
 * running there, so it is unavailable data (retryable), never a silent drop of a deposit.
 */
export async function verifyJettonWallet(
  ctx: TonContext,
  address: string,
  tags: TonCallTags,
  block: number,
  ranHere = false,
  memo?: PageMemo,
): Promise<VerifiedJettonWallet | undefined> {
  const facts = await remembered(memo?.jettonWallets, address, () =>
    jettonWalletFacts(ctx, address, tags, block),
  );
  if (facts.kind === 'verified') return facts.wallet;
  if (ranHere && facts.kind === 'unknown' && facts.exitCode === NO_STATE_EXIT) {
    throw notYet('the jetton wallet state is not available at its block');
  }
  return undefined;
}

// ---- jetton metadata (TEP-64) -------------------------------------------------------------

/**
 * The most cells one on-chain content value is read to (at most 127 bytes each,
 * about 8 KB), snake or chunked alike; past them it is unreadable. A symbol or name takes a
 * few cells: the bound keeps an author's long texts readable while bounding the work on
 * content anyone can deploy.
 */
const MAX_VALUE_CELLS = 64;
/** The longest symbol and name kept: the indexer's limits (`api.ts`). */
const MAX_SYMBOL_LENGTH = 256;
const MAX_NAME_LENGTH = 256;

type Slice = ReturnType<Cell['beginParse']>;

/**
 * TEP-64 snake data, read in one pass (`@ton/core`'s `loadStringTail` recurses
 * per cell and concatenates at each level, quadratic in the chain); undefined for a cell that
 * is not whole bytes with at most one ref, or a chain past `MAX_VALUE_CELLS`.
 */
function snakeBytes(first: Slice): Buffer | undefined {
  let slice = first;
  const chunks: Buffer[] = [];
  for (let cells = 1; ; cells += 1) {
    const bits = slice.remainingBits;
    if (cells > MAX_VALUE_CELLS || bits % 8 !== 0 || slice.remainingRefs > 1) {
      return undefined;
    }
    if (bits > 0) chunks.push(slice.loadBuffer(bits / 8));
    if (slice.remainingRefs === 0) return Buffer.concat(chunks);
    slice = slice.loadRef().beginParse();
  }
}

/**
 * TEP-64 chunked data (`chunks#01 data:ChunkedData`, `chunked_data#_ data:(HashmapE 32
 * ^(SnakeData ~0))`): its chunks in index order, from 0 without a gap, each one cell of
 * whole bytes and no refs; at most `MAX_VALUE_CELLS` of them. Undefined otherwise.
 */
function chunkedBytes(slice: Slice): Buffer | undefined {
  const dict = slice.loadDict(Dictionary.Keys.Uint(32), Dictionary.Values.Cell());
  if (dict.size > MAX_VALUE_CELLS) return undefined;
  const chunks: Buffer[] = [];
  for (let index = 0; index < dict.size; index += 1) {
    const chunk = dict.get(index)?.beginParse();
    if (!chunk || chunk.remainingRefs !== 0 || chunk.remainingBits % 8 !== 0) {
      return undefined;
    }
    chunks.push(chunk.loadBuffer(chunk.remainingBits / 8));
  }
  return Buffer.concat(chunks);
}

/**
 * A TEP-64 `ContentData` value as text: snake data (prefix 0x00, which some masters omit) or
 * chunked data (prefix 0x01), both bounded by `MAX_VALUE_CELLS`. Undefined when it does not
 * read.
 */
function contentText(value: Cell): string | undefined {
  try {
    const slice = value.beginParse();
    const prefix = slice.remainingBits >= 8 ? slice.preloadUint(8) : undefined;
    if (prefix === 0 || prefix === 1) slice.skip(8);
    const bytes = prefix === 1 ? chunkedBytes(slice) : snakeBytes(slice);
    return bytes?.toString('utf8');
  } catch {
    return undefined;
  }
}

/** The on-chain content fields read (null: present but unreadable). */
interface OnchainFields {
  readonly decimals?: string | null;
  readonly symbol?: string | null;
  readonly name?: string | null;
}

interface JettonContent {
  readonly fields: OnchainFields;
  /**
   * Whether an off-chain JSON holds the fields the chain does not (TEP-64: off-chain
   * content, or on-chain content with a `uri`); only the indexer has read it.
   */
  readonly linked: boolean;
}

const contentKey = (name: string): Buffer => createHash('sha256').update(name).digest();

/**
 * TEP-64: a parsed content cell's layout and fields. A layout or dictionary that does not
 * read is the token's own content (`ASSET_RESOLUTION`).
 */
function contentOf(cell: Cell): JettonContent {
  try {
    const slice = cell.beginParse();
    const prefix = slice.loadUint(8);
    if (prefix === 1) return { fields: {}, linked: true };
    if (prefix !== 0) throw new Error('layout');
    const dict = slice.loadDict(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
    const fields: {
      decimals?: string | null;
      symbol?: string | null;
      name?: string | null;
    } = {};
    for (const key of ['decimals', 'symbol', 'name'] as const) {
      const value = dict.get(contentKey(key));
      if (value) fields[key] = contentText(value) ?? null;
    }
    return { fields, linked: dict.has(contentKey('uri')) };
  } catch {
    throw assetError('the jetton content is unreadable');
  }
}

/** A content BOC as a cell; undefined when it does not parse as one root. */
function contentCell(boc: string): Cell | undefined {
  try {
    const cells = Cell.fromBoc(Buffer.from(boc, 'base64'));
    return cells.length === 1 ? cells[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Content cells parsed once per metadata read: a state-sized content takes about 2 s to
 * decode (`MAX_STATE_BOC_LENGTH`), and the quorum's endpoints usually serve the same text.
 */
function contentCells(): (boc: string) => Cell | undefined {
  const parsed = new Map<string, Cell | undefined>();
  return (boc) => {
    if (!parsed.has(boc)) parsed.set(boc, contentCell(boc));
    return parsed.get(boc);
  };
}

/**
 * The facts endpoints must agree on for jetton metadata: the exit code and the content
 * cell's hash, never the rest of the answer (a total supply that moves between two reads)
 * nor the cell's serialization. It never throws: an answer that does not parse
 * is itself a fact, which the parse then refuses (retryable).
 */
function jettonDataKey(cellOf: (boc: string) => Cell | undefined) {
  return (body: unknown): unknown => {
    try {
      const { exitCode, content } = jettonDataOf(body);
      if (!content) return { exitCode };
      if (content.kind === 'oversized') return { exitCode, content: 'oversized' };
      const cell = cellOf(content.boc);
      return { exitCode, content: cell ? cell.hash().toString('hex') : 'unparseable' };
    } catch {
      return 'malformed';
    }
  };
}

/**
 * A jetton's metadata, under the proof quorum. The master's content decides what it can:
 * - no master, or content beyond an account state's limits (every quorum endpoint agreed
 *   on it), or a layout or value that does not read: `ASSET_RESOLUTION`;
 * - a content BOC that does not parse: the endpoint's fault, retryable;
 * - content wholly on chain: its own symbol, and its decimals or TEP-64's default of 9;
 * - otherwise the off-chain JSON fills in what the chain does not state, as the indexer
 *   fetched it, and only those fields are judged: one the indexer holds but is not one
 *   (agreed by the quorum) is the token's own `ASSET_RESOLUTION`. Metadata the indexer
 *   does not have (no usable entry: never indexed, not valid, an unfetchable JSON; or a
 *   JSON that states no decimals) is never a default: an index that lags or drops its
 *   filter would otherwise cache 9 decimals for the container's life, and a 6-decimal
 *   token would be mis-scaled 1,000× (fund safety over liveness).
 *
 * That absence is `unresolvable`, a non-retryable `PROVIDER_UNAVAILABLE`. Anyone can send
 * a junk jetton to a deposit address, and a retryable answer would fail every history
 * page and `getTransaction` that holds it, forever. Non-retryable, the core reports the
 * transfer with its raw base-unit amount and the asset unresolved and reads the rest of
 * the page. Its code is not `ASSET_RESOLUTION`, the one failure the core caches for the
 * container's life, so it is never cached: once the indexer has the metadata, the next
 * read resolves the token. A transfer of such a token fails the same way, before anything
 * is signed.
 * Known gap: that refusal is not retryable, even for a jetton the indexer has simply not
 * indexed yet; it records nothing, so the same call succeeds later. A retryable refusal
 * needs the core to report a transfer unresolved on a retryable failure too, or the
 * history stall comes back. A jetton whose metadata states no decimals stays unresolved:
 * the only way to use it is to register its decimals in a plugin's `assets`.
 */
async function jettonMetadata(ctx: TonContext, master: string): Promise<AssetMetadata> {
  const cellOf = contentCells();
  const data = await tokenCall(() =>
    ctx.api.jettonData(master, { ...METADATA, quorumKey: jettonDataKey(cellOf) }),
  );
  if (data.exitCode !== 0 || !data.content) {
    throw assetError('no jetton master at this address');
  }
  if (data.content.kind === 'oversized')
    throw assetError('the jetton content is unreadable');
  const cell = cellOf(data.content.boc);
  if (!cell) throw notYet('malformed jetton content answer');
  const { fields, linked } = contentOf(cell);
  if (fields.decimals === null) throw assetError('the jetton decimals are unreadable');
  if (fields.symbol === null) throw assetError('the jetton symbol is unreadable');
  let decimals: string | null | undefined = fields.decimals;
  let symbol: string | null | undefined = fields.symbol;
  let name = fields.name ?? undefined;
  if (!linked) {
    decimals ??= '9';
  } else if (decimals === undefined || symbol === undefined) {
    const info = await tokenCall(() => ctx.api.tokenInfo(master, METADATA));
    if (!info) throw unresolvable('the jetton metadata is not indexed');
    if (decimals === undefined) decimals = info.decimals;
    if (symbol === undefined) symbol = info.symbol;
    name ??= info.name;
    if (decimals === null) throw assetError('the jetton decimals are unreadable');
    if (symbol === null) throw assetError('the jetton symbol is unreadable');
    if (decimals === undefined)
      throw unresolvable('the jetton metadata states no decimals');
  }
  if (!/^\d{1,3}$/.test(decimals) || Number(decimals) > 255) {
    throw assetError('the jetton decimals are unreadable');
  }
  if (!symbol) throw assetError('the jetton has no symbol');
  if (symbol.length > MAX_SYMBOL_LENGTH)
    throw assetError('the jetton symbol is unreadable');
  return {
    symbol,
    decimals: Number(decimals),
    ...(name && name.length <= MAX_NAME_LENGTH ? { name } : {}),
  };
}

/** The canonical master address of a jetton asset ref; `ASSET_RESOLUTION` otherwise. */
export function jettonMaster(ctx: TonContext, asset: AssetRef): string {
  if (asset === 'native' || asset.standard !== 'jetton') {
    throw assetError(`TON tokens use the 'jetton' standard`);
  }
  try {
    return ctx.codec.normalize(asset.contract).canonical;
  } catch {
    throw assetError('not a TON jetton master address');
  }
}

export function toDriverBlock(header: BlockHeader): DriverBlock {
  return {
    height: BigInt(header.id.seqno),
    hash: header.id.rootHash,
    parentHash: header.prev[0]?.rootHash ?? '',
    timestamp: header.genUtime,
  };
}

// ---- transactions and Attempts -------------------------------------------------------------

/**
 * The transaction a lookup id names (anyone's): by message hash, then by its own hash. An
 * external message can run more than once while it does not consume its seqno; the run
 * that consumed it is the one that took effect, so it is preferred.
 */
async function findTransaction(
  ctx: TonContext,
  id: string,
  tags: TonCallTags,
): Promise<V3Transaction | null> {
  const hash = hashId(id);
  if (!hash) return null;
  const byMessage = await ctx.api.transactionsByMessage(hash, tags);
  const runs = byMessage.filter((tx) => tx.inMsg?.source === null);
  const found = runs.find(consumesSeqno) ?? runs[0] ?? byMessage[0];
  return found ?? ctx.api.transaction(hash, tags);
}

/**
 * Our own Attempt's wallet transaction, bound by account and a locally computed hash
 * (`isOwnAttempt`, never a first-result fallback). A run that did not consume its
 * seqno (a failed action phase, or a compute phase that failed before `commit()`) leaves the
 * same message valid, so it may run again; the run that consumed the seqno is preferred,
 * since only it decides.
 */
export async function findOwnAttempt(
  ctx: TonContext,
  ref: AttemptRef,
  from: string,
  tags: TonCallTags,
): Promise<V3Transaction | undefined> {
  const hash = hashId(ref.id);
  if (!hash) return undefined;
  const own = (await ctx.api.transactionsByMessage(hash, tags)).filter((tx) =>
    isOwnAttempt(tx, from, hash),
  );
  return own.find(consumesSeqno) ?? own[0];
}

/**
 * Each jetton leg's wallets must be the master's own for the sender and the intended
 * recipient (the same master), as masterchain block `block` (the trace's last) records
 * them: a fake jetton wallet can "accept" a transfer that moves nothing. The verdict
 * unchanged when they are.
 *
 * Only positive evidence decides `failed`, never a missing
 * answer. The sender's jetton wallet is the one the proof quorum attested at build and the
 * trace shows both wallets running, so a leg that cannot be verified (no answer, exit -13
 * "no state at this block", nothing that parses), or a sender wallet that is not ours,
 * contradicts the chain: a retryable `PROVIDER_INCONSISTENT` (logged `JETTON_UNVERIFIED`),
 * never a terminal failure that a new key would pay again. `failed` only when the recipient
 * wallet answered, and it is not the master's for the intended recipient (another wallet
 * named, another owner, another master): the jettons went elsewhere.
 */
export async function confirmLegs(
  ctx: TonContext,
  verdict: Verdict,
  from: string,
  tags: TonCallTags,
  block: number,
): Promise<Verdict> {
  if (verdict.kind !== 'success') return verdict;
  for (const leg of verdict.legs) {
    const sender = await jettonWalletFacts(ctx, leg.senderWallet, tags, block);
    const recipient = await jettonWalletFacts(ctx, leg.recipientWallet, tags, block);
    if (
      sender.kind !== 'verified' ||
      sender.wallet.owner !== from ||
      recipient.kind === 'unknown'
    ) {
      ctx.log.warn('a jetton wallet of the transfer could not be verified', {
        code: 'JETTON_UNVERIFIED',
      });
      throw new ProviderError(
        'PROVIDER_INCONSISTENT',
        'the jetton wallets of the transfer could not be verified at its block',
        { retryable: true },
      );
    }
    if (
      recipient.kind === 'foreign' ||
      recipient.wallet.owner !== leg.recipient ||
      recipient.wallet.master !== sender.wallet.master
    ) {
      return Object.freeze({ kind: 'failed', reason: REASONS.jettonUnverified });
    }
  }
  return verdict;
}

/** The newest masterchain block of a trace: every leg's wallet has run by then. */
export function traceBlock(root: V3Transaction, trace: V3Trace | null): number {
  return Math.max(root.mcSeqno, ...(trace?.transactions ?? []).map((tx) => tx.mcSeqno));
}

/**
 * What one history page reads once and uses for every transaction on it:
 * each masterchain block's header, and each jetton wallet's facts, read at the block of the
 * first (newest) transaction that needs them. The same answer reused, so it trusts nothing
 * more; a page reads from then on only what it has not read.
 */
export interface PageMemo {
  readonly headers: Map<number, Promise<BlockHeader>>;
  readonly jettonWallets: Map<string, Promise<JettonWalletFacts>>;
}

export const pageMemo = (): PageMemo => ({
  headers: new Map(),
  jettonWallets: new Map(),
});

/** `read()` once per key in `memo` (none: read every time). */
function remembered<K, V>(
  memo: Map<K, Promise<V>> | undefined,
  key: K,
  read: () => Promise<V>,
): Promise<V> {
  if (!memo) return read();
  let pending = memo.get(key);
  if (!pending) {
    pending = read();
    memo.set(key, pending);
  }
  return pending;
}

/**
 * A transaction decoded with its jetton wallet verified at the transaction's own block
 * and its block's hash; `memo` shares both reads across one history page.
 */
export async function decodeWithJettons(
  ctx: TonContext,
  tx: V3Transaction,
  tags: TonCallTags,
  memo?: PageMemo,
) {
  const candidate = jettonWalletToVerify(tx);
  // The arrival's own jetton wallet ran here; a notification's sender ran earlier.
  const jetton = candidate
    ? await verifyJettonWallet(
        ctx,
        candidate,
        tags,
        tx.mcSeqno,
        candidate === tx.account,
        memo,
      )
    : undefined;
  const header = await remembered(memo?.headers, tx.mcSeqno, () =>
    ctx.api.masterchainHeader(tx.mcSeqno, tags),
  );
  return decodeTransaction(tx, {
    blockHash: header.id.rootHash,
    ...(jetton ? { jetton } : {}),
  });
}

/** The highest masterchain seqno (a uint32). */
const MAX_BLOCK_SEQNO = 0xffff_ffffn;

export function createTonReader(ctx: TonContext): ChainReader {
  const { api } = ctx;
  return {
    getBalance: async (address, asset) => {
      const owner = ctx.codec.normalize(address).canonical;
      if (asset === 'native') return (await api.account(owner, READ)).balance;
      return jettonBalance(ctx, jettonMaster(ctx, asset), owner, READ);
    },
    getBlockHeight: async () => BigInt(await api.masterchainHead(MONITOR)),
    // Every masterchain block is final once it exists.
    getFinalizedHeight: async () => BigInt(await api.masterchainHead(MONITOR)),
    getBlock: async (ref) => {
      let seqno: number | null;
      let hash: string | undefined;
      if (typeof ref === 'bigint') {
        if (ref < 0n || ref > MAX_BLOCK_SEQNO) return null;
        seqno = Number(ref);
      } else {
        hash = hashId(ref);
        if (!hash) return null;
        seqno = await api.masterchainSeqnoOf(hash, READ);
      }
      if (seqno === null || seqno > (await api.masterchainHead(READ))) return null;
      const header = await api.masterchainHeader(seqno, READ);
      if (hash !== undefined && header.id.rootHash !== hash) {
        throw new ProviderError(
          'PROVIDER_INCONSISTENT',
          'the indexer and the liteserver name different blocks',
          { retryable: true },
        );
      }
      return toDriverBlock(header);
    },
    getTransaction: async (id) => {
      const tx = await findTransaction(ctx, id, READ);
      return tx ? decodeWithJettons(ctx, tx, READ) : null;
    },
    observe: async (ref, ordering, from): Promise<DriverTxObservation> => {
      const managed = ordering !== undefined && from !== undefined;
      const wallet = managed ? ctx.codec.normalize(from).canonical : undefined;
      // A managed Attempt is only ever our own wallet transaction (`isOwnAttempt`, before
      // any verdict), never a fallback.
      const tx =
        wallet !== undefined
          ? await findOwnAttempt(ctx, ref, wallet, MONITOR)
          : await findTransaction(ctx, ref.id, MONITOR);
      if (!tx) return { seen: 'none' };
      const header = await api.masterchainHeader(tx.mcSeqno, MONITOR);
      const seen = {
        seen: 'block' as const,
        txHash: tx.hash,
        blockHeight: BigInt(tx.mcSeqno),
        blockHash: header.id.rootHash,
      };
      // Anyone's transaction: its execution status as the chain reports it.
      if (wallet === undefined) return { ...seen, success: executed(tx) };
      // Our own Attempt: the verdict path.
      const trace = await api.trace(tx.hash, MONITOR);
      const verdict = await confirmLegs(
        ctx,
        attemptVerdict(tx, trace),
        wallet,
        MONITOR,
        traceBlock(tx, trace),
      );
      if (verdict.kind === 'pending') return seen;
      return verdict.kind === 'success'
        ? { ...seen, success: true }
        : { ...seen, success: false, reason: verdict.reason };
    },
    getTokenMetadata: async (ref: TokenRef) =>
      jettonMetadata(ctx, jettonMaster(ctx, ref)),
    normalizeTokenRef: (ref) => ({
      standard: 'jetton',
      contract: jettonMaster(ctx, ref),
    }),
  };
}

// ---- seqnos --------------------------------------------------------------------------------

/** A live seqno read and the account state it was read at. */
interface LiveSeqno {
  readonly seqno: bigint;
  readonly state: AccountState;
  /** Whether the wallet is deployed at that block (it then has a public key there). */
  readonly deployed: boolean;
}

/**
 * A get-method's answer is the one run where it was asked: at `block` (the full id
 * when the caller has it, else the masterchain seqno), and on `state` when given, the
 * account's last transaction there. An endpoint that drops the block answers at its own
 * latest state, which decides nothing (a retryable `PROVIDER_INCONSISTENT`).
 */
function assertRunAt(
  result: BoundRunResult,
  block: BlockId | number,
  state?: Pick<AccountState, 'lastLt' | 'lastHash'>,
): void {
  const atBlock =
    typeof block === 'number'
      ? result.block.workchain === -1 &&
        result.block.shard === MASTERCHAIN_SHARD &&
        result.block.seqno === block
      : sameBlock(result.block, block);
  if (
    !atBlock ||
    (state !== undefined &&
      (result.lastTransaction.lt !== state.lastLt ||
        result.lastTransaction.hash !== state.lastHash))
  ) {
    throw new ProviderError(
      'PROVIDER_INCONSISTENT',
      'a get-method was answered at another state than the one asked',
      { retryable: true },
    );
  }
}

const MAX_WALLET_SEQNO = 0xffff_ffffn;

/** The wallet's seqno at the latest state: 0 while undeployed (its first message deploys it). */
export async function walletSeqno(
  ctx: TonContext,
  address: string,
  tags: TonCallTags,
): Promise<bigint> {
  return (await liveSeqno(ctx, address, tags)).seqno;
}

/**
 * The seqno at the block the account state was read at, so both come from one view. A
 * frozen account is refused from its state alone, before any get-method: its deploy
 * `StateInit` would not revive it, and a message signed for it can never run.
 */
async function liveSeqno(
  ctx: TonContext,
  address: string,
  tags: TonCallTags,
): Promise<LiveSeqno> {
  const state = await ctx.api.account(address, tags);
  if (state.status === 'uninitialized') {
    return { seqno: 0n, state, deployed: false };
  }
  if (state.status === 'frozen') {
    throw new ChainError('TX_REFUSED', 'the wallet account is frozen');
  }
  const result = await ctx.api.runGetMethodAt(
    address,
    'seqno',
    [],
    tags,
    state.blockSeqno,
  );
  assertRunAt(result, state.block, state);
  const first = result.stack[0];
  if (
    result.exitCode !== 0 ||
    first?.type !== 'num' ||
    first.value < 0n ||
    first.value > MAX_WALLET_SEQNO
  ) {
    throw new ValidationError(
      'INVALID_INTENT',
      'the account is not a v4r2 or v5r1 wallet',
    );
  }
  return { seqno: first.value, state, deployed: true };
}

/**
 * The wallet's public key at masterchain block `block` (`get_public_key`), read once and
 * only when needed; undefined when the account has none there. The answer is bound to the
 * block asked and, when given, to the account state read there.
 */
export function publicKeyAt(
  ctx: TonContext,
  address: string,
  tags: TonCallTags,
  block: BlockId | number,
  state?: Pick<AccountState, 'lastLt' | 'lastHash'>,
): () => Promise<Uint8Array | undefined> {
  let key: Promise<Uint8Array | undefined> | undefined;
  const seqno = typeof block === 'number' ? block : block.seqno;
  const read = async (): Promise<Uint8Array | undefined> => {
    const result = await ctx.api.runGetMethodAt(
      address,
      'get_public_key',
      [],
      tags,
      seqno,
    );
    assertRunAt(result, block, state);
    const first = result.stack[0];
    if (result.exitCode !== 0 || first?.type !== 'num') return undefined;
    if (first.value < 0n || first.value >= 1n << 256n) return undefined;
    return Buffer.from(first.value.toString(16).padStart(64, '0'), 'hex');
  };
  return () => (key ??= read());
}

/**
 * The wallet request `tx` proves `from` consumed its seqno,
 * else null. Every request must be the wallet's own, signed by its key (`requestIsOwn`): a
 * lone lying indexer can make up an external one, and anyone can post a relayed W5 body for
 * a small fee (a v5r1 wallet ignores a forged one). And it must have consumed the seqno: an
 * external request only when `consumesSeqno` holds (its action phase succeeded, or W5
 * committed and then threw 137), a relayed one only when the wallet ran it to the end
 * (`ran`: with no `commit()` there, a failed action phase rolls the seqno back). A foreign
 * request signed with the same key whose action phase failed consumed nothing. `publicKey`
 * gives the wallet's key for `tx`; it is read only for a request that passed the rest.
 */
export async function provenRequest(
  ctx: TonContext,
  tx: V3Transaction,
  from: string,
  publicKey: (tx: V3Transaction) => Promise<Uint8Array | undefined>,
): Promise<WalletRequest | null> {
  const inMsg = tx.inMsg;
  if (!inMsg || tx.account !== from) return null;
  const body = messageBody(inMsg);
  const request = body ? decodeWalletRequest(body) : null;
  if (!body || !request) return null;
  if (inMsg.source === null) {
    if (request.auth !== 'external' || !consumesSeqno(tx)) return null;
  } else if (request.auth !== 'internal' || !ran(tx)) {
    return null;
  }
  const key = await publicKey(tx);
  return key && requestIsOwn(from, body, key, ctx.config.globalId) ? request : null;
}

/** The history page the seqno floor reads, and how many pages before it gives up. */
const FLOOR_PAGE = 64;
const FLOOR_PAGES = 4;

/**
 * The seqno after the newest wallet request the indexer has. Once the previous transfer
 * is `included`, the core hands out the next seqno; a lagging liteserver read could still
 * show the consumed one, and a message signed for it could only end `replaced`. Only a
 * proven request counts, and only one newer than the live read: the live read
 * already covers the rest. The history is paged on the indexer's own pages (a page
 * whose newest transactions are not final yet still leads to the older ones) until it
 * reaches the live read's block; more than `FLOOR_PAGES` pages since then decides nothing
 * (retryable) rather than guess, and so does a request dated after its own lifetime.
 */
async function indexedSeqnoFloor(
  ctx: TonContext,
  address: string,
  live: LiveSeqno,
  tags: TonCallTags,
): Promise<bigint> {
  const liveKey = live.deployed
    ? publicKeyAt(ctx, address, tags, live.state.block, live.state)
    : async () => undefined;
  // An undeployed wallet at the live read has no key there: read it at the evidence's own
  // block, which a lagging endpoint refuses (retryable), so nothing is guessed meanwhile.
  const key = async (tx: V3Transaction) =>
    (await liveKey()) ?? publicKeyAt(ctx, address, tags, tx.mcSeqno)();
  let endLt: bigint | undefined;
  for (let page = 0; page < FLOOR_PAGES; page += 1) {
    const { transactions, next } = await ctx.api.accountTransactionsPage(
      address,
      { limit: FLOOR_PAGE, ...(endLt !== undefined ? { endLt } : {}) },
      tags,
    );
    for (const tx of transactions) {
      if (tx.mcSeqno <= live.state.blockSeqno) return 0n; // newest first: the rest is older still
      const request = await provenRequest(ctx, tx, address, key);
      if (!request) continue;
      // A request that ran after its own lifetime is a record the chain
      // cannot produce (the wallet refuses it), so it decides nothing, as in the proofs.
      if (request.validUntil <= tx.now) {
        throw new ProviderError(
          'PROVIDER_INCONSISTENT',
          'the seqno consumer ran after its request expired',
          { retryable: true },
        );
      }
      return BigInt(request.seqno) + 1n;
    }
    if (next === undefined) return 0n;
    endLt = next;
  }
  throw notYet('the wallet history since the live seqno read is too long to check');
}

export function createTonSequence(ctx: TonContext): SequenceSource {
  return {
    pending: async (address) => {
      const wallet = ctx.codec.normalize(address).canonical;
      const live = await liveSeqno(ctx, wallet, MONITOR);
      const floor = await indexedSeqnoFloor(ctx, wallet, live, MONITOR);
      return live.seqno > floor ? live.seqno : floor;
    },
    latest: async (address) =>
      walletSeqno(ctx, ctx.codec.normalize(address).canonical, MONITOR),
  };
}

export function createTonExt(ctx: TonContext): TonExt {
  return {
    ton: {
      getSeqno: async (address) =>
        walletSeqno(ctx, ctx.codec.normalize(address).canonical, READ),
      // A caller sends jettons to it, so the proof quorum attests it, and the attested
      // answer is kept.
      jettonWallet: async (owner, master) =>
        jettonWalletAddress(
          ctx,
          jettonMaster(ctx, { standard: 'jetton', contract: master }),
          ctx.codec.normalize(owner).canonical,
          PROOF,
        ),
    },
  };
}
