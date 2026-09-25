/**
 * `EthersClient`: the ethers v6 strategy (the EVM default). Driver I/O goes straight to the
 * core transport under each call's tags (spec §11's fallback; R46): ethers' request queue
 * drains on a real 0 ms timer that fake-clock tests cannot step deterministically, and the
 * driver needs none of it (one request per call, D1). ethers does the codec work, and
 * `TransportJsonRpcProvider` (static network, no batching, no cache, no polling, `_send` →
 * transport) is the `crypto-aio/native` client.
 */
import {
  AbiCoder,
  Interface,
  JsonRpcApiProvider,
  Network,
  Signature,
  Transaction,
  computeAddress,
  getAddress,
  hexlify,
  isAddress,
  type JsonRpcPayload,
  type JsonRpcResult,
} from 'ethers';
import type { DisposableNativeClient } from '../../core/driver/types';
import type { Transport } from '../../core/transport/types';
import {
  ABI_WORD,
  ADDRESS,
  EvmClientBase,
  transferLogWords,
  uncompressedPublicKey,
} from './client';
import { NATIVE_TAGS, transportCall } from './rpc';
import type { EvmAbi, EvmCallTags, EvmSignature, EvmTxFields } from './types';

type Call = (method: string, params: unknown) => Promise<unknown>;

/** The ethers provider bridged onto the core transport through `call`: the native client only (R46). */
export class TransportJsonRpcProvider extends JsonRpcApiProvider {
  readonly #call: Call;

  constructor(network: Network, call: Call) {
    super(network, { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1 });
    this.#call = call;
    this._start();
  }

  override async _send(
    payload: JsonRpcPayload | JsonRpcPayload[],
  ): Promise<JsonRpcResult[]> {
    const results: JsonRpcResult[] = [];
    for (const item of Array.isArray(payload) ? payload : [payload]) {
      results.push({ id: item.id, result: await this.#call(item.method, item.params) });
    }
    return results;
  }
}

const coder = AbiCoder.defaultAbiCoder();
const erc20 = new Interface([
  'function transfer(address to, uint256 amount)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
]);
const gasPriceOracle = new Interface([
  'function getL1Fee(bytes data) view returns (uint256)',
]);
const TRANSFER_TOPIC = erc20.getEvent('Transfer')?.topicHash as string;

const ethersAbi: EvmAbi = {
  transferTopic: TRANSFER_TOPIC,
  encodeTransfer: (to, amount) => erc20.encodeFunctionData('transfer', [to, amount]),
  encodeBalanceOf: (owner) => erc20.encodeFunctionData('balanceOf', [owner]),
  encodeDecimals: () => erc20.encodeFunctionData('decimals', []),
  encodeSymbol: () => erc20.encodeFunctionData('symbol', []),
  encodeGetL1Fee: (unsignedTx) =>
    gasPriceOracle.encodeFunctionData('getL1Fee', [unsignedTx]),
  decodeUint256: (data) => {
    if (!ABI_WORD.test(data)) throw new Error('not one ABI word');
    return coder.decode(['uint256'], data)[0] as bigint;
  },
  decodeString: (data) => coder.decode(['string'], data)[0] as string,
  decodeTransfer: (log) => {
    const words = transferLogWords(log, TRANSFER_TOPIC);
    if (!words) return null;
    return {
      from: getAddress(coder.decode(['address'], words.from)[0] as string),
      to: getAddress(coder.decode(['address'], words.to)[0] as string),
      amount: coder.decode(['uint256'], words.data)[0] as bigint,
    };
  },
};

function toEthers(tx: EvmTxFields, signature?: EvmSignature): Transaction {
  const common = {
    chainId: tx.chainId,
    nonce: Number(tx.nonce),
    to: tx.to,
    value: tx.value,
    data: tx.data,
    gasLimit: tx.gasLimit,
  };
  const built = Transaction.from(
    tx.type === 'eip1559'
      ? {
          ...common,
          type: 2,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        }
      : { ...common, type: 0, gasPrice: tx.gasPrice },
  );
  if (signature) built.signature = Signature.from(signature);
  return built;
}

export class EthersClient extends EvmClientBase {
  readonly library = 'ethers';
  readonly abi = ethersAbi;
  readonly #transport: Transport;
  readonly #network: Network;

  constructor(transport: Transport, chainId: bigint) {
    super(chainId);
    this.#transport = transport;
    // A plain network: ethers' known networks carry plugins (ENS, gas stations) we never use.
    this.#network = new Network('crypto-aio', chainId);
  }

  protected send(
    method: string,
    params: readonly unknown[],
    tags: EvmCallTags,
  ): Promise<unknown> {
    // R46: no SDK queue, and so no real timer, between a driver call and the transport.
    return transportCall(this.#transport, method, [...params], tags);
  }

  isAddress(value: string): boolean {
    return ADDRESS.test(value) && isAddress(value);
  }

  checksum(address: string): string {
    return this.checked(address, getAddress);
  }

  addressFromPublicKey(publicKey: Uint8Array): string {
    return computeAddress(hexlify(uncompressedPublicKey(publicKey)));
  }

  protected encodeUnsigned(tx: EvmTxFields): string {
    return toEthers(tx).unsignedSerialized;
  }

  protected hashUnsigned(tx: EvmTxFields): string {
    return toEthers(tx).unsignedHash;
  }

  protected encodeSigned(
    tx: EvmTxFields,
    signature: EvmSignature,
  ): { raw: string; hash: string } {
    const signed = toEthers(tx, signature);
    return { raw: signed.serialized, hash: signed.hash as string };
  }

  createNative(): DisposableNativeClient {
    const client = new TransportJsonRpcProvider(this.#network, (method, params) =>
      transportCall(this.#transport, method, params, NATIVE_TAGS),
    );
    return { client, close: () => client.destroy() };
  }
}
