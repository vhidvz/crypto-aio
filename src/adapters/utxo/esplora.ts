/**
 * The Esplora REST API over the core transport (spec §11: "UTXO (Esplora) | direct REST via
 * transport"). Every call carries the calling driver method's tags (R41) and a `route`
 * template with no identifiers in it (R14). Answers are validated strictly: a malformed one
 * is a retryable `ProviderError('PROVIDER_UNAVAILABLE')` (lesson 6), a missing or ill-typed
 * field is malformed and never a default, an answer for another id than the one asked for is
 * refused, and a 404 is `null`. Chain data is read as the chain allows it, never bounded by
 * what this library builds (lenient readers). Chain reads use the `rpc` transport; address
 * reads use the `indexer`. Only raw transaction hex is decoded, with the codec's strict
 * decoder (bitcoinjs-lib), to bind it to its txid.
 */
import {
  ProviderError,
  ValidationError,
  isCryptoAioError,
} from '../../core/errors/error';
import type { HttpRequest, Transport } from '../../core/transport/types';
import { txidOfHex } from './codec';
import type {
  EsploraAddressStats,
  EsploraBlock,
  EsploraInput,
  EsploraOutput,
  EsploraOutspend,
  EsploraStatus,
  EsploraTx,
  EsploraUtxo,
  UtxoCallTags,
} from './types';

type Json = Readonly<Record<string, unknown>>;

const HEX64 = /^[0-9a-f]{64}$/;
/** Bitcoin Core's `MAX_MONEY`: no output, and no balance, is larger. */
const MAX_MONEY = 2_100_000_000_000_000n;

/**
 * Lowercase hex of whole bytes. A flat character class, not `([0-9a-f]{2})+`: that pattern
 * overflows V8's regexp stack on the hex of a transaction of about 3.5 MB, which is valid.
 */
const isHex = (value: string): boolean =>
  value.length % 2 === 0 && /^[0-9a-f]*$/.test(value);

export function malformed(what: string): ProviderError {
  return new ProviderError('PROVIDER_UNAVAILABLE', `malformed Esplora answer: ${what}`);
}

/** A definitive 404 (not an ambiguous or retried failure): the resource is not there. */
export function isNotFound(error: unknown): boolean {
  return (
    isCryptoAioError(error, 'RPC_ERROR') &&
    !error.ambiguous &&
    error.details?.status === 404
  );
}

const record = (value: unknown, what: string): Json => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw malformed(what);
  return value as Json;
};
const hash = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !HEX64.test(value)) throw malformed(what);
  return value;
};
const integer = (value: unknown, what: string, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw malformed(what);
  }
  return value as number;
};
const sats = (value: unknown, what: string): bigint =>
  BigInt(integer(value, what, Number(MAX_MONEY)));
const u32 = (value: unknown, what: string): number => integer(value, what, 0xffffffff);
/**
 * A transaction's 32-bit version, which Esplora servers print signed or unsigned, as one
 * signed value (`v | 0`), so both printings agree. Chain data: any version a block holds is
 * read, whatever this library builds (version 2).
 */
const txVersion = (value: unknown): number => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < -0x80000000 ||
    (value as number) > 0xffffffff
  ) {
    throw malformed('tx.version');
  }
  return (value as number) | 0;
};
/**
 * A cumulative total of an address (every output it ever received or spent), read exactly
 * (`exactIntegers`): a busy address's totals exceed 21 million bitcoin, and may exceed 2^53.
 */
const total = (value: unknown, what: string): bigint => {
  if (typeof value === 'bigint') {
    if (value < 0n) throw malformed(what);
    return value;
  }
  return BigInt(integer(value, what));
};

export function parseHeight(text: unknown): bigint {
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(text.trim())) {
    throw malformed('block height');
  }
  return BigInt(text.trim());
}

export function parseHash(text: unknown): string {
  return hash(typeof text === 'string' ? text.trim() : text, 'block hash');
}

