/**
 * The driver's only path to the network (lesson 1, R41): one direct transport call per
 * request, carrying the purpose, retry class, quorum, fanout and signal of the driver
 * method that made it. No SDK sits on a request path. Answers are validated here: a
 * malformed answer is a retryable `ProviderError('PROVIDER_UNAVAILABLE')`, never a foreign
 * error, and a node `Error` answer is a retryable `RPC_ERROR` that repeats no node text.
 * On a proof path every refusal decides nothing (lesson 18); on a broadcast, an answer
 * that cannot be read leaves the transaction possibly sent.
 */
import { sha256 } from '@noble/hashes/sha256';
import { ConfigError, ProviderError, ValidationError } from '../../core/errors/error';
import type { CallOptions, HttpRequest, Transport } from '../../core/transport/types';
import { bytesToUtf8, fromHex, toHex } from '../../core/util/bytes';
import type { TronCallTags, TronResources } from './types';

export const READ: TronCallTags = { purpose: 'read', retry: 'safe' };
export const MONITOR: TronCallTags = { purpose: 'monitor', retry: 'safe' };
export const PROOF: TronCallTags = { purpose: 'proof', retry: 'safe', quorum: 'proof' };
export const BROADCAST: TronCallTags = {
  purpose: 'broadcast',
  retry: 'ambiguous-on-failure',
};

/** Adds the caller's signal to a tag set. */
export const withSignal = (tags: TronCallTags, signal?: AbortSignal): TronCallTags =>
  signal ? { ...tags, signal } : tags;

type Json = Record<string, unknown>;
type QuorumKey = (result: unknown) => unknown;

export function malformed(field: string): ProviderError {
  return new ProviderError('PROVIDER_UNAVAILABLE', `malformed ${field} in a Tron answer`);
}

/**
 * The node indexed a transaction it cannot serve whole yet (its receipt, the transaction or
 * its block): neither "not seen" nor a verdict. Retryable; the core keeps its current view.
 */
export function notServable(): ProviderError {
  return new ProviderError(
    'PROVIDER_UNAVAILABLE',
    'the node indexed a transaction it cannot serve yet',
  );
}

/** A broadcast answer that cannot be read: the node may hold the transaction. */
function unreadableAfterSend(field: string): ProviderError {
  return new ProviderError(
    'PROVIDER_UNAVAILABLE',
    `malformed ${field} in a Tron answer`,
    {
      ambiguous: true,
    },
  );
}

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function object(value: unknown, field: string): Json {
  if (!isObject(value)) throw malformed(field);
  return value;
}

/**
 * A non-negative JSON integer: a bigint under `exactIntegers` (A12) when it is outside the
 * safe range, else a safe number. Amounts are never rounded.
 */
function uint(value: unknown, field: string): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw malformed(field);
}

/** Like `uint`, but an absent value is 0 (proto3 JSON omits zero fields). */
const uintOr0 = (value: unknown, field: string): bigint =>
  value === undefined ? 0n : uint(value, field);

/** java-tron's `long`: block heights above it are malformed (M5). */
const INT64_MAX = 2n ** 63n - 1n;

/** A block height: a non-negative int64. */
function height(value: unknown, field: string): bigint {
  const n = uint(value, field);
  if (n > INT64_MAX) throw malformed(field);
  return n;
}

/**
 * An integer written into a request body as an exact JSON literal (`JSON.rawJSON`, Node ≥ 22):
 * java-tron reads int64 fields from number literals, and `Number()` would round above 2^53.
 */
const exactInteger = (value: bigint): unknown =>
  (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(value.toString());

/** A block time in milliseconds: a safe non-negative integer, never rounded. */
function millis(value: unknown, field: string): number {
  const ms = uint(value, field);
  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed(field);
  return Number(ms);
}

function hex(value: unknown, field: string, bytes?: number): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw malformed(field);
  }
  if (bytes !== undefined && value.length !== bytes * 2) throw malformed(field);
  return value.toLowerCase();
}

const isEmpty = (value: unknown): boolean =>
  isObject(value) && Object.keys(value).length === 0;

/**
 * Lesson 20: java-tron refuses a transaction above `TRANSACTION_MAX_BYTE_SIZE` (500 KiB), so
 * longer raw bytes are malformed and never hashed or decoded.
 */
const MAX_RAW_HEX = 2 * 500 * 1024;

// ---- consensus keys (quorum) ------------------------------------------------------------

