/**
 * SDK-free types of the EVM family: the `ext.evm` API, fee details and overrides, and the
 * narrow `EvmClient` strategy that `EthersClient` and `Web3Client` implement (spec §15).
 * Nothing here imports an SDK, so the composition root can export these types.
 */
import type { DisposableNativeClient } from '../../core/driver/types';
import type { CallOptions } from '../../core/transport/types';

// R37: augment the registries through the package entry, as users do with 'crypto-aio'.
declare module '../../index' {
  interface ChainRegistry {
    ethereum: { family: 'evm'; network: 'mainnet' | 'sepolia' | 'hoodi' };
    bsc: { family: 'evm'; network: 'mainnet' | 'testnet' };
    polygon: { family: 'evm'; network: 'mainnet' | 'amoy' };
    avalanche: { family: 'evm'; network: 'mainnet' | 'fuji' };
    arbitrum: { family: 'evm'; network: 'mainnet' | 'sepolia' };
    optimism: { family: 'evm'; network: 'mainnet' | 'sepolia' };
    base: { family: 'evm'; network: 'mainnet' | 'sepolia' };
  }
  interface FamilyRegistry {
    evm: { library: 'ethers' | 'web3'; ext: EvmExt; fee: EvmFeeDetails };
  }
}

/** `bc.ext.evm`: the EVM family extension (spec §5.5). */
export interface EvmExt {
  readonly evm: {
    /** The account nonce at `latest` (default) or including the mempool (`pending`). */
    getNonce(address: string, block?: 'latest' | 'pending'): Promise<bigint>;
  };
}

/** `FeeEstimate.details` of the `evm-1559` and `evm-legacy` fee kinds (wei, gas units). */
export interface EvmFeeDetails {
  readonly gasLimit: bigint;
  /** `evm-1559` only. */
  readonly maxFeePerGas?: bigint;
  /** `evm-1559` only. */
  readonly maxPriorityFeePerGas?: bigint;
  /** `evm-1559` only: the base fee the estimate expects for the next block. */
  readonly baseFeePerGas?: bigint;
  /** `evm-legacy` only. */
  readonly gasPrice?: bigint;
  /** OP Stack networks: the L1 data fee estimate, also charged as `l1-data`. */
  readonly l1Fee?: bigint;
  /** The expected total cost in wei; the `network` charge is its upper bound. */
  readonly expected: bigint;
}

/**
 * An explicit EVM fee (`TransferIntent.fee`). It must match the network's fee model:
 * `evm-1559` networks take `{ maxFeePerGas, maxPriorityFeePerGas }`, `evm-legacy` networks
 * take `{ gasPrice }`. `gasLimit` replaces the node's gas estimate.
 */
export type EvmFeeOverride =
  | {
      readonly maxFeePerGas: bigint;
      readonly maxPriorityFeePerGas: bigint;
      readonly gasLimit?: bigint;
    }
  | { readonly gasPrice: bigint; readonly gasLimit?: bigint };

/**
 * The transport tags every EVM I/O call carries (R41): purpose, retry, quorum, fanout,
 * signal. Under a quorum, `quorumKey` replaces the method's consensus facts (`rpc.ts`) with
 * the caller's own projection, e.g. a proof's finality attestation (R74).
 */
export type EvmCallTags = Pick<
  CallOptions,
  'purpose' | 'retry' | 'quorum' | 'quorumKey' | 'fanout' | 'signal'
>;

/** A block number or a JSON-RPC block tag. */
export type EvmBlockTag = bigint | 'latest' | 'pending' | 'safe' | 'finalized';

export interface EvmBlock {
  readonly number: bigint;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp: number;
  readonly baseFeePerGas?: bigint;
  readonly transactions: readonly string[];
}

export interface EvmTx {
  readonly hash: string;
  readonly from: string;
  readonly to: string | null;
  readonly nonce: bigint;
  readonly value: bigint;
  readonly input: string;
  readonly type: number;
  readonly gasLimit: bigint;
  readonly gasPrice?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  readonly blockHash: string | null;
  readonly blockNumber: bigint | null;
}

export interface EvmFullBlock extends Omit<EvmBlock, 'transactions'> {
  readonly transactions: readonly EvmTx[];
}

export interface EvmLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly logIndex: number;
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly transactionHash: string;
  readonly removed: boolean;
}

export interface EvmReceipt {
  readonly transactionHash: string;
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly status: 0 | 1;
  readonly from: string;
  readonly to: string | null;
  readonly contractAddress: string | null;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  /** OP Stack receipts: the L1 data fee paid. */
  readonly l1Fee?: bigint;
  /** Arbitrum receipts: the part of `gasUsed` that paid for L1 data. */
  readonly gasUsedForL1?: bigint;
  readonly logs: readonly EvmLog[];
}

