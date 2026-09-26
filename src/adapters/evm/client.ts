/**
 * The SDK-free half of every `EvmClient`: the JSON-RPC methods of spec §15 and the
 * normalization of their answers into plain data. A subclass supplies the SDK half: the
 * `send` bridge (the SDK's own JSON-RPC primitive, wired to the transport) and the codec.
 *
 * I/O never uses an SDK's high-level helpers: those
 * issue extra calls under the wrong tags (ethers `broadcastTransaction` also reads the block
 * number; `getTransactionReceipt` may fetch the transaction), throw on not-found (web3
 * `TransactionNotFound`) or drop chain fields the fees need (OP `l1Fee`, Arbitrum
 * `gasUsedForL1`). So one driver call is exactly one tagged JSON-RPC request (R41).
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import type { DisposableNativeClient } from '../../core/driver/types';
import { ProviderError, ValidationError } from '../../core/errors/error';
import type {
  EvmAbi,
  EvmBlock,
  EvmBlockTag,
  EvmCallRequest,
  EvmCallTags,
  EvmClient,
  EvmFeeHistory,
  EvmFullBlock,
  EvmLog,
  EvmReceipt,
  EvmSignature,
  EvmTx,
  EvmTxFields,
} from './types';

/** `0x` and 40 hex digits; the checksum is the SDK's to check. */
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * R58: the 65-byte uncompressed form of a secp256k1 public key, accepted only as a 33-byte
 * compressed key (`0x02`/`0x03`) or a 65-byte `0x04` key that decodes to a point on the
 * curve. Both clients derive addresses from its result, never from the caller's bytes: an
 * SDK may read 32 bytes as a *private* key or 64 bytes as an unprefixed public key, and
 * either would yield an address nobody holds the key to. The error never echoes the input.
 */
export function uncompressedPublicKey(publicKey: Uint8Array): Uint8Array {
  const prefix = publicKey instanceof Uint8Array ? publicKey[0] : undefined;
  const shaped =
    ((prefix === 0x02 || prefix === 0x03) && publicKey.length === 33) ||
    (prefix === 0x04 && publicKey.length === 65);
  try {
    if (shaped) return secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false);
  } catch {
    // Not a point on the curve.
  }
  throw new ValidationError(
    'INVALID_ADDRESS',
    'public key must be a 33- or 65-byte secp256k1 point',
  );
}
const HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x[0-9a-fA-F]+$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const BLOOM = /^0x[0-9a-fA-F]{512}$/;

type Json = Record<string, unknown>;

function malformed(field: string): ProviderError {
  return new ProviderError(
    'PROVIDER_UNAVAILABLE',
    `malformed ${field} in a JSON-RPC answer`,
  );
}

/**
 * A JSON-RPC quantity (`0x` and hex digits) as a bigint. Anything else throws a retryable
 * `PROVIDER_UNAVAILABLE` naming `field`: the one check of every hex quantity the driver
 * reads, quorum keys and health probes included (a key that throws is a disagreement).
 */
export function quantity(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw malformed(field);
  return BigInt(value);
}

function optionalQuantity(value: unknown, field: string): bigint | undefined {
  return value === undefined || value === null ? undefined : quantity(value, field);
}

function hash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw malformed(field);
  return value.toLowerCase();
}

function data(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DATA.test(value)) throw malformed(field);
  return value.toLowerCase();
}

function object(value: unknown, field: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw malformed(field);
  return value as Json;
}

/** One ABI word: 32 bytes. */
export const ABI_WORD = /^0x[0-9a-fA-F]{64}$/;
/** An ABI-encoded address: 12 zero bytes, then 20 address bytes. */
export const ADDRESS_WORD = /^0x0{24}[0-9a-fA-F]{40}$/;

/**
 * The three ABI words of an ERC-20 `Transfer` log (`from`, `to`, amount), or `null`. Anyone
 * can emit a look-alike event: anything but the topic and three well-formed words is not a
 * transfer, and never an error that would fail a whole block scan.
 */
export function transferLogWords(
  log: { readonly topics: readonly string[]; readonly data: string },
  topic: string,
): { readonly from: string; readonly to: string; readonly data: string } | null {
  const [first, from, to] = log.topics;
  if (
    log.topics.length !== 3 ||
    first !== topic ||
    !ADDRESS_WORD.test(from as string) ||
    !ADDRESS_WORD.test(to as string) ||
    !ABI_WORD.test(log.data)
  ) {
    return null;
  }
  return { from: from as string, to: to as string, data: log.data };
}