const lower = (value: unknown): unknown =>
  typeof value === 'string'
    ? value.toLowerCase()
    : Array.isArray(value)
      ? value.map(lower)
      : value;

/**
 * java-tron's HTTP 200 failure (`{ "Error": … }`) or a JSON-RPC error, keyed as a flag: it
 * never agrees with a real or an empty answer, and its text is never compared (P25-R21).
 */
const ERROR_KEY = { error: true } as const;
/** java-tron's "not found" (`{}`); a non-empty answer without the facts never matches it. */
const ABSENT_KEY = { absent: true } as const;

const isErrorAnswer = (result: unknown): boolean =>
  isObject(result) && (result.Error !== undefined || result.error !== undefined);

/** A REST key: an error answer is the error flag, `{}` is absent, else the `facts`. */
const restKey =
  (facts: (answer: Json) => unknown): QuorumKey =>
  (result) => {
    if (!isObject(result)) return result;
    if (isErrorAnswer(result)) return ERROR_KEY;
    if (Object.keys(result).length === 0) return ABSENT_KEY;
    return facts(result);
  };

const headerKey = restKey((answer) => {
  const header = isObject(answer.block_header) ? answer.block_header : undefined;
  const raw = header && isObject(header.raw_data) ? header.raw_data : undefined;
  return {
    id: lower(answer.blockID ?? null),
    // proto3 JSON omits genesis's number and timestamp (M2): absent and 0 are one fact.
    number: raw ? (raw.number ?? 0) : null,
    parent: lower(raw?.parentHash ?? null),
    timestamp: raw ? (raw.timestamp ?? 0) : null,
  };
});

/**
 * Lesson 2 / R59: a proven verdict reads the receipt result and the `Transfer` logs, so the
 * key covers them; hex case and fields nodes format differently do not count.
 */
const infoKey = restKey((answer) => {
  const receipt = isObject(answer.receipt) ? answer.receipt : {};
  const logs = Array.isArray(answer.log) ? answer.log : [];
  return {
    id: lower(answer.id ?? null),
    block: answer.blockNumber ?? null,
    // M2 (F4-R14): a proof binds the receipt to its block by this time, so it is attested.
    time: answer.blockTimeStamp ?? null,
    result: answer.result ?? null,
    receipt: receipt.result ?? null,
    logs: logs.map((log) =>
      isObject(log)
        ? { a: lower(log.address), t: lower(log.topics), d: lower(log.data) }
        : log,
    ),
  };
});

const transactionKey = restKey((answer) => {
  const ret = Array.isArray(answer.ret) && isObject(answer.ret[0]) ? answer.ret[0] : {};
  return {
    id: lower(answer.txID ?? null),
    raw: lower(answer.raw_data_hex ?? null),
    ret: ret.contractRet ?? null,
  };
});

/** java-tron's answer for an address that holds no contract: its code and exact text. */
function isNoContract(outcome: Json): boolean {
  return (
    outcome.result !== true &&
    outcome.code === 'CONTRACT_VALIDATE_ERROR' &&
    messageText(outcome.message) === 'Smart contract is not exist.'
  );
}

/**
 * I1: a constant call's verdict, and nothing else. Each node builds the simulated
 * transaction on its own head (reference block, expiration, txID) and meters energy on its
 * own state, so honest nodes never agree on the whole answer. The key compares the outcome
 * (ran, no contract, or any other refusal: one value whose code and text are never
 * compared), whether the VM failed (`ret`), and what the call returned.
 */
const constantCallKey = restKey((answer) => {
  const outcome = isObject(answer.result) ? answer.result : {};
  const tx = isObject(answer.transaction) ? answer.transaction : {};
  const ret = Array.isArray(tx.ret) && isObject(tx.ret[0]) ? tx.ret[0].ret : undefined;
  return {
    outcome:
      outcome.result === true ? 'ok' : isNoContract(outcome) ? 'no-contract' : 'refused',
    ret: ret ?? null,
    out: lower(answer.constant_result ?? null),
  };
});

/** Whether a contract is there, and which: `{}` (none) keys as absent (`restKey`). */
const contractKey = restKey((answer) => ({
  contract: lower(answer.contract_address ?? null),
}));