export function parseStatus(value: unknown): EsploraStatus {
  const status = record(value, 'status');
  if (typeof status.confirmed !== 'boolean') throw malformed('status.confirmed');
  if (!status.confirmed) return { confirmed: false };
  return {
    confirmed: true,
    blockHeight: BigInt(integer(status.block_height, 'status.block_height')),
    blockHash: hash(status.block_hash, 'status.block_hash'),
    ...(status.block_time !== undefined && status.block_time !== null
      ? { blockTime: integer(status.block_time, 'status.block_time') }
      : {}),
  };
}

function parseOutput(value: unknown): EsploraOutput {
  const output = record(value, 'vout');
  if (typeof output.scriptpubkey !== 'string' || !isHex(output.scriptpubkey)) {
    throw malformed('vout.scriptpubkey');
  }
  if (typeof output.scriptpubkey_type !== 'string')
    throw malformed('vout.scriptpubkey_type');
  const address = output.scriptpubkey_address;
  if (address !== undefined && address !== null && typeof address !== 'string') {
    throw malformed('vout.scriptpubkey_address');
  }
  return {
    script: output.scriptpubkey,
    type: output.scriptpubkey_type,
    ...(typeof address === 'string' ? { address } : {}),
    value: sats(output.value, 'vout.value'),
  };
}

function parseInput(value: unknown): EsploraInput {
  const input = record(value, 'vin');
  // It decides whether the input has a previous output and the transaction a fee.
  if (typeof input.is_coinbase !== 'boolean') throw malformed('vin.is_coinbase');
  const coinbase = input.is_coinbase;
  return {
    txid: hash(input.txid, 'vin.txid'),
    vout: u32(input.vout, 'vin.vout'),
    coinbase,
    sequence: u32(input.sequence, 'vin.sequence'),
    ...(coinbase ? {} : { prevout: parseOutput(input.prevout) }),
  };
}

export function parseTx(value: unknown): EsploraTx {
  const tx = record(value, 'tx');
  if (!Array.isArray(tx.vin) || !Array.isArray(tx.vout)) throw malformed('tx.vin/vout');
  return {
    txid: hash(tx.txid, 'tx.txid'),
    version: txVersion(tx.version),
    locktime: u32(tx.locktime, 'tx.locktime'),
    weight: integer(tx.weight, 'tx.weight'),
    // Esplora answers `fee` for every transaction (0 for a coinbase): missing is malformed.
    fee: sats(tx.fee, 'tx.fee'),
    vin: tx.vin.map(parseInput),
    vout: tx.vout.map(parseOutput),
    status: parseStatus(tx.status),
  };
}

function parseBlock(value: unknown): EsploraBlock {
  const block = record(value, 'block');
  const height = BigInt(integer(block.height, 'block.height'));
  return {
    hash: hash(block.id, 'block.id'),
    height,
    parentHash:
      height === 0n && block.previousblockhash === null
        ? '0'.repeat(64)
        : hash(block.previousblockhash, 'block.previousblockhash'),
    timestamp: integer(block.timestamp, 'block.timestamp'),
    txCount: integer(block.tx_count, 'block.tx_count'),
  };
}

export function parseOutspend(value: unknown): EsploraOutspend {
  const spend = record(value, 'outspend');
  if (typeof spend.spent !== 'boolean') throw malformed('outspend.spent');
  if (!spend.spent) return { spent: false };
  return {
    spent: true,
    txid: hash(spend.txid, 'outspend.txid'),
    vin: u32(spend.vin, 'outspend.vin'),
    status: parseStatus(spend.status),
  };
}

function parseUtxo(value: unknown): EsploraUtxo {
  const utxo = record(value, 'utxo');
  return {
    txid: hash(utxo.txid, 'utxo.txid'),
    vout: u32(utxo.vout, 'utxo.vout'),
    value: sats(utxo.value, 'utxo.value'),
    status: parseStatus(utxo.status),
  };
}

function list<T>(value: unknown, what: string, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw malformed(what);
  return value.map(parse);
}

/** Esplora's `/fee-estimates`: confirmation target (blocks) → sat/vB (a float). */
export function parseFeeEstimates(value: unknown): ReadonlyMap<number, number> {
  const estimates = record(value, 'fee-estimates');
  const out = new Map<number, number>();
  for (const [target, rate] of Object.entries(estimates)) {
    if (!/^[1-9][0-9]{0,3}$/.test(target)) throw malformed('fee-estimates target');
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1e7) {
      throw malformed('fee-estimates rate');
    }
    out.set(Number(target), rate);
  }
  return out;
}

