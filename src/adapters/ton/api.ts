/**
 * The TON driver's only path to the network (spec §11, D1): toncenter API v2 (the `rpc`
 * transport: live liteserver state, get-methods at a fixed masterchain block, fee emulation,
 * sending) and API v3 (the `indexer` transport: message → transaction, traces, history,
 * jetton metadata), as REST calls through the core transports. Each call carries its
 * driver method's tags (R41) and a `route` with no identifiers in it (R14), and reads
 * integers exactly (A12: toncenter writes some u64 values as JSON numbers). Answers are
 * validated here: a malformed one, or one about other transactions than asked, is a
 * retryable `PROVIDER_UNAVAILABLE` (lesson 6), never a foreign error; numbers are length
 * capped before conversion (lesson 20). Under a quorum, only consensus facts are compared
 * (lesson 2), or the caller's predicate key (lesson 17). SDK-free.
 */
import { ProviderError, isCryptoAioError } from '../../core/errors/error';
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

const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
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
  /** The state's time (seconds): the chain's `now` for the next message. */
  readonly syncUtime: number;
}

export type StackEntry =
  | { readonly type: 'num'; readonly value: bigint }
  | { readonly type: 'cell'; readonly boc: string }
  | { readonly type: 'other' };

export interface RunResult {
  readonly exitCode: number;
  readonly stack: readonly StackEntry[];
}

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
  readonly inMsg: V3Message | null;
  readonly outMsgs: readonly V3Message[];
}

export interface V3Trace {
  /** Lower-case hex. */
  readonly traceId: string;
  readonly complete: boolean;
  readonly transactions: readonly V3Transaction[];
}

// ---- parsers ------------------------------------------------------------------------------

function blockIdOf(value: unknown, route: string): BlockId {
  const v = need(isRecord(value) ? value : undefined, route);
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
      const boc = isRecord(data) ? str(data.bytes) : str(data);
      return { type: 'cell', boc: need(boc, route) };
    }
    return { type: 'other' };
  });
}