function rpcBlockKey(result: unknown): unknown {
  if (!isObject(result)) return result;
  // M3: an envelope without a result is an error, whatever else it holds.
  if (isErrorAnswer(result) || !Object.hasOwn(result, 'result')) return ERROR_KEY;
  const block = result.result;
  if (!isObject(block)) return block ?? null;
  // The negative scan stops on `timestamp` (lesson 2): it is compared too.
  return {
    number: lower(block.number ?? null),
    hash: lower(block.hash ?? null),
    parent: lower(block.parentHash ?? null),
    timestamp: lower(block.timestamp ?? null),
    transactions: lower(block.transactions ?? null),
  };
}

const QUORUM_KEYS: Readonly<Record<string, QuorumKey>> = {
  '/wallet/getblock': headerKey,
  '/walletsolidity/getblock': headerKey,
  '/walletsolidity/gettransactioninfobyid': infoKey,
  '/wallet/gettransactioninfobyid': infoKey,
  '/walletsolidity/gettransactionbyid': transactionKey,
  '/wallet/gettransactionbyid': transactionKey,
  '/wallet/triggerconstantcontract': constantCallKey,
  '/wallet/getcontract': contractKey,
  '/jsonrpc': rpcBlockKey,
};

/** The consensus facts compared under a quorum for `path`, if it has any. */
export const quorumKeyFor = (path: string): QuorumKey | undefined =>
  Object.hasOwn(QUORUM_KEYS, path) ? QUORUM_KEYS[path] : undefined;

/** M4: a caller's key never makes an error answer agree with a real one. */
const guarded =
  (key: QuorumKey): QuorumKey =>
  (result) =>
    isErrorAnswer(result) ? ERROR_KEY : key(result);

/**
 * One tagged transport call (R41) with exact integers (A12). Under a quorum the caller's
 * `quorumKey` (lesson 17: a monotone predicate) replaces `fallback`; a key never travels
 * without a quorum.
 *
 * Lesson 18: on a proof path a definitive refusal decides nothing, so it becomes a retryable
 * `PROVIDER_UNAVAILABLE`: a REST 4xx the quorum agreed on, and a 401 or 403 too (M1). The
 * transport reports both as `PROVIDER_MISCONFIGURED` with no structured status, and TronGrid
 * answers a rate-limit suspension with 403 ("Rate-limited requests usually return 429 or 403
 * and should be retried with backoff", developers.tron.network/reference/rate-limits, read
 * 2026-09-27), so a proof cannot tell a bad key from a pause; a bad key still surfaces as
 * `PROVIDER_MISCONFIGURED` on every read. A caller's abort is never converted. Other
 * purposes see the transport's error unchanged (lesson 13).
 */
async function call(
  transport: Transport,
  request: HttpRequest,
  tags: TronCallTags,
  fallback?: QuorumKey,
): Promise<unknown> {
  const { quorumKey: own, ...rest } = tags;
  const quorumKey = rest.quorum === undefined ? undefined : own ? guarded(own) : fallback;
  const options: CallOptions = {
    ...rest,
    exactIntegers: true,
    ...(quorumKey ? { quorumKey } : {}),
  };
  try {
    return await transport.http(request, options);
  } catch (error) {
    if (
      tags.purpose === 'proof' &&
      !tags.signal?.aborted &&
      error instanceof ProviderError &&
      !error.retryable
    ) {
      throw new ProviderError(
        'PROVIDER_UNAVAILABLE',
        'a proof read was refused, which decides nothing',
        { cause: error, context: error.context, retryable: true },
      );
    }
    throw error;
  }
}

// ---- wire shapes --------------------------------------------------------------------------

export interface TronBlockHeader {
  readonly number: bigint;
  readonly id: string;
  readonly parentId: string;
  readonly timestamp: number;
}