export interface EvmFeeHistory {
  readonly oldestBlock: bigint;
  /** One entry per block, plus the next block's base fee last. */
  readonly baseFeePerGas: readonly bigint[];
  /** Per block, the requested percentiles of the priority fees paid. */
  readonly reward: readonly (readonly bigint[])[];
  readonly gasUsedRatio: readonly number[];
}

export interface EvmCallRequest {
  readonly from?: string;
  readonly to: string;
  readonly value?: bigint;
  readonly data?: string;
}

interface EvmTxFieldsBase {
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
  readonly gasLimit: bigint;
}

/** The fields of an unsigned transaction: EIP-1559 (type 2) or legacy with EIP-155. */
export type EvmTxFields = EvmTxFieldsBase &
  (
    | {
        readonly type: 'eip1559';
        readonly maxFeePerGas: bigint;
        readonly maxPriorityFeePerGas: bigint;
      }
    | { readonly type: 'legacy'; readonly gasPrice: bigint }
  );

/** A secp256k1 signature: 32-byte `r` and `s` as 0x-hex, and the y parity (0 or 1). */
export interface EvmSignature {
  readonly r: string;
  readonly s: string;
  readonly yParity: 0 | 1;
}

/** ABI work for the ERC-20 calls and events the driver uses, done by the SDK. */
export interface EvmAbi {
  /** `keccak256("Transfer(address,address,uint256)")`. */
  readonly transferTopic: string;
  encodeTransfer(to: string, amount: bigint): string;
  encodeBalanceOf(owner: string): string;
  encodeDecimals(): string;
  encodeSymbol(): string;
  /** OP Stack `GasPriceOracle.getL1Fee(bytes)` over an unsigned serialized transaction. */
  encodeGetL1Fee(unsignedTx: string): string;
  /** Throws on data that is not one ABI `uint256` word. */
  decodeUint256(data: string): bigint;
  /** Throws on data that is not an ABI `string`. */
  decodeString(data: string): string;
  /** An ERC-20 `Transfer` log's parties and amount; `null` for any other log. */
  decodeTransfer(log: {
    readonly topics: readonly string[];
    readonly data: string;
  }): { readonly from: string; readonly to: string; readonly amount: bigint } | null;
}

/**
 * The EVM strategy (spec §15): the SDK-specific part of the EVM driver. I/O methods take
 * the call's transport tags and return plain data (bigint, hex strings, plain objects),
 * never SDK objects (R11); `null` means not found. Codec methods are synchronous.
 */
export interface EvmClient {
  readonly library: string;
  blockNumber(tags: EvmCallTags): Promise<bigint>;
  getBalance(address: string, block: EvmBlockTag, tags: EvmCallTags): Promise<bigint>;
  getTransactionCount(
    address: string,
    block: EvmBlockTag,
    tags: EvmCallTags,
  ): Promise<bigint>;
  call(request: EvmCallRequest, block: EvmBlockTag, tags: EvmCallTags): Promise<string>;
  estimateGas(request: EvmCallRequest, tags: EvmCallTags): Promise<bigint>;
  gasPrice(tags: EvmCallTags): Promise<bigint>;
  feeHistory(
    blockCount: number,
    newest: EvmBlockTag,
    percentiles: readonly number[],
    tags: EvmCallTags,
  ): Promise<EvmFeeHistory>;
  /** By number or tag, or by hash when `block` is a 0x-prefixed 32-byte hash. */
  getBlock(block: EvmBlockTag | string, tags: EvmCallTags): Promise<EvmBlock | null>;
  getBlockWithTransactions(
    block: bigint,
    tags: EvmCallTags,
  ): Promise<EvmFullBlock | null>;
  getTransaction(hash: string, tags: EvmCallTags): Promise<EvmTx | null>;
  getReceipt(hash: string, tags: EvmCallTags): Promise<EvmReceipt | null>;
  getLogs(
    filter: { readonly blockHash: string; readonly topics: readonly (string | null)[] },
    tags: EvmCallTags,
  ): Promise<readonly EvmLog[]>;
  /** Resolves with the transaction hash the node reports. */
  sendRawTransaction(raw: string, tags: EvmCallTags): Promise<string>;
  /** Strict: `0x` and 40 hex digits; mixed case must be a valid EIP-55 checksum. */
  isAddress(value: string): boolean;
  /** EIP-55 checksum form; throws on an invalid address. */
  checksum(address: string): string;
  /** From a 33-byte compressed or 65-byte uncompressed secp256k1 public key. */
  addressFromPublicKey(publicKey: Uint8Array): string;
  serializeUnsigned(tx: EvmTxFields): string;
  /** The keccak-256 digest a signer signs. */
  unsignedHash(tx: EvmTxFields): string;
  serializeSigned(
    tx: EvmTxFields,
    signature: EvmSignature,
  ): { readonly raw: string; readonly hash: string };
  readonly abi: EvmAbi;
  /** A fresh SDK client on the same transport, for `crypto-aio/native` (R34). */
  createNative(): DisposableNativeClient;
}