function messageOf(value: unknown, route: string): V3Message {
  const m = need(isRecord(value) ? value : undefined, route);
  const content = isRecord(m.message_content) ? m.message_content : undefined;
  const source = rawOf(m.source ?? null);
  const destination = rawOf(m.destination ?? null);
  if (source === undefined || destination === undefined) throw malformed(route);
  const hashNorm =
    m.hash_norm === undefined || m.hash_norm === null ? undefined : hashHex(m.hash_norm);
  const bodyHash = content ? hashHex(content.hash) : undefined;
  const body = content ? str(content.body) : undefined;
  return {
    hash: need(hashHex(m.hash), route),
    ...(hashNorm !== undefined ? { hashNorm } : {}),
    source,
    destination,
    value: m.value === null || m.value === undefined ? null : need(big(m.value), route),
    bounce: typeof m.bounce === 'boolean' ? m.bounce : null,
    bounced: typeof m.bounced === 'boolean' ? m.bounced : null,
    ...(bodyHash !== undefined ? { bodyHash } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

export function transactionOf(value: unknown, route: string): V3Transaction {
  const t = need(isRecord(value) ? value : undefined, route);
  const d = need(isRecord(t.description) ? t.description : undefined, route);
  const c = isRecord(d.compute_ph) ? d.compute_ph : {};
  const a = isRecord(d.action) ? d.action : undefined;
  const b = isRecord(d.bounce) ? d.bounce : undefined;
  const exitCode = int(c.exit_code);
  return {
    hash: need(hashHex(t.hash), route),
    lt: need(big(t.lt), route),
    account: need(rawOf(t.account) ?? undefined, route),
    now: need(int(t.now), route),
    mcSeqno: need(int(t.mc_block_seqno), route),
    traceId: need(hashHex(t.trace_id), route),
    totalFees: need(big(t.total_fees), route),
    aborted: d.aborted === true,
    compute: {
      skipped: c.skipped === true,
      success: c.success === true,
      ...(exitCode !== undefined ? { exitCode } : {}),
    },
    ...(a
      ? {
          action: {
            success: a.success === true,
            resultCode: int(a.result_code) ?? 0,
            skippedActions: int(a.skipped_actions) ?? 0,
            msgsCreated: int(a.msgs_created) ?? 0,
          },
        }
      : {}),
    ...(b && typeof b.type === 'string' ? { bounce: b.type } : {}),
    inMsg:
      t.in_msg === null || t.in_msg === undefined ? null : messageOf(t.in_msg, route),
    outMsgs: need(Array.isArray(t.out_msgs) ? t.out_msgs : undefined, route).map((m) =>
      messageOf(m, route),
    ),
  };
}

/** Emulated (pending) transactions are toncenter's guesses, never chain evidence. */
const committed = (value: unknown): boolean =>
  !(isRecord(value) && value.emulated === true);

function transactionsOf(body: unknown, route: string): V3Transaction[] {
  if (!isRecord(body) || !Array.isArray(body.transactions)) throw malformed(route);
  return body.transactions.filter(committed).map((t) => transactionOf(t, route));
}

/** A block header, parsed (shared by `blockHeader` and its quorum key). */
function headerOf(result: unknown, route: string): BlockHeader {
  const h = need(isRecord(result) ? result : undefined, route);
  return {
    id: blockIdOf(h.id, route),
    globalId: need(int(h.global_id), route),
    genUtime: need(int(h.gen_utime), route),
    prev: Array.isArray(h.prev_blocks)
      ? h.prev_blocks.map((p) => blockIdOf(p, route))
      : [],
  };
}

/** An account state, parsed (shared by `account` and its quorum key). */
function accountOf(result: unknown, route: string): AccountState {
  const r = need(isRecord(result) ? result : undefined, route);
  const state = r.state;
  const status: AccountStatus | undefined =
    state === 'active' || state === 'frozen'
      ? state
      : state === 'uninitialized' || state === 'uninit' || state === 'nonexist'
        ? 'uninitialized'
        : undefined;
  const last = need(
    isRecord(r.last_transaction_id) ? r.last_transaction_id : undefined,
    route,
  );
  return {
    balance: need(big(r.balance), route),
    status: need(status, route),
    lastLt: need(big(last.lt), route),
    lastHash: need(hashHex(last.hash), route),
    blockSeqno: blockIdOf(r.block_id, route).seqno,
    syncUtime: need(int(r.sync_utime), route),
  };
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

/**
 * A trace, parsed (shared by `trace` and its quorum key): its transactions in trace order,
 * an emulated one as `undefined`. Each is listed once, under its own hash; anything else is
 * malformed (a transaction counted twice would count its transfer twice).
 */
function traceParts(
  value: unknown,
  route: string,
): {
  readonly traceId: string;
  readonly complete: boolean;
  readonly entries: readonly (V3Transaction | undefined)[];
} {
  const t = need(isRecord(value) ? value : undefined, route);
  const info = isRecord(t.trace_info) ? t.trace_info : {};
  const txs = need(isRecord(t.transactions) ? t.transactions : undefined, route);
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
    entries,
  };
}

function traceOf(value: unknown, route: string): V3Trace {
  const { entries, ...trace } = traceParts(value, route);
  return {
    ...trace,
    transactions: entries.filter((tx): tx is V3Transaction => tx !== undefined),
  };
}

// ---- quorum keys (lesson 2) ----------------------------------------------------------------
// Each key is the parsed value (M5): honest endpoints that format a fact differently (a
// number or a string, `uninit` or `uninitialized`) agree, and a key that throws is a
// disagreement. A key covers every field a verdict reads (C1); message bodies are left out
// (their serialization varies) and are bound to the keyed body hash where they are decoded
// (`messageBody`). The transport compares keys as canonical JSON, bigints included.

function blockKey(body: unknown): unknown {
  // The facts a proof reads; `prev_blocks` only feeds `getBlock`'s parent hash (a `read`).
  const { prev: _prev, ...facts } = headerOf(v2Result(body, 'quorum'), 'quorum');
  return facts;
}

function accountKey(body: unknown): unknown {
  // `sync_utime` is when the endpoint answered, not a fact of the state at that block.
  const { syncUtime: _syncUtime, ...facts } = accountOf(
    v2Result(body, 'quorum'),
    'quorum',
  );
  return facts;
}

function runKey(body: unknown): unknown {
  return runResultOf(body);
}

function shardsKey(body: unknown): unknown {
  const r = v2Result(body, 'quorum');
  if (!isRecord(r) || !Array.isArray(r.shards)) throw malformed('quorum');
  return r.shards.map((s) => blockIdOf(s, 'quorum'));
}

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

function transactionsKey(body: unknown): unknown {
  return transactionsOf(body, 'quorum').map(factsOf);
}

/** A trace's completeness and every transaction's full facts, in trace order (C1). */
function tracesKey(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.traces)) throw malformed('quorum');
  return body.traces.map((value) => {
    const { entries, ...trace } = traceParts(value, 'quorum');
    return { ...trace, txs: entries.map((tx) => (tx ? factsOf(tx) : null)) };
  });
}

// ---- the client ---------------------------------------------------------------------------

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
    quorumKey?: (result: unknown) => unknown,
  ): Promise<unknown> {
    // The caller's key (a predicate, lesson 17) replaces the call's consensus facts.
    const key = tags.quorumKey ?? quorumKey;
    const options: CallOptions = {
      ...tags,
      exactIntegers: true,
      ...(tags.quorum !== undefined && key ? { quorumKey: key } : {}),
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

  async #v2(
    route: string,
    query: Record<string, string>,
    tags: TonCallTags,
    quorumKey?: (result: unknown) => unknown,
  ): Promise<unknown> {
    const body = await this.#call(
      this.rpc,
      { method: 'GET', path: route, query, route },
      tags,
      quorumKey,
    );
    return v2Result(body, route);
  }

  async #v2Post(
    route: string,
    body: Json,
    tags: TonCallTags,
    quorumKey?: (result: unknown) => unknown,
  ): Promise<unknown> {
    const answer = await this.#call(
      this.rpc,
      { method: 'POST', path: route, body, route },
      tags,
      quorumKey,
    );
    return v2Result(answer, route);
  }

  #v3(
    route: string,
    query: Record<string, string>,
    tags: TonCallTags,
    quorumKey?: (result: unknown) => unknown,
  ): Promise<unknown> {
    return this.#call(
      this.indexer,
      { method: 'GET', path: route, query, route },
      tags,
      quorumKey,
    );
  }

  /** The newest masterchain block the liteserver knows. */
  async masterchainHead(tags: TonCallTags): Promise<number> {
    const route = '/getMasterchainInfo';
    const result = await this.#v2(route, {}, tags);
    return blockIdOf(need(isRecord(result) ? result.last : undefined, route), route)
      .seqno;
  }

  /**
   * Whether the liteserver holds masterchain block `seqno` (every masterchain block is
   * final once it exists). Under a quorum the key is this predicate (lesson 17): endpoints
   * past `seqno` agree whatever their heads.
   */
  async reachedMasterchain(seqno: number, tags: TonCallTags): Promise<boolean> {
    const route = '/getMasterchainInfo';
    const reached = (body: unknown): boolean => {
      const result = v2Result(body, route);
      const last = blockIdOf(
        need(isRecord(result) ? result.last : undefined, route),
        route,
      );
      return last.seqno >= seqno;
    };
    const body = await this.#call(
      this.rpc,
      { method: 'GET', path: route, route },
      { ...tags, ...(tags.quorum !== undefined ? { quorumKey: reached } : {}) },
    );
    return reached(body);
  }

  /** A block's header; `seqno` above the endpoint's head fails (retryable). */
  async blockHeader(
    block: { readonly workchain: number; readonly shard: string; readonly seqno: number },
    tags: TonCallTags,
  ): Promise<BlockHeader> {
    const route = '/getBlockHeader';
    const result = await this.#v2(
      route,
      {
        workchain: String(block.workchain),
        shard: block.shard,
        seqno: String(block.seqno),
      },
      tags,
      blockKey,
    );
    return headerOf(result, route);
  }

  masterchainHeader(seqno: number, tags: TonCallTags): Promise<BlockHeader> {
    return this.blockHeader({ workchain: -1, shard: MASTERCHAIN_SHARD, seqno }, tags);
  }

  /** The shard blocks masterchain block `seqno` commits. */
  async shards(seqno: number, tags: TonCallTags): Promise<BlockId[]> {
    const route = '/getShards';
    const result = await this.#v2(route, { seqno: String(seqno) }, tags, shardsKey);
    const shards = need(
      isRecord(result) && Array.isArray(result.shards) ? result.shards : undefined,
      route,
    );
    return shards.map((s) => blockIdOf(s, route));
  }

  /** A config param's cell (base64 BOC). */
  async configParam(param: number, tags: TonCallTags, seqno?: number): Promise<string> {
    const route = '/getConfigParam';
    const result = await this.#v2(
      route,
      {
        param: String(param),
        ...(seqno !== undefined ? { seqno: String(seqno) } : {}),
      },
      tags,
    );
    const config = need(
      isRecord(result) && isRecord(result.config) ? result.config : undefined,
      route,
    );
    return need(str(config.bytes), route);
  }

  /** An account's state, at masterchain block `seqno` when given. */
  async account(
    address: string,
    tags: TonCallTags,
    seqno?: number,
  ): Promise<AccountState> {
    const route = '/getAddressInformation';
    const result = await this.#v2(
      route,
      { address, ...(seqno !== undefined ? { seqno: String(seqno) } : {}) },
      tags,
      accountKey,
    );
    return accountOf(result, route);
  }

  /** A get-method, at masterchain block `seqno` when given. */
  async runGetMethod(
    address: string,
    method: string,
    stack: readonly (readonly [string, string])[],
    tags: TonCallTags,
    seqno?: number,
  ): Promise<RunResult> {
    const route = '/runGetMethod';
    const result = await this.#v2Post(
      route,
      { address, method, stack, ...(seqno !== undefined ? { seqno } : {}) },
      tags,
      runKey,
    );
    return runOf(result, route);
  }

  /** The emulated source fees of an external message body (signature check skipped). */
  async estimateFee(
    request: {
      readonly address: string;
      readonly body: string;
      readonly initCode?: string;
      readonly initData?: string;
    },
    tags: TonCallTags,
  ): Promise<SourceFees> {
    const route = '/estimateFee';
    const result = await this.#v2Post(
      route,
      {
        address: request.address,
        body: request.body,
        init_code: request.initCode ?? '',
        init_data: request.initData ?? '',
        ignore_chksig: true,
      },
      tags,
    );
    // toncenter writes these fees as JSON numbers: read exactly (A12).
    const fees = need(
      isRecord(result) && isRecord(result.source_fees) ? result.source_fees : undefined,
      route,
    );
    return {
      importFee: need(big(fees.in_fwd_fee), route),
      storageFee: need(big(fees.storage_fee), route),
      gasFee: need(big(fees.gas_fee), route),
      forwardFee: need(big(fees.fwd_fee), route),
    };
  }

  /** Sends an external message; resolves with the node's hashes (hex). */
  async send(boc: string, tags: TonCallTags): Promise<SentMessage> {
    const route = '/sendBocReturnHash';
    const result = await this.#v2Post(route, { boc }, tags);
    const r = need(isRecord(result) ? result : undefined, route);
    return {
      hash: need(hashHex(r.hash), route),
      hashNorm: need(hashHex(r.hash_norm), route),
    };
  }

  /** The indexer's newest indexed masterchain block and the network's global id. */
  async indexerHead(
    tags: TonCallTags,
  ): Promise<{ readonly seqno: number; readonly globalId: number }> {
    const route = '/masterchainInfo';
    const body = await this.#v3(route, {}, tags);
    const last = need(
      isRecord(body) && isRecord(body.last) ? body.last : undefined,
      route,
    );
    return {
      seqno: need(int(last.seqno), route),
      globalId: need(int(last.global_id), route),
    };
  }

  /** The seqno of the masterchain block with this root hash (hex); null if unknown. */
  async masterchainSeqnoOf(rootHash: string, tags: TonCallTags): Promise<number | null> {
    const route = '/blocks';
    const body = await this.#v3(
      route,
      { workchain: '-1', root_hash: rootHash, limit: '1' },
      tags,
    );
    if (!isRecord(body) || !Array.isArray(body.blocks)) throw malformed(route);
    const [first] = body.blocks;
    if (first === undefined) return null;
    const block = need(isRecord(first) ? first : undefined, route);
    if (hashHex(block.root_hash) !== rootHash) throw malformed(route);
    return need(int(block.seqno), route);
  }

  /** Committed transactions whose inbound message has this raw or normalized hash (hex). */
  async transactionsByMessage(hash: string, tags: TonCallTags): Promise<V3Transaction[]> {
    const route = '/transactionsByMessage';
    const body = await this.#v3(
      route,
      { msg_hash: hash, direction: 'in', limit: '8' },
      tags,
      transactionsKey,
    );
    return transactionsOf(body, route);
  }

  /** The committed transaction with this hash; an answer about another one is malformed. */
  async transaction(hash: string, tags: TonCallTags): Promise<V3Transaction | null> {
    const route = '/transactions';
    const body = await this.#v3(route, { hash, limit: '1' }, tags, transactionsKey);
    const wanted = hashHex(hash);
    const txs = transactionsOf(body, route);
    if (txs.some((tx) => tx.hash !== wanted)) throw malformed(route);
    return txs[0] ?? null;
  }

  /**
   * An account's (raw address) transactions, newest first, at or below `endLt` when given.
   * An answer that breaks the query (another account, an lt out of order or above `endLt`,
   * more than `limit`) is malformed: a verdict reads this list as the account's history.
   */
  async accountTransactions(
    account: string,
    options: { readonly limit: number; readonly endLt?: bigint },
    tags: TonCallTags,
  ): Promise<V3Transaction[]> {
    const route = '/transactions';
    const body = await this.#v3(
      route,
      {
        account,
        limit: String(options.limit),
        sort: 'desc',
        ...(options.endLt !== undefined ? { end_lt: options.endLt.toString() } : {}),
      },
      tags,
      transactionsKey,
    );
    const txs = transactionsOf(body, route);
    if (txs.length > options.limit) throw malformed(route);
    const wanted = rawOf(account);
    let below = options.endLt === undefined ? undefined : options.endLt + 1n;
    for (const tx of txs) {
      if (tx.account !== wanted || (below !== undefined && tx.lt >= below)) {
        throw malformed(route);
      }
      below = tx.lt;
    }
    return txs;
  }

  /**
   * The trace a transaction belongs to; null when the indexer has none yet. A trace that
   * does not hold the transaction is malformed.
   */
  async trace(txHash: string, tags: TonCallTags): Promise<V3Trace | null> {
    const route = '/traces';
    const body = await this.#v3(
      route,
      { tx_hash: txHash, include_actions: 'false', limit: '1' },
      tags,
      tracesKey,
    );
    if (!isRecord(body) || !Array.isArray(body.traces)) throw malformed(route);
    const [first] = body.traces;
    if (first === undefined) return null;
    const trace = traceOf(first, route);
    const wanted = hashHex(txHash);
    if (!trace.transactions.some((tx) => tx.hash === wanted)) throw malformed(route);
    return trace;
  }

  /** A jetton master's indexed content (`decimals`, `symbol`, `uri`…); null if unknown. */
  async jettonContent(
    master: string,
    tags: TonCallTags,
  ): Promise<Readonly<Record<string, string>> | null> {
    const route = '/jetton/masters';
    const body = await this.#v3(route, { address: master, limit: '1' }, tags);
    if (!isRecord(body) || !Array.isArray(body.jetton_masters)) throw malformed(route);
    const [first] = body.jetton_masters;
    if (!isRecord(first)) return null;
    const content = isRecord(first.jetton_content) ? first.jetton_content : {};
    return Object.fromEntries(
      Object.entries(content).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  }

  /** The indexer's token symbol for an address, when it has one. */
  async tokenSymbol(address: string, tags: TonCallTags): Promise<string | undefined> {
    const route = '/metadata';
    const body = await this.#v3(route, { address }, tags);
    if (!isRecord(body)) throw malformed(route);
    for (const entry of Object.values(body)) {
      const info =
        isRecord(entry) && Array.isArray(entry.token_info) ? entry.token_info : [];
      for (const token of info) {
        if (
          isRecord(token) &&
          token.valid !== false &&
          typeof token.symbol === 'string'
        ) {
          return token.symbol;
        }
      }
    }
    return undefined;
  }
}
