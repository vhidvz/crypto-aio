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
const HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x[0-9a-fA-F]+$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;

type Json = Record<string, unknown>;

function malformed(field: string): ProviderError {
  return new ProviderError(
    'PROVIDER_UNAVAILABLE',
    `malformed ${field} in a JSON-RPC answer`,
  );
}

function quantity(value: unknown, field: string): bigint {
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
const ADDRESS_WORD = /^0x0{24}[0-9a-fA-F]{40}$/;

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

  /** One JSON-RPC request through the SDK's bridge, under `tags`; resolves with `result`. */
  protected abstract send(
    method: string,
    params: readonly unknown[],
    tags: EvmCallTags,
  ): Promise<unknown>;

  abstract isAddress(value: string): boolean;
  abstract checksum(address: string): string;
  abstract addressFromPublicKey(publicKey: Uint8Array): string;
  abstract serializeUnsigned(tx: EvmTxFields): string;
  abstract unsignedHash(tx: EvmTxFields): string;
  abstract serializeSigned(
    tx: EvmTxFields,
    signature: EvmSignature,
  ): { readonly raw: string; readonly hash: string };
  abstract createNative(): DisposableNativeClient;

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
    return {
      ...this.#header(json),
      transactions: this.#list(json.transactions, 'block transactions').map((t) =>
        this.#tx(object(t, 'transaction')),
      ),
    };
  }

  async getTransaction(txHash: string, tags: EvmCallTags): Promise<EvmTx | null> {
    const result = await this.send('eth_getTransactionByHash', [txHash], tags);
    return result === null ? null : this.#tx(object(result, 'transaction'));
  }

  async getReceipt(txHash: string, tags: EvmCallTags): Promise<EvmReceipt | null> {
    const result = await this.send('eth_getTransactionReceipt', [txHash], tags);
    if (result === null) return null;
    const json = object(result, 'receipt');
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
      input: data(json.input ?? json.data ?? '0x', 'input'),
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