export function blockParam(block: EvmBlockTag): string {
  return typeof block === 'bigint' ? `0x${block.toString(16)}` : block;
}

const hexOf = (value: bigint): string => `0x${value.toString(16)}`;

export abstract class EvmClientBase implements EvmClient {
  abstract readonly library: string;
  abstract readonly abi: EvmAbi;
  /** The chain id of the network this client serves. */
  protected readonly chainId: bigint;

  constructor(chainId: bigint) {
    this.chainId = chainId;
  }

  /** One JSON-RPC request through the SDK's bridge, under `tags`; resolves with `result`. */
  protected abstract send(
    method: string,
    params: readonly unknown[],
    tags: EvmCallTags,
  ): Promise<unknown>;

  abstract isAddress(value: string): boolean;
  abstract checksum(address: string): string;
  abstract addressFromPublicKey(publicKey: Uint8Array): string;
  abstract createNative(): DisposableNativeClient;

  /** The SDK codec, reached only through the chain-id guard below. */
  protected abstract encodeUnsigned(tx: EvmTxFields): string;
  protected abstract hashUnsigned(tx: EvmTxFields): string;
  protected abstract encodeSigned(
    tx: EvmTxFields,
    signature: EvmSignature,
  ): { readonly raw: string; readonly hash: string };