export interface TronLog {
  /** The emitter, 20-byte hex (no `41`). */
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface TronTxInfo {
  readonly id: string;
  readonly blockNumber: bigint;
  readonly blockTimestamp: number;
  /** Total TRX burned, in sun. */
  readonly fee: bigint;
  /** `receipt.result` of a contract call (`SUCCESS`, `REVERT`, `OUT_OF_ENERGY`, …). */
  readonly receiptResult?: string;
  /** `FAILED` when execution failed. */
  readonly failed: boolean;
  readonly logs: readonly TronLog[];
}

export interface TronTxJson {
  readonly id: string;
  readonly rawHex: string;
  /** `ret[0].contractRet`, absent while pending. */
  readonly contractRet?: string;
}

const FEE_PARAMETERS = new Set([
  'getTransactionFee',
  'getEnergyFee',
  'getCreateAccountFee',
  'getCreateNewAccountFeeInSystemContract',
  'getCreateNewAccountBandwidthRate',
  'getMemoFee',
  'getMaxFeeLimit',
]);

export interface ChainParameters {
  readonly transactionFee: bigint;
  readonly energyFee: bigint;
  readonly createAccountFee: bigint;
  readonly createNewAccountFeeInSystemContract: bigint;
  readonly createNewAccountBandwidthRate: bigint;
  readonly memoFee: bigint;
  readonly maxFeeLimit: bigint;
}

export type ConstantCall =
  | { readonly kind: 'ok'; readonly result: string; readonly energy: bigint }
  | { readonly kind: 'failed'; readonly energy: bigint }
  | { readonly kind: 'no-contract' };

export interface BroadcastAnswer {
  readonly accepted: boolean;
  readonly code?: string;
  /** The node's message, decoded when it is hex. Never stored or logged as is. */
  readonly message?: string;
}

export interface RpcBlock {
  readonly number: bigint;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp: number;
  readonly transactions: readonly string[];
}

function parseHeader(value: unknown): TronBlockHeader | null {
  if (isEmpty(value)) return null;
  const block = object(value, 'block');
  const raw = object(object(block.block_header, 'block header').raw_data, 'block header');
  // proto3 JSON omits zero fields: genesis has neither number nor timestamp (M2).
  return {
    number: height(raw.number ?? 0, 'block number'),
    id: hex(block.blockID, 'block id', 32),
    parentId: hex(raw.parentHash, 'parent hash', 32),
    timestamp: millis(raw.timestamp ?? 0, 'block timestamp'),
  };
}

function parseTransaction(value: unknown): TronTxJson {
  const tx = object(value, 'transaction');
  const ret =
    Array.isArray(tx.ret) && isObject(tx.ret[0]) ? tx.ret[0].contractRet : undefined;
  if (ret !== undefined && typeof ret !== 'string') throw malformed('contractRet');
  const id = hex(tx.txID, 'txID', 32);
  if (typeof tx.raw_data_hex === 'string' && tx.raw_data_hex.length > MAX_RAW_HEX) {
    throw malformed('raw_data_hex');
  }
  const rawHex = hex(tx.raw_data_hex, 'raw_data_hex');
  // The id is the SHA-256 of the raw bytes: an answer that does not bind them is malformed.
  if (toHex(sha256(fromHex(rawHex))) !== id) throw malformed('raw_data_hex');
  return {
    id,
    rawHex,
    ...(ret !== undefined ? { contractRet: ret } : {}),
  };
}

function parseInfo(value: unknown): TronTxInfo {
  const info = object(value, 'transaction info');
  const receipt = info.receipt === undefined ? {} : object(info.receipt, 'receipt');
  const logs = info.log === undefined ? [] : info.log;
  if (!Array.isArray(logs)) throw malformed('log');
  const receiptResult = receipt.result;
  if (receiptResult !== undefined && typeof receiptResult !== 'string') {
    throw malformed('receipt result');
  }
  if (info.result !== undefined && info.result !== 'FAILED') throw malformed('result');
  return {
    id: hex(info.id, 'transaction id', 32),
    blockNumber: height(info.blockNumber, 'block number'),
    blockTimestamp: millis(info.blockTimeStamp, 'block timestamp'),
    fee: uintOr0(info.fee, 'fee'),
    ...(receiptResult !== undefined ? { receiptResult } : {}),
    failed: info.result === 'FAILED',
    logs: logs.map((entry) => {
      const log = object(entry, 'log');
      if (!Array.isArray(log.topics)) throw malformed('log topics');
      return {
        address: hex(log.address, 'log address', 20),
        topics: log.topics.map((t) => hex(t, 'log topic', 32)),
        data: log.data === undefined ? '' : hex(log.data, 'log data'),
      };
    }),
  };
}

/** The longest node message kept, in characters (M5): java-tron's texts are far shorter. */
const MAX_MESSAGE = 1024;

/**
 * A node's message field: hex-encoded UTF-8 on some paths, plain text on others. At most
 * the first 1 KiB is kept, decoded when the whole field is printable hex.
 */
export function messageText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^(?:[0-9a-fA-F]{2})+$/.test(value)) {
    const text = bytesToUtf8(fromHex(value.slice(0, 2 * MAX_MESSAGE)));
    if (/^[\x20-\x7e]+$/.test(text)) return text;
  }
  return value.slice(0, MAX_MESSAGE);
}

