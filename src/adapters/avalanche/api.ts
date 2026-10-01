/**
 * The two data sources of the Avalanche driver, read through the core's policy-wrapped
 * transports, and strict parsers for their answers: nothing an endpoint sends is trusted
 * for its shape, and a malformed answer is a retryable `PROVIDER_UNAVAILABLE`.
 * - `AvalancheNode`: an AvalancheGo node's chain API (`avm.*` on the X-Chain, `platform.*`
 *   on the P-Chain), JSON-RPC at the endpoint's URL (`…/ext/bc/X`). Bytes come hex encoded
 *   with a 4-byte SHA-256 checksum, which is checked; transaction bytes must also hash to
 *   the id asked for, so they authenticate themselves.
 * - `DataApi`: the Avalanche Data API (the indexer). It only locates a transaction's block
 *   and lists an address's transactions; the node proves what it locates.
 * Texts never echo an endpoint's message, which can carry addresses or amounts: the
 * transport keeps that in `details`.
 */
import { sha256 } from '@noble/hashes/sha256';
import { ProviderError, isCryptoAioError } from '../../core/errors/error';
import { equalBytes, fromHex, toHex } from '../../core/util/bytes';
import type { Transport } from '../../core/transport/types';
import { idOf, isId } from './cb58';
import type { AvalancheCallTags, AvalancheVm } from './types';

/** A block as the node reports it; ids are CB58. */
export interface NodeBlock {
  readonly id: string;
  readonly parentId: string;
  readonly height: bigint;
  /** Unix seconds; absent on P-Chain blocks from before the Banff upgrade. */
  readonly timestamp?: number;
  /** Every transaction the block carries, decision and proposal alike. */
  readonly txIds: readonly string[];
}

/** The P-Chain's view of a transaction (`platform.getTxStatus`). */
export type PlatformStatus =
  'Committed' | 'Aborted' | 'Processing' | 'Dropped' | 'Unknown';

export interface FeeState {
  readonly capacity: bigint;
  readonly excess: bigint;
  readonly price: bigint;
  readonly timestamp: string;
}

/** The P-Chain's fee dimensions' weights: bandwidth, reads, writes, compute. */
export type FeeWeights = readonly [number, number, number, number];

/** Where the indexer says a transaction is. */
export interface Location {
  readonly height: bigint;
  readonly hash: string;
}

export const malformed = (what: string): ProviderError =>
  new ProviderError('PROVIDER_UNAVAILABLE', `malformed Avalanche answer: ${what}`);

/** A definitive JSON-RPC "not found" (`not found`, `couldn't get tx: not found`, …). */
export function isNodeNotFound(error: unknown): boolean {
  if (!isCryptoAioError(error, 'RPC_ERROR') || error.ambiguous) return false;
  const message = error.details?.rpcMessage;
  return typeof message === 'string' && /(?:^|: )not found$/.test(message);
}

/** A definitive HTTP 404 from the Data API. */
export function isHttpNotFound(error: unknown): boolean {
  return (
    isCryptoAioError(error, 'RPC_ERROR') &&
    !error.ambiguous &&
    error.details?.status === 404
  );
}

type Json = Readonly<Record<string, unknown>>;

const record = (value: unknown, what: string): Json => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw malformed(what);
  }
  return value as Json;
};

const MAX_HEIGHT = BigInt(Number.MAX_SAFE_INTEGER);

/** A non-negative integer height, as a number, a bigint or a decimal string. */
export function parseHeight(value: unknown, what = 'height'): bigint {
  let height: bigint;
  if (typeof value === 'number' && Number.isSafeInteger(value)) height = BigInt(value);
  else if (typeof value === 'bigint') height = value;
  else if (typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value))
    height = BigInt(value);
  else throw malformed(what);
  if (height < 0n || height > MAX_HEIGHT) throw malformed(what);
  return height;
}

/**
 * A non-negative integer amount as a decimal string or an exact integer: node calls set
 * `exactIntegers`, so a JSON number above 2^53 arrives as a `bigint`, never rounded.
 */
function parseAmount(value: unknown, what: string): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,29})$/.test(value))
    return BigInt(value);
  throw malformed(what);
}