/** Whether a caller's id is a txid or block hash (64 lowercase hex characters). */
export const isHash = (value: unknown): value is string =>
  typeof value === 'string' && HEX64.test(value);

/**
 * I2: a URL path segment from a caller must be exactly an id or an address, so no `..`, `/`
 * or query can reach another route. The reader maps a malformed id to "not found" first.
 */
function segment(value: string, kind: 'id' | 'address'): string {
  if (kind === 'id' && !isHash(value)) {
    throw new ValidationError(
      'INVALID_INTENT',
      'a transaction or block id must be 64 lowercase hex digits',
    );
  }
  if (kind === 'address' && !/^[0-9A-Za-z]{1,90}$/.test(value)) {
    throw new ValidationError('INVALID_ADDRESS', 'invalid Bitcoin address');
  }
  return value;
}

/** One Esplora endpoint family (the `rpc` transport) and its address index (`indexer`). */
export class EsploraClient {
  constructor(
    private readonly chain: Transport,
    private readonly indexer: Transport,
  ) {}

  #get<T>(
    transport: Transport,
    path: string,
    route: string,
    tags: UtxoCallTags,
    responseType: 'json' | 'text' = 'json',
    exactIntegers = false,
  ): Promise<T> {
    const request: HttpRequest = { method: 'GET', path, route, responseType };
    return transport.http<T>(request, exactIntegers ? { ...tags, exactIntegers } : tags);
  }

  async #orNull<T>(work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async tipHeight(tags: UtxoCallTags): Promise<bigint> {
    return parseHeight(
      await this.#get(
        this.chain,
        '/blocks/tip/height',
        '/blocks/tip/height',
        tags,
        'text',
      ),
    );
  }

  /** The hash of the block at `height` on this endpoint's best chain, or `null` above its tip. */
  blockHashAt(height: bigint, tags: UtxoCallTags): Promise<string | null> {
    return this.#orNull(async () =>
      parseHash(
        await this.#get(
          this.chain,
          `/block-height/${height}`,
          '/block-height/:height',
          tags,
          'text',
        ),
      ),
    );
  }

  block(blockHash: string, tags: UtxoCallTags): Promise<EsploraBlock | null> {
    return this.#orNull(async () => {
      const block = parseBlock(
        await this.#get(
          this.chain,
          `/block/${segment(blockHash, 'id')}`,
          '/block/:hash',
          tags,
        ),
      );
      // I2: the answer must be the block asked for.
      if (block.hash !== blockHash) throw malformed('block.id');
      return block;
    });
  }

  async blockTxids(blockHash: string, tags: UtxoCallTags): Promise<string[]> {
    const ids = await this.#get(
      this.chain,
      `/block/${segment(blockHash, 'id')}/txids`,
      '/block/:hash/txids',
      tags,
    );
    return list(ids, 'txids', (id) => hash(id, 'txid'));
  }

  /** Up to 25 transactions of a block from `start` (a multiple of 25). */
  async blockTxs(
    blockHash: string,
    start: number,
    tags: UtxoCallTags,
  ): Promise<EsploraTx[]> {
    const txs = await this.#get(
      this.chain,
      `/block/${segment(blockHash, 'id')}/txs/${start}`,
      '/block/:hash/txs/:start',
      tags,
    );
    return list(txs, 'block txs', parseTx);
  }

  tx(txid: string, tags: UtxoCallTags): Promise<EsploraTx | null> {
    return this.#orNull(async () => {
      const tx = parseTx(
        await this.#get(this.chain, `/tx/${segment(txid, 'id')}`, '/tx/:txid', tags),
      );
      // I2: the answer must be the transaction asked for.
      if (tx.txid !== txid) throw malformed('tx.txid');
      return tx;
    });
  }

  /**
   * The raw transaction, as hex, bound to `txid`: bytes that do not decode strictly are
   * malformed, and the bytes of another transaction are a retryable `PROVIDER_INCONSISTENT`,
   * so a garbled answer is never taken for the caller's error. The decoder's cap is the
   * largest transaction a block can hold (lesson 20), never what this library builds.
   */
  txHex(txid: string, tags: UtxoCallTags): Promise<string | null> {
    return this.#orNull(async () => {
      const answer = await this.#get(
        this.chain,
        `/tx/${segment(txid, 'id')}/hex`,
        '/tx/:txid/hex',
        tags,
        'text',
      );
      const hex = typeof answer === 'string' ? answer.trim() : '';
      if (hex.length === 0 || !isHex(hex)) throw malformed('tx hex');
      let id: string;
      try {
        // Strict: capped at the largest transaction a block holds before decoding (lesson
        // 20), and no bytes after the transaction.
        id = txidOfHex(hex);
      } catch {
        throw malformed('tx hex');
      }
      if (id !== txid) {
        throw new ProviderError(
          'PROVIDER_INCONSISTENT',
          'the transaction bytes do not hash to the id asked for',
          { retryable: true },
        );
      }
      return hex;
    });
  }

  async outspend(
    txid: string,
    vout: number,
    tags: UtxoCallTags,
  ): Promise<EsploraOutspend> {
    return parseOutspend(
      await this.#get(
        this.chain,
        `/tx/${segment(txid, 'id')}/outspend/${vout}`,
        '/tx/:txid/outspend/:vout',
        tags,
      ),
    );
  }

  async feeEstimates(tags: UtxoCallTags): Promise<ReadonlyMap<number, number>> {
    return parseFeeEstimates(
      await this.#get(this.chain, '/fee-estimates', '/fee-estimates', tags),
    );
  }

  /** `POST /tx`: the node's txid on success; a node refusal is the transport's `RPC_ERROR`. */
  async broadcast(hex: string, tags: UtxoCallTags): Promise<string> {
    const answer = await this.chain.http<string>(
      { method: 'POST', path: '/tx', route: '/tx', body: hex, responseType: 'text' },
      tags,
    );
    if (typeof answer !== 'string' || !HEX64.test(answer.trim())) {
      // The node answered 2xx, so the bytes may have been accepted (R16).
      throw new ProviderError(
        'PROVIDER_UNAVAILABLE',
        'malformed Esplora answer: broadcast txid',
        {
          ambiguous: true,
        },
      );
    }
    return answer.trim();
  }

  async addressUtxos(address: string, tags: UtxoCallTags): Promise<EsploraUtxo[]> {
    const utxos = await this.#get(
      this.indexer,
      `/address/${segment(address, 'address')}/utxo`,
      '/address/:address/utxo',
      tags,
    );
    return list(utxos, 'utxo list', parseUtxo);
  }

  async addressStats(address: string, tags: UtxoCallTags): Promise<EsploraAddressStats> {
    const info = record(
      await this.#get(
        this.indexer,
        `/address/${segment(address, 'address')}`,
        '/address/:address',
        tags,
        'json',
        true,
      ),
      'address',
    );
    const chain = record(info.chain_stats, 'chain_stats');
    const funded = total(chain.funded_txo_sum, 'funded_txo_sum');
    const spent = total(chain.spent_txo_sum, 'spent_txo_sum');
    // The totals are unbounded; the balance is the chain's: 0 to 21 million bitcoin.
    if (spent > funded || funded - spent > MAX_MONEY) throw malformed('address balance');
    return { funded, spent };
  }

  /** Confirmed history, newest first, 25 per page, after `lastSeen` when given. */
  async addressTxs(
    address: string,
    lastSeen: string | undefined,
    tags: UtxoCallTags,
  ): Promise<EsploraTx[]> {
    const base = `/address/${segment(address, 'address')}/txs/chain`;
    const path = lastSeen ? `${base}/${segment(lastSeen, 'id')}` : base;
    const route = lastSeen
      ? '/address/:address/txs/chain/:last_seen_txid'
      : '/address/:address/txs/chain';
    return list(await this.#get(this.indexer, path, route, tags), 'address txs', parseTx);
  }
}