/** A JSON-RPC 32-byte hash, lower-case without `0x`. */
function rpcHash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw malformed(field);
  }
  return value.slice(2).toLowerCase();
}

/** A JSON-RPC quantity of at most 64 bits (lesson 20: bounded before conversion). */
function rpcQuantity(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(value)) {
    throw malformed(field);
  }
  return BigInt(value);
}

// ---- the API ----------------------------------------------------------------------------

export class TronApi {
  readonly #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /**
   * One POST to `path`, answered as JSON; a node `Error` answer is a retryable RPC_ERROR
   * (possibly sent, on a broadcast).
   */
  async post(path: string, body: Json, tags: TronCallTags): Promise<unknown> {
    const answer = await call(
      this.#transport,
      { method: 'POST', path, body, route: path },
      tags,
      quorumKeyFor(path),
    );
    if (isObject(answer) && answer.Error !== undefined) {
      throw new ProviderError('RPC_ERROR', `the node answered an error on ${path}`, {
        retryable: true,
        ...(tags.purpose === 'broadcast' ? { ambiguous: true } : {}),
      });
    }
    return answer;
  }

  /** The head (`scope: 'full'`) or latest solidified block, or one by height or id. */
  async block(
    scope: 'full' | 'solid',
    ref: bigint | string | undefined,
    tags: TronCallTags,
  ): Promise<TronBlockHeader | null> {
    const path = scope === 'full' ? '/wallet/getblock' : '/walletsolidity/getblock';
    const answer = await this.post(
      path,
      { ...(ref !== undefined ? { id_or_num: ref.toString() } : {}), detail: false },
      tags,
    );
    const header = parseHeader(answer);
    if (header && typeof ref === 'bigint' && header.number !== ref) {
      throw malformed('block number');
    }
    if (header && typeof ref === 'string' && header.id !== ref.toLowerCase()) {
      throw malformed('block id');
    }
    if (ref === undefined && header === null) throw malformed('head block');
    return header;
  }

  /**
   * A block with its transactions and their infos (the scanner's read). Block 0 is its
   * header alone (F4-R7): java-tron answers `{}` to `gettransactioninfobyblocknum` there
   * (`GetTransactionInfoByBlockNumServlet`, GreatVoyage-v4.8.2.2; Nile checked 2026-09-27),
   * a malformed answer the scanner would retry for ever, and genesis holds only the chain's
   * initial allocations, which are not reported.
   */
  async blockWithTransactions(
    height: bigint,
    tags: TronCallTags,
  ): Promise<{
    readonly header: TronBlockHeader;
    readonly transactions: readonly TronTxJson[];
    readonly infos: readonly TronTxInfo[];
  } | null> {
    if (height === 0n) {
      const genesis = await this.block('full', 0n, tags);
      return genesis ? { header: genesis, transactions: [], infos: [] } : null;
    }
    const answer = await this.post(
      '/wallet/getblock',
      { id_or_num: height.toString(), detail: true },
      tags,
    );
    const header = parseHeader(answer);
    if (header === null) return null;
    if (header.number !== height) throw malformed('block number');
    const list = (answer as Json).transactions ?? [];
    if (!Array.isArray(list)) throw malformed('transactions');
    const transactions = list.map(parseTransaction);
    const infosAnswer = await this.post(
      '/wallet/gettransactioninfobyblocknum',
      { num: exactInteger(height) },
      tags,
    );
    if (!Array.isArray(infosAnswer)) throw malformed('transaction infos');
    const infos = infosAnswer.map(parseInfo);
    if (infos.some((i) => i.blockNumber !== height)) throw malformed('transaction infos');
    // Two calls can reach two backends behind one URL: the receipts must be exactly this
    // block's, one per transaction.
    const ids = new Set(transactions.map((t) => t.id));
    const receipted = new Set(infos.map((i) => i.id));
    if (
      ids.size !== transactions.length ||
      receipted.size !== infos.length ||
      infos.length !== transactions.length ||
      infos.some((i) => !ids.has(i.id))
    ) {
      throw new ProviderError(
        'PROVIDER_INCONSISTENT',
        `block ${height}'s receipts do not match its transactions`,
        { retryable: true },
      );
    }
    return { header, transactions, infos };
  }