const id = (value: unknown, what: string): string => {
  if (!isId(value)) throw malformed(what);
  return value;
};

/** `0x…` hex with a trailing 4-byte SHA-256 checksum, as AvalancheGo encodes bytes. */
export function decodeChecked(value: unknown, what: string): Uint8Array {
  if (
    typeof value !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2}){5,}$/.test(value) ||
    value.length > 2 * 1024 * 1024
  ) {
    throw malformed(what);
  }
  const raw = fromHex(value.slice(2));
  const body = raw.subarray(0, -4);
  if (!equalBytes(sha256(body).subarray(-4), raw.subarray(-4))) throw malformed(what);
  return Uint8Array.from(body);
}

/** `0x…` hex of `bytes` with AvalancheGo's checksum. */
export function encodeChecked(bytes: Uint8Array): string {
  const out = new Uint8Array(bytes.length + 4);
  out.set(bytes, 0);
  out.set(sha256(bytes).subarray(-4), bytes.length);
  return toHex(out, true);
}

/** The JSON block of `getBlock`/`getBlockByHeight`, X-Chain or P-Chain, any block type. */
export function parseBlock(answer: unknown): NodeBlock {
  const block = record(record(answer, 'block answer').block, 'block');
  const txIds: string[] = [];
  const txs = block.txs;
  if (txs !== undefined && txs !== null) {
    if (!Array.isArray(txs) || txs.length > 100_000) throw malformed('block.txs');
    for (const tx of txs) txIds.push(id(record(tx, 'block.txs').id, 'block.txs.id'));
  }
  // A P-Chain proposal block carries one proposal transaction besides its decision ones.
  if (block.tx !== undefined && block.tx !== null) {
    txIds.push(id(record(block.tx, 'block.tx').id, 'block.tx.id'));
  }
  if (new Set(txIds).size !== txIds.length) throw malformed('block transactions');
  const time = block.time;
  if (
    time !== undefined &&
    (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0)
  ) {
    throw malformed('block.time');
  }
  return {
    id: id(block.id, 'block.id'),
    parentId: id(block.parentID, 'block.parentID'),
    height: parseHeight(block.height, 'block.height'),
    ...(time !== undefined ? { timestamp: time } : {}),
    txIds,
  };
}

const PLATFORM_STATUSES: readonly PlatformStatus[] = [
  'Committed',
  'Aborted',
  'Processing',
  'Dropped',
  'Unknown',
];

export function parsePlatformStatus(answer: unknown): PlatformStatus {
  const status = record(answer, 'tx status').status;
  if (!PLATFORM_STATUSES.includes(status as PlatformStatus)) throw malformed('tx status');
  return status as PlatformStatus;
}

/** `getUTXOs` asks for at most this many outputs per page (AvalancheGo's maximum). */
export const UTXO_PAGE = 1024;
/** No address is read past this many pages (about 100,000 outputs): bounded work. */
const MAX_UTXO_PAGES = 100;

export class AvalancheNode {
  readonly #transport: Transport;
  readonly #prefix: 'avm' | 'platform';

  constructor(transport: Transport, vm: AvalancheVm) {
    this.#transport = transport;
    this.#prefix = vm === 'avm' ? 'avm' : 'platform';
  }

