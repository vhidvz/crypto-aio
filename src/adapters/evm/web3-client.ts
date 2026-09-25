/**
 * `Web3Client`: the web3 v4 strategy. Its I/O goes through an EIP-1193 provider object whose
 * `request` hands every call to the core transport (spec §11), one request manager per call
 * so each request carries that call's tags (R41). ChainSafe sunset web3.js in 2025 (4.16.0
 * is the last release, R44); ethers stays the default.
 */
import { Web3, core, eth, utils } from 'web3';
import type { DisposableNativeClient } from '../../core/driver/types';
import { ProviderError, isCryptoAioError } from '../../core/errors/error';
import type { Transport } from '../../core/transport/types';
import {
  ABI_WORD,
  ADDRESS,
  EvmClientBase,
  transferLogWords,
  uncompressedPublicKey,
} from './client';
import { NATIVE_TAGS, throughSdk, transportCall } from './rpc';
import type { EvmAbi, EvmCallTags, EvmSignature, EvmTxFields } from './types';

interface Eip1193Provider {
  request(args: { readonly method: string; readonly params?: unknown }): Promise<unknown>;
}

/** An EIP-1193 provider bridged onto the core transport through `call`. */
function eip1193(
  call: (method: string, params: unknown) => Promise<unknown>,
): Eip1193Provider {
  // M10: an async function, so web3 4.16 takes its EIP-1193 path (it checks the
  // function's constructor name), not its legacy request-provider path.
  return { request: async ({ method, params }) => call(method, params) };
}

const fn = (name: string, inputs: readonly string[]) => ({
  name,
  type: 'function',
  inputs: inputs.map((type, i) => ({ type, name: `a${i}` })),
});
const TRANSFER_TOPIC = eth.abi.encodeEventSignature('Transfer(address,address,uint256)');

const web3Abi: EvmAbi = {
  transferTopic: TRANSFER_TOPIC,
  encodeTransfer: (to, amount) =>
    eth.abi.encodeFunctionCall(fn('transfer', ['address', 'uint256']), [to, amount]),
  encodeBalanceOf: (owner) =>
    eth.abi.encodeFunctionCall(fn('balanceOf', ['address']), [owner]),
  encodeDecimals: () => eth.abi.encodeFunctionCall(fn('decimals', []), []),
  encodeSymbol: () => eth.abi.encodeFunctionCall(fn('symbol', []), []),
  encodeGetL1Fee: (unsignedTx) =>
    eth.abi.encodeFunctionCall(fn('getL1Fee', ['bytes']), [unsignedTx]),
  decodeUint256: (data) => {
    if (!ABI_WORD.test(data)) throw new Error('not one ABI word');
    return BigInt(eth.abi.decodeParameter('uint256', data) as bigint);
  },
  decodeString: (data) => eth.abi.decodeParameter('string', data) as string,
  decodeTransfer: (log) => {
    const words = transferLogWords(log, TRANSFER_TOPIC);
    if (!words) return null;
    const address = (word: string) =>
      utils.toChecksumAddress(eth.abi.decodeParameter('address', word) as string);
    return {
      from: address(words.from),
      to: address(words.to),
      amount: BigInt(eth.abi.decodeParameter('uint256', words.data) as bigint),
    };
  },
};

/** RLP of a list of byte strings (web3 exposes no RLP encoder; used for legacy payloads). */
function rlpList(items: readonly Uint8Array[]): Uint8Array {
  const length = (size: number, offset: number): number[] => {
    if (size < 56) return [offset + size];
    const bytes: number[] = [];
    for (let rest = size; rest > 0; rest = Math.floor(rest / 256))
      bytes.unshift(rest % 256);
    return [offset + 55 + bytes.length, ...bytes];
  };
  const encoded = items.map((item) =>
    item.length === 1 && (item[0] as number) < 0x80
      ? [...item]
      : [...length(item.length, 0x80), ...item],
  );
  const payload = encoded.flat();
  return Uint8Array.from([...length(payload.length, 0xc0), ...payload]);
}

export class Web3Client extends EvmClientBase {
  readonly library = 'web3';
  readonly abi = web3Abi;
  readonly #transport: Transport;
  readonly #common: InstanceType<typeof eth.accounts.Common>;

  constructor(transport: Transport, chainId: bigint) {
    super(chainId);
    this.#transport = transport;
    this.#common = eth.accounts.Common.custom(
      { chainId: Number(chainId), networkId: Number(chainId) },
      { hardfork: 'london' },
    );
  }

  protected send(
    method: string,
    params: readonly unknown[],
    tags: EvmCallTags,
  ): Promise<unknown> {
    return throughSdk(
      async (call) => {
        const manager = new core.Web3RequestManager(eip1193(call) as never);
        try {
          return await manager.send({ method, params: [...params] } as never);
        } catch (error) {
          // R61: web3 reads an answer shaped like a JSON-RPC error as an error of its own.
          // A transport failure is put back by `throughSdk`; anything else is the answer's.
          if (isCryptoAioError(error)) throw error;
          throw new ProviderError('PROVIDER_UNAVAILABLE', 'malformed JSON-RPC answer');
        }
      },
      this.#transport,
      tags,
    );
  }

  isAddress(value: string): boolean {
    return ADDRESS.test(value) && utils.isAddress(value);
  }

  checksum(address: string): string {
    return this.checked(address, (value) => {
      if (!utils.isAddress(value)) throw new Error('bad checksum');
      return utils.toChecksumAddress(value);
    });
  }

  addressFromPublicKey(publicKey: Uint8Array): string {
    // R58: the shared strict decode, so both clients refuse exactly the same keys.
    const digest = utils.keccak256(uncompressedPublicKey(publicKey).slice(1));
    return utils.toChecksumAddress(`0x${digest.slice(-40)}`);
  }

  protected encodeUnsigned(tx: EvmTxFields): string {
    const message = this.#tx(tx).getMessageToSign(false);
    return utils.bytesToHex(Array.isArray(message) ? rlpList(message) : message);
  }

  protected hashUnsigned(tx: EvmTxFields): string {
    return utils.bytesToHex(this.#tx(tx).getMessageToSign(true));
  }

  protected encodeSigned(
    tx: EvmTxFields,
    signature: EvmSignature,
  ): { raw: string; hash: string } {
    const signed = this.#tx(tx, signature);
    return {
      raw: utils.bytesToHex(signed.serialize()),
      hash: utils.bytesToHex(signed.hash()),
    };
  }

  createNative(): DisposableNativeClient {
    const call = (method: string, params: unknown) =>
      transportCall(this.#transport, method, params, NATIVE_TAGS);
    return { client: new Web3(eip1193(call) as never) };
  }

  #tx(tx: EvmTxFields, signature?: EvmSignature) {
    const common = {
      nonce: tx.nonce,
      to: tx.to,
      value: tx.value,
      data: tx.data,
      gasLimit: tx.gasLimit,
    };
    const options = { common: this.#common };
    if (tx.type === 'eip1559') {
      return eth.accounts.FeeMarketEIP1559Transaction.fromTxData(
        {
          ...common,
          chainId: tx.chainId,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          accessList: [],
          ...(signature
            ? { v: BigInt(signature.yParity), r: signature.r, s: signature.s }
            : {}),
        },
        options,
      );
    }
    const v = signature && this.chainId * 2n + 35n + BigInt(signature.yParity);
    return eth.accounts.Transaction.fromTxData(
      {
        ...common,
        gasPrice: tx.gasPrice,
        ...(signature ? { v, r: signature.r, s: signature.s } : {}),
      },
      options,
    );
  }
}