  async chainParameters(tags: TronCallTags): Promise<ChainParameters> {
    const answer = object(
      await this.post('/wallet/getchainparameters', {}, tags),
      'parameters',
    );
    const list = answer.chainParameter;
    if (!Array.isArray(list)) throw malformed('chain parameters');
    // Only the parameters the driver reads are validated: others may be negative (e.g.
    // Nile's `getRemoveThePowerOfTheGr` is -1) and must not fail the read.
    const values = new Map<string, bigint>();
    for (const entry of list) {
      const item = object(entry, 'chain parameter');
      if (typeof item.key !== 'string') throw malformed('chain parameter');
      if (FEE_PARAMETERS.has(item.key)) {
        values.set(item.key, uintOr0(item.value, item.key));
      }
    }
    const required = (key: string): bigint => {
      const value = values.get(key);
      if (value === undefined || value === 0n) throw malformed(key);
      return value;
    };
    return {
      transactionFee: required('getTransactionFee'),
      energyFee: required('getEnergyFee'),
      createAccountFee: values.get('getCreateAccountFee') ?? 0n,
      createNewAccountFeeInSystemContract:
        values.get('getCreateNewAccountFeeInSystemContract') ?? 0n,
      createNewAccountBandwidthRate: values.get('getCreateNewAccountBandwidthRate') ?? 1n,
      memoFee: values.get('getMemoFee') ?? 0n,
      maxFeeLimit: required('getMaxFeeLimit'),
    };
  }

  /** `{ exists: false }` for an account that was never activated. */
  async account(
    addressHex: string,
    tags: TronCallTags,
  ): Promise<{ readonly exists: boolean; readonly balance: bigint }> {
    const answer = object(
      await this.post('/wallet/getaccount', { address: addressHex }, tags),
      'account',
    );
    if (Object.keys(answer).length === 0) return { exists: false, balance: 0n };
    if (
      typeof answer.address !== 'string' ||
      answer.address.toLowerCase() !== addressHex.toLowerCase()
    ) {
      throw malformed('account address');
    }
    return { exists: true, balance: uintOr0(answer.balance, 'balance') };
  }

  async resources(addressHex: string, tags: TronCallTags): Promise<TronResources> {
    const r = object(
      await this.post('/wallet/getaccountresource', { address: addressHex }, tags),
      'account resources',
    );
    if (Object.keys(r).length === 0) {
      return { activated: false, freeBandwidth: 0n, stakedBandwidth: 0n, energy: 0n };
    }
    const left = (limit: unknown, used: unknown, field: string): bigint => {
      const value = uintOr0(limit, field) - uintOr0(used, field);
      return value > 0n ? value : 0n;
    };
    return {
      activated: true,
      freeBandwidth: left(r.freeNetLimit, r.freeNetUsed, 'free bandwidth'),
      stakedBandwidth: left(r.NetLimit, r.NetUsed, 'bandwidth'),
      energy: left(r.EnergyLimit, r.EnergyUsed, 'energy'),
    };
  }

  /**
   * A constant (simulated) contract call. `no-contract` when the address holds no contract;
   * `failed` when the call reverts or the VM fails; any other refusal is a retryable
   * RPC_ERROR (lesson 13).
   */
  async constantCall(
    ownerHex: string,
    contractHex: string,
    data: string,
    tags: TronCallTags,
  ): Promise<ConstantCall> {
    const answer = object(
      await this.post(
        '/wallet/triggerconstantcontract',
        { owner_address: ownerHex, contract_address: contractHex, data },
        tags,
      ),
      'constant call',
    );
    const result = object(answer.result, 'constant call result');
    if (result.result !== true) {
      if (isNoContract(result)) return { kind: 'no-contract' };
      throw new ProviderError('RPC_ERROR', 'the node refused a contract call', {
        retryable: true,
      });
    }
    const tx =
      answer.transaction === undefined ? {} : object(answer.transaction, 'transaction');
    const ret = Array.isArray(tx.ret) && isObject(tx.ret[0]) ? tx.ret[0].ret : undefined;
    if (ret === 'FAILED') {
      return { kind: 'failed', energy: uintOr0(answer.energy_used, 'energy used') };
    }
    const out = answer.constant_result;
    if (!Array.isArray(out) || out.length !== 1) throw malformed('constant result');
    // F4-R9: a call that ran used energy, and the fee estimate is built on it; a missing or
    // zero `energy_used` is a malformed answer, never 0 (a 0 fee limit fails on chain).
    const energy = uint(answer.energy_used, 'energy used');
    if (energy === 0n) throw malformed('energy used');
    return { kind: 'ok', result: hex(out[0], 'constant result'), energy };
  }