  #call<T = unknown>(method: string, params: unknown, tags: AvalancheCallTags) {
    return this.#transport.rpc<T>(`${this.#prefix}.${method}`, params, {
      exactIntegers: true,
      ...tags,
    });
  }

  async height(tags: AvalancheCallTags): Promise<bigint> {
    const answer = await this.#call('getHeight', {}, tags);
    return parseHeight(record(answer, 'getHeight').height);
  }

  /** The accepted block at `height`; `null` when the node has none there (yet). */
  async blockAt(height: bigint, tags: AvalancheCallTags): Promise<NodeBlock | null> {
    try {
      const answer = await this.#call(
        'getBlockByHeight',
        { height: height.toString(), encoding: 'json' },
        tags,
      );
      const block = parseBlock(answer);
      if (block.height !== height) throw malformed('the block is at another height');
      return block;
    } catch (error) {
      if (isNodeNotFound(error)) return null;
      throw error;
    }
  }

  async blockById(blockId: string, tags: AvalancheCallTags): Promise<NodeBlock | null> {
    try {
      const block = parseBlock(
        await this.#call('getBlock', { blockID: blockId, encoding: 'json' }, tags),
      );
      if (block.id !== blockId) throw malformed('the block has another id');
      return block;
    } catch (error) {
      if (isNodeNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * An accepted transaction's signed bytes, which must hash to `txId`; `null` when the node
   * does not have it in its accepted state.
   */
  async txBytes(txId: string, tags: AvalancheCallTags): Promise<Uint8Array | null> {
    let answer: unknown;
    try {
      answer = await this.#call('getTx', { txID: txId, encoding: 'hex' }, tags);
    } catch (error) {
      if (isNodeNotFound(error)) return null;
      throw error;
    }
    const bytes = decodeChecked(record(answer, 'getTx').tx, 'getTx.tx');
    if (idOf(bytes) !== txId) throw malformed('transaction bytes of another id');
    return bytes;
  }

  /** P-Chain only: committed, aborted, in a mempool, dropped by one, or unknown. */
  async txStatus(txId: string, tags: AvalancheCallTags): Promise<PlatformStatus> {
    return parsePlatformStatus(await this.#call('getTxStatus', { txID: txId }, tags));
  }

  /**
   * Every output the node lists for `address` (its UTXO set), as raw UTXO bytes, read page
   * by page. An output listed twice alike is kept once; listed twice differently, the
   * answer is malformed.
   */
  async utxos(address: string, tags: AvalancheCallTags): Promise<Uint8Array[]> {
    const seen = new Map<string, string>();
    const out: Uint8Array[] = [];
    let start: Json | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_UTXO_PAGES) throw malformed('more unspent outputs than are read');
      const answer = record(
        await this.#call(
          'getUTXOs',
          {
            addresses: [address],
            limit: UTXO_PAGE,
            encoding: 'hex',
            ...(start ? { startIndex: start } : {}),
          },
          tags,
        ),
        'getUTXOs',
      );
      const utxos = answer.utxos;
      if (!Array.isArray(utxos) || utxos.length > UTXO_PAGE) throw malformed('utxos');
      const fetched = parseAmount(answer.numFetched, 'numFetched');
      if (fetched !== BigInt(utxos.length)) throw malformed('numFetched');
      for (const text of utxos) {
        const bytes = decodeChecked(text, 'utxo');
        const key = toHex(sha256(bytes));
        const head = toHex(bytes.subarray(0, 38)); // codec, txID, output index
        const known = seen.get(head);
        if (known === undefined) {
          seen.set(head, key);
          out.push(bytes);
        } else if (known !== key) {
          throw malformed('an unspent output listed twice, differently');
        }
      }
      if (utxos.length < UTXO_PAGE) return out;
      const end = record(answer.endIndex, 'endIndex');
      if (typeof end.address !== 'string' || typeof end.utxo !== 'string') {
        throw malformed('endIndex');
      }
      start = { address: end.address, utxo: end.utxo };
    }
  }

  /** Issues signed bytes; resolves to the id the node gives them. */
  async issueTx(bytes: Uint8Array, tags: AvalancheCallTags): Promise<string> {
    const answer = await this.#call(
      'issueTx',
      { tx: encodeChecked(bytes), encoding: 'hex' },
      tags,
    );
    return id(record(answer, 'issueTx').txID, 'issueTx.txID');
  }

  /** X-Chain: the fixed fee of a transaction (`txFee`), in nAVAX. */
  async txFee(tags: AvalancheCallTags): Promise<bigint> {
    return parseAmount(
      record(await this.#call('getTxFee', {}, tags), 'getTxFee').txFee,
      'txFee',
    );
  }

  /** P-Chain: the current gas price and capacity (Etna's dynamic fees). */
  async feeState(tags: AvalancheCallTags): Promise<FeeState> {
    const state = record(await this.#call('getFeeState', {}, tags), 'getFeeState');
    if (typeof state.timestamp !== 'string' || state.timestamp.length > 64) {
      throw malformed('feeState.timestamp');
    }
    return {
      capacity: parseAmount(state.capacity, 'feeState.capacity'),
      excess: parseAmount(state.excess, 'feeState.excess'),
      price: parseAmount(state.price, 'feeState.price'),
      timestamp: state.timestamp,
    };
  }

  /** P-Chain: the weights of the four fee dimensions and the minimum gas price. */
  async feeConfig(
    tags: AvalancheCallTags,
  ): Promise<{ readonly weights: FeeWeights; readonly minPrice: bigint }> {
    const config = record(await this.#call('getFeeConfig', {}, tags), 'getFeeConfig');
    const weights = config.weights;
    if (
      !Array.isArray(weights) ||
      weights.length !== 4 ||
      !weights.every((w) => Number.isSafeInteger(w) && (w as number) >= 0)
    ) {
      throw malformed('feeConfig.weights');
    }
    return {
      weights: weights as unknown as FeeWeights,
      minPrice: parseAmount(config.minPrice, 'feeConfig.minPrice'),
    };
  }
}

/** One transaction of an address's history, as the Data API lists it (newest first). */
export interface HistoryEntry {
  readonly txId: string;
  /** Absent for an X-Chain transaction from before its linearization (no block). */
  readonly location?: Location;
}

const PAGE_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

/** A Data API transaction's block, or `undefined` when it has none (non-linear X-Chain). */
function locationOf(tx: Json): Location | undefined {
  const height = tx.blockHeight ?? tx.blockNumber;
  if (height === undefined && tx.blockHash === undefined) return undefined;
  return {
    height: parseHeight(height, 'transaction block height'),
    hash: id(tx.blockHash, 'transaction block hash'),
  };
}

export class DataApi {
  readonly #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** Where the indexer says `txId` is; `null` when it does not know it (404). */
  async locate(
    txId: string,
    tags: AvalancheCallTags,
  ): Promise<Location | null | 'no-block'> {
    let answer: unknown;
    try {
      answer = await this.#transport.http(
        { method: 'GET', path: `/transactions/${txId}`, route: '/transactions/:id' },
        tags,
      );
    } catch (error) {
      if (isHttpNotFound(error)) return null;
      throw error;
    }
    const tx = record(answer, 'transaction');
    if (tx.txHash !== txId) throw malformed('a transaction of another id');
    return locationOf(tx) ?? 'no-block';
  }

  /** A page of `address`'s transactions, newest first. */
  async history(
    address: string,
    options: { readonly cursor?: string; readonly pageSize: number },
    tags: AvalancheCallTags,
  ): Promise<{ readonly items: readonly HistoryEntry[]; readonly next?: string }> {
    const answer = record(
      await this.#transport.http(
        {
          method: 'GET',
          path: '/transactions',
          route: '/transactions',
          query: {
            addresses: address,
            pageSize: String(options.pageSize),
            sortOrder: 'desc',
            ...(options.cursor !== undefined ? { pageToken: options.cursor } : {}),
          },
        },
        tags,
      ),
      'transactions',
    );
    const txs = answer.transactions;
    if (!Array.isArray(txs) || txs.length > options.pageSize) {
      throw malformed('transactions');
    }
    const items = txs.map((entry): HistoryEntry => {
      const tx = record(entry, 'transaction');
      const location = locationOf(tx);
      return { txId: id(tx.txHash, 'txHash'), ...(location ? { location } : {}) };
    });
    const next = answer.nextPageToken;
    if (next !== undefined && next !== null && next !== '') {
      if (typeof next !== 'string' || !PAGE_TOKEN.test(next)) {
        throw malformed('nextPageToken');
      }
      return { items, next };
    }
    return { items };
  }

  /** The hash of the indexer's block at height 0 (its identity probe). */
  static blockZero(answer: unknown): string {
    const block = record(answer, 'block');
    if (parseHeight(block.blockNumber, 'blockNumber') !== 0n) throw malformed('block 0');
    return id(block.blockHash, 'blockHash');
  }

  /** The indexer's newest block height (its height probe). */
  static latestHeight(answer: unknown): bigint {
    const blocks = record(answer, 'blocks').blocks;
    if (!Array.isArray(blocks) || blocks.length !== 1) throw malformed('blocks');
    return parseHeight(record(blocks[0], 'block').blockNumber, 'blockNumber');
  }
}