  serializeUnsigned(tx: EvmTxFields): string {
    return this.encodeUnsigned(this.#onNetwork(tx));
  }

  unsignedHash(tx: EvmTxFields): string {
    return this.hashUnsigned(this.#onNetwork(tx));
  }

  serializeSigned(
    tx: EvmTxFields,
    signature: EvmSignature,
  ): { readonly raw: string; readonly hash: string } {
    return this.encodeSigned(this.#onNetwork(tx), signature);
  }

  /**
   * R61: a transaction for another chain is refused before any codec work. The SDKs
   * disagree about it: ethers commits to `tx.chainId`, web3 to the client's chain id (and
   * throws a plain `Error` for a type-2 mismatch), so without this guard the two clients
   * would produce different signing bytes for the same fields.
   */
  #onNetwork(tx: EvmTxFields): EvmTxFields {
    if (tx.chainId !== this.chainId) {
      throw new ValidationError(
        'INVALID_INTENT',
        'transaction chain id does not match the network',
      );
    }
    return tx;
  }

  /** Runs the SDK's checksum; `INVALID_ADDRESS` for anything but a valid hex address. */
  protected checked(address: string, checksum: (value: string) => string): string {
    try {
      if (ADDRESS.test(address)) return checksum(address);
    } catch {
      // A mixed-case address with a wrong checksum.
    }
    throw new ValidationError('INVALID_ADDRESS', 'not an EVM address');
  }

  async blockNumber(tags: EvmCallTags): Promise<bigint> {
    return quantity(await this.send('eth_blockNumber', [], tags), 'block number');
  }

  async getBalance(
    address: string,
    block: EvmBlockTag,
    tags: EvmCallTags,
  ): Promise<bigint> {
    const result = await this.send('eth_getBalance', [address, blockParam(block)], tags);
    return quantity(result, 'balance');
  }

  async getTransactionCount(
    address: string,
    block: EvmBlockTag,
    tags: EvmCallTags,
  ): Promise<bigint> {
    const params = [address, blockParam(block)];
    return quantity(await this.send('eth_getTransactionCount', params, tags), 'nonce');
  }

  async call(
    request: EvmCallRequest,
    block: EvmBlockTag,
    tags: EvmCallTags,
  ): Promise<string> {
    const result = await this.send(
      'eth_call',
      [this.#request(request), blockParam(block)],
      tags,
    );
    return data(result, 'call result');
  }

  async estimateGas(request: EvmCallRequest, tags: EvmCallTags): Promise<bigint> {
    return quantity(
      await this.send('eth_estimateGas', [this.#request(request)], tags),
      'gas',
    );
  }

  async gasPrice(tags: EvmCallTags): Promise<bigint> {
    return quantity(await this.send('eth_gasPrice', [], tags), 'gas price');
  }

  async feeHistory(
    blockCount: number,
    newest: EvmBlockTag,
    percentiles: readonly number[],
    tags: EvmCallTags,
  ): Promise<EvmFeeHistory> {
    const params = [hexOf(BigInt(blockCount)), blockParam(newest), [...percentiles]];
    const json = object(await this.send('eth_feeHistory', params, tags), 'fee history');
    const list = (value: unknown, field: string): unknown[] => {
      if (!Array.isArray(value)) throw malformed(field);
      return value;
    };
    return {
      oldestBlock: quantity(json.oldestBlock, 'oldest block'),
      baseFeePerGas: list(json.baseFeePerGas, 'base fees').map((v) =>
        quantity(v, 'base fee'),
      ),
      reward: list(json.reward ?? [], 'rewards').map((row) =>
        list(row, 'rewards').map((v) => quantity(v, 'reward')),
      ),
      gasUsedRatio: list(json.gasUsedRatio ?? [], 'gas used ratios').map((v) => {
        if (typeof v !== 'number') throw malformed('gas used ratio');
        return v;
      }),
    };
  }

  async getBlock(
    block: EvmBlockTag | string,
    tags: EvmCallTags,
  ): Promise<EvmBlock | null> {
    const byHash = typeof block === 'string' && HASH.test(block);
    const result = byHash
      ? await this.send('eth_getBlockByHash', [block, false], tags)
      : await this.send(
          'eth_getBlockByNumber',
          [blockParam(block as EvmBlockTag), false],
          tags,
        );
    if (result === null) return null;
    const json = object(result, 'block');
    return {
      ...this.#header(json),
      transactions: this.#list(json.transactions, 'block transactions').map((t) =>
        hash(typeof t === 'string' ? t : (t as Json | null)?.hash, 'transaction hash'),
      ),
    };
  }

  async getBlockWithTransactions(
    block: bigint,
    tags: EvmCallTags,
  ): Promise<EvmFullBlock | null> {
    const result = await this.send(
      'eth_getBlockByNumber',
      [blockParam(block), true],
      tags,
    );
    if (result === null) return null;
    const json = object(result, 'block');
    const { logsBloom } = json;
    return {
      ...this.#header(json),
      transactions: this.#list(json.transactions, 'block transactions').map((t) =>
        this.#tx(object(t, 'transaction')),
      ),
      // Only a hint for scans (R90): a missing or malformed bloom may hold anything.
      ...(typeof logsBloom === 'string' && BLOOM.test(logsBloom)
        ? { logsBloom: logsBloom.toLowerCase() }
        : {}),
    };
  }

  /** M2: an answer about another transaction is malformed, never another's facts. */
  async getTransaction(txHash: string, tags: EvmCallTags): Promise<EvmTx | null> {
    const result = await this.send('eth_getTransactionByHash', [txHash], tags);
    if (result === null) return null;
    const tx = this.#tx(object(result, 'transaction'));
    if (tx.hash !== txHash.toLowerCase()) throw malformed('transaction hash');
    return tx;
  }

  /** M2: an answer about another transaction is malformed, never another's receipt. */
  async getReceipt(txHash: string, tags: EvmCallTags): Promise<EvmReceipt | null> {
    const result = await this.send('eth_getTransactionReceipt', [txHash], tags);
    if (result === null) return null;
    const receipt = this.#receipt(object(result, 'receipt'));
    if (receipt.transactionHash !== txHash.toLowerCase()) {
      throw malformed('transaction hash');
    }
    return receipt;
  }

  async getBlockReceipts(
    blockHash: string,
    tags: EvmCallTags,
  ): Promise<readonly EvmReceipt[] | null> {
    const result = await this.send('eth_getBlockReceipts', [blockHash], tags);
    if (result === null) return null;
    return this.#list(result, 'block receipts').map((receipt) =>
      this.#receipt(object(receipt, 'receipt')),
    );
  }

  #receipt(json: Json): EvmReceipt {
    const status = quantity(json.status, 'receipt status');
    if (status !== 0n && status !== 1n) throw malformed('receipt status');
    const l1Fee = optionalQuantity(json.l1Fee, 'L1 fee');
    const gasUsedForL1 = optionalQuantity(json.gasUsedForL1, 'L1 gas');
    return {
      transactionHash: hash(json.transactionHash, 'transaction hash'),
      blockHash: hash(json.blockHash, 'block hash'),
      blockNumber: quantity(json.blockNumber, 'block number'),
      status: status === 1n ? 1 : 0,
      from: this.#address(json.from, 'sender'),
      to:
        json.to === null || json.to === undefined
          ? null
          : this.#address(json.to, 'recipient'),
      contractAddress:
        json.contractAddress === null || json.contractAddress === undefined
          ? null
          : this.#address(json.contractAddress, 'contract address'),
      gasUsed: quantity(json.gasUsed, 'gas used'),
      effectiveGasPrice: quantity(json.effectiveGasPrice, 'effective gas price'),
      ...(l1Fee !== undefined ? { l1Fee } : {}),
      ...(gasUsedForL1 !== undefined ? { gasUsedForL1 } : {}),
      logs: this.#list(json.logs, 'receipt logs').map((log) =>
        this.#log(object(log, 'log')),
      ),
    };
  }