  /**
   * Whether `addressHex` holds a contract (`/wallet/getcontract`): java-tron answers `{}`
   * when the account or its contract does not exist (`Wallet.getContract`, GreatVoyage-v4.8.2.2
   * `d5c3d1d1`), else the `SmartContract`. The structural check behind a constant call's
   * "no contract" text before anyone caches it; an answer about another address is
   * malformed.
   */
  async contractExists(addressHex: string, tags: TronCallTags): Promise<boolean> {
    const answer = object(
      await this.post('/wallet/getcontract', { value: addressHex }, tags),
      'contract',
    );
    if (Object.keys(answer).length === 0) return false;
    // M3 (F4-R10): java-tron's `SmartContract` always names its address; an answer that
    // names none, or another, is malformed.
    const address = answer.contract_address;
    if (
      typeof address !== 'string' ||
      address.toLowerCase() !== addressHex.toLowerCase()
    ) {
      throw malformed('contract');
    }
    return true;
  }

  /**
   * `/wallet/broadcasthex`. java-tron answers refusals with HTTP 200, so the answer is read
   * here; one that cannot be read is possibly sent (the node may hold the bytes).
   */
  async broadcastHex(hexTx: string, tags: TronCallTags): Promise<BroadcastAnswer> {
    const answer = await this.post('/wallet/broadcasthex', { transaction: hexTx }, tags);
    if (!isObject(answer)) throw unreadableAfterSend('broadcast answer');
    if (answer.result === true) return { accepted: true };
    if (typeof answer.code !== 'string') throw unreadableAfterSend('broadcast code');
    const message = messageText(answer.message);
    return { accepted: false, code: answer.code, ...(message ? { message } : {}) };
  }

  /** An included transaction (`full`: any block; `solid`: a solidified one), or null. */
  async transaction(
    scope: 'full' | 'solid',
    id: string,
    tags: TronCallTags,
  ): Promise<TronTxJson | null> {
    const path =
      scope === 'full'
        ? '/wallet/gettransactionbyid'
        : '/walletsolidity/gettransactionbyid';
    const answer = await this.post(path, { value: id }, tags);
    if (isEmpty(answer)) return null;
    const tx = parseTransaction(answer);
    if (tx.id !== id.toLowerCase()) throw malformed('transaction id');
    return tx;
  }

  async transactionInfo(
    scope: 'full' | 'solid',
    id: string,
    tags: TronCallTags,
  ): Promise<TronTxInfo | null> {
    const path =
      scope === 'full'
        ? '/wallet/gettransactioninfobyid'
        : '/walletsolidity/gettransactioninfobyid';
    const answer = await this.post(path, { value: id }, tags);
    if (isEmpty(answer)) return null;
    const info = parseInfo(answer);
    if (info.id !== id.toLowerCase()) throw malformed('transaction id');
    return info;
  }

  /** The transaction if the node holds `id` in its pending pool, else null. */
  async pending(id: string, tags: TronCallTags): Promise<TronTxJson | null> {
    const answer = await this.post(
      '/wallet/gettransactionfrompending',
      { value: id },
      tags,
    );
    if (isEmpty(answer)) return null;
    const tx = parseTransaction(answer);
    if (tx.id !== id.toLowerCase()) throw malformed('transaction id');
    return tx;
  }

  /** The node's JSON-RPC block read (transaction ids only), or null when it has none. */
  async rpcBlock(ref: bigint | string, tags: TronCallTags): Promise<RpcBlock | null> {
    const byHash = typeof ref === 'string';
    const answer = object(
      await this.post(
        '/jsonrpc',
        {
          jsonrpc: '2.0',
          id: 1,
          method: byHash ? 'eth_getBlockByHash' : 'eth_getBlockByNumber',
          params: [byHash ? `0x${ref}` : `0x${ref.toString(16)}`, false],
        },
        tags,
      ),
      'JSON-RPC answer',
    );
    if (answer.error !== undefined) {
      throw new ProviderError('RPC_ERROR', 'the node answered a JSON-RPC error', {
        retryable: true,
      });
    }
    if (answer.result === null) return null;
    const block = object(answer.result, 'JSON-RPC block');
    const txs = block.transactions;
    if (!Array.isArray(txs)) throw malformed('JSON-RPC transactions');
    const seconds = rpcQuantity(block.timestamp, 'JSON-RPC timestamp');
    if (seconds * 1000n > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw malformed('JSON-RPC timestamp');
    }
    const number = rpcQuantity(block.number, 'JSON-RPC number');
    if (number > INT64_MAX) throw malformed('JSON-RPC number');
    const parsed: RpcBlock = {
      number,
      hash: rpcHash(block.hash, 'JSON-RPC hash'),
      parentHash: rpcHash(block.parentHash, 'JSON-RPC parent hash'),
      timestamp: Number(seconds) * 1000,
      transactions: txs.map((t) => rpcHash(t, 'JSON-RPC transaction')),
    };
    if (byHash ? parsed.hash !== ref.toLowerCase() : parsed.number !== ref) {
      throw malformed('JSON-RPC block');
    }
    return parsed;
  }
}

/**
 * A base58 account address, the only form sent to TronGrid: it becomes a URL path segment,
 * so anything else is refused before any call (lesson 20: bounded).
 */
const BASE58_ACCOUNT = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/**
 * TronGrid's page cursor, bounded in length and charset (M5). Observed on 2026-09-27: 221 to
 * 224 base58 characters; the bound leaves room for base64 forms.
 */
const FINGERPRINT = /^[0-9A-Za-z+/=_-]{1,1024}$/;

/**
 * TronGrid `/v1` account history pages (indexer transport), confirmed entries only. Each
 * transaction id is listed once per page: the TRC-20 stream lists a transaction once per
 * transfer it made.
 *
 * I2: internal transactions are not listed. `search_internal=false` asks TronGrid for none,
 * and any entry carrying `internal_tx_id` is skipped: TronGrid documents that entry shape
 * (`internal_tx_id`, `tx_id`, `from_address`, `to_address`, `data`, `block_timestamp`; its
 * OpenAPI schema at developers.tron.network/reference/get-transaction-info-by-account-address)
 * and it has no `txID`, so one would make the whole page malformed. Read on 2026-09-27,
 * `GET api.trongrid.io/v1/accounts/TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR/transactions?limit=20`
 * (WTRX) gave only whole transactions (`txID`, `raw_data_hex`, …), each with the internal
 * transfers nested in `internal_transactions[]` (`internal_tx_id`, `data`, `from_address`,
 * `to_address`); five other accounts, internal-TRX recipients among them, looked the same
 * with `search_internal` true or false. A TRX amount an account received only through a
 * contract's internal transfer is therefore not in its history.
 */
export async function historyPage(
  transport: Transport,
  address: string,
  kind: 'transactions' | 'trc20',
  options: { readonly limit: number; readonly fingerprint?: string },
  tags: TronCallTags,
): Promise<{ readonly ids: readonly string[]; readonly next?: string }> {
  if (typeof address !== 'string' || !BASE58_ACCOUNT.test(address)) {
    throw new ValidationError('INVALID_ADDRESS', 'not a Tron address');
  }
  if (options.fingerprint !== undefined && !FINGERPRINT.test(options.fingerprint)) {
    throw new ConfigError('CONFIG_INVALID', 'not a Tron history cursor');
  }
  const suffix = kind === 'trc20' ? '/trc20' : '';
  const answer = object(
    await call(
      transport,
      {
        method: 'GET',
        path: `/v1/accounts/${address}/transactions${suffix}`,
        route: `/v1/accounts/:address/transactions${suffix}`,
        query: {
          limit: String(options.limit),
          only_confirmed: 'true',
          ...(kind === 'transactions' ? { search_internal: 'false' } : {}),
          ...(options.fingerprint !== undefined
            ? { fingerprint: options.fingerprint }
            : {}),
        },
      },
      tags,
    ),
    'history page',
  );
  if (answer.success !== true || !Array.isArray(answer.data)) {
    throw malformed('history page');
  }
  const meta = answer.meta === undefined ? {} : object(answer.meta, 'history meta');
  const next = meta.fingerprint;
  if (
    next !== undefined &&
    next !== '' &&
    (typeof next !== 'string' || !FINGERPRINT.test(next))
  ) {
    throw malformed('history fingerprint');
  }
  const ids: string[] = [];
  for (const item of answer.data) {
    const entry = object(item, 'history item');
    if (entry.internal_tx_id !== undefined) continue;
    ids.push(hex(kind === 'trc20' ? entry.transaction_id : entry.txID, 'history id', 32));
  }
  return {
    ids: [...new Set(ids)],
    ...(typeof next === 'string' && next !== '' ? { next } : {}),
  };
}