  async getLogs(
    filter: { readonly blockHash: string; readonly topics: readonly (string | null)[] },
    tags: EvmCallTags,
  ): Promise<readonly EvmLog[]> {
    const params = [{ blockHash: filter.blockHash, topics: [...filter.topics] }];
    const result = await this.send('eth_getLogs', params, tags);
    return this.#list(result, 'logs').map((log) => this.#log(object(log, 'log')));
  }

  async sendRawTransaction(raw: string, tags: EvmCallTags): Promise<string> {
    return hash(
      await this.send('eth_sendRawTransaction', [raw], tags),
      'transaction hash',
    );
  }

  #request(request: EvmCallRequest): Json {
    return {
      ...(request.from !== undefined ? { from: request.from } : {}),
      to: request.to,
      ...(request.value !== undefined ? { value: hexOf(request.value) } : {}),
      ...(request.data !== undefined ? { data: request.data } : {}),
    };
  }

  #list(value: unknown, field: string): unknown[] {
    if (!Array.isArray(value)) throw malformed(field);
    return value;
  }

  #address(value: unknown, field: string): string {
    if (typeof value !== 'string' || !ADDRESS.test(value)) throw malformed(field);
    return this.checksum(value.toLowerCase());
  }

  #header(json: Json): Omit<EvmBlock, 'transactions'> {
    const baseFeePerGas = optionalQuantity(json.baseFeePerGas, 'base fee');
    return {
      number: quantity(json.number, 'block number'),
      hash: hash(json.hash, 'block hash'),
      parentHash: hash(json.parentHash, 'parent hash'),
      timestamp: Number(quantity(json.timestamp, 'timestamp')),
      ...(baseFeePerGas !== undefined ? { baseFeePerGas } : {}),
    };
  }

  #tx(json: Json): EvmTx {
    const gasPrice = optionalQuantity(json.gasPrice, 'gas price');
    const maxFeePerGas = optionalQuantity(json.maxFeePerGas, 'max fee');
    const maxPriorityFeePerGas = optionalQuantity(
      json.maxPriorityFeePerGas,
      'priority fee',
    );
    const blockHash = json.blockHash ?? null;
    const blockNumber = json.blockNumber ?? null;
    return {
      hash: hash(json.hash, 'transaction hash'),
      from: this.#address(json.from, 'sender'),
      to:
        json.to === null || json.to === undefined
          ? null
          : this.#address(json.to, 'recipient'),
      nonce: quantity(json.nonce, 'nonce'),
      value: quantity(json.value, 'value'),
      // M2: no calldata field is malformed, never an empty call (older nodes say `data`).
      input: data(json.input ?? json.data, 'input'),
      type: Number(optionalQuantity(json.type, 'type') ?? 0n),
      gasLimit: quantity(json.gas, 'gas limit'),
      ...(gasPrice !== undefined ? { gasPrice } : {}),
      ...(maxFeePerGas !== undefined ? { maxFeePerGas } : {}),
      ...(maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas } : {}),
      blockHash: blockHash === null ? null : hash(blockHash, 'block hash'),
      blockNumber: blockNumber === null ? null : quantity(blockNumber, 'block number'),
    };
  }

  #log(json: Json): EvmLog {
    return {
      address: this.#address(json.address, 'log address'),
      topics: this.#list(json.topics, 'log topics').map((t) => hash(t, 'log topic')),
      data: data(json.data, 'log data'),
      logIndex: Number(quantity(json.logIndex, 'log index')),
      blockHash: hash(json.blockHash, 'block hash'),
      blockNumber: quantity(json.blockNumber, 'block number'),
      transactionHash: hash(json.transactionHash, 'transaction hash'),
      removed: json.removed === true,
    };
  }
}
