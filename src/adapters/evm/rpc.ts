/**
 * The clients' common path to the core transport (spec §11, R41). `EthersClient` (directly,
 * R46) and `Web3Client` (through its EIP-1193 `request` object) end here, so each JSON-RPC
 * call carries the purpose, retry class, quorum, fanout and signal of the driver method that
 * made it.
 */
import type { Transport } from '../../core/transport/types';
import type { EvmCallTags } from './types';

type Json = Record<string, unknown> | null;

const pick = (value: unknown, keys: readonly string[]): unknown => {
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(keys.map((key) => [key, record[key] ?? null]));
};

const BLOCK = ['number', 'hash', 'parentHash', 'timestamp'] as const;
const RECEIPT = ['transactionHash', 'blockHash', 'blockNumber', 'status'] as const;
const TX = ['hash', 'blockHash', 'blockNumber', 'from', 'to', 'input', 'nonce'] as const;

/** The tags of a `crypto-aio/native` client's requests: plain reads. */
export const NATIVE_TAGS: EvmCallTags = { purpose: 'read', retry: 'safe' };

/**
 * The consensus facts compared under a quorum, per JSON-RPC method. Node implementations
 * return extra or differently formatted fields (`size`, `totalDifficulty`, L2 extras), so a
 * quorum over whole objects would report disagreement where there is none.
 */
export function quorumKeyFor(method: string): ((result: unknown) => unknown) | undefined {
  switch (method) {
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash':
      return (result) => pick(result as Json, BLOCK);
    case 'eth_getTransactionReceipt':
      return (result) => pick(result as Json, RECEIPT);
    case 'eth_getTransactionByHash':
      return (result) => pick(result as Json, TX);
    default:
      return undefined;
  }
}

/** One JSON-RPC call through the transport, under the calling driver method's tags. */
export function transportCall(
  transport: Transport,
  method: string,
  params: unknown,
  tags: EvmCallTags,
): Promise<unknown> {
  const quorumKey = tags.quorum !== undefined ? quorumKeyFor(method) : undefined;
  return transport.rpc(method, params ?? [], {
    ...tags,
    ...(quorumKey ? { quorumKey } : {}),
  });
}

/**
 * Runs `request` (an SDK call whose bridge ends in `call`) and rethrows the transport's own
 * error when there is one, never an SDK wrapper of it: web3 turns an "execution reverted"
 * error into a `ContractExecutionError`, which would lose the error's code and ambiguity.
 */
export async function throughSdk<T>(
  request: (call: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
  transport: Transport,
  tags: EvmCallTags,
): Promise<T> {
  let failure: { readonly error: unknown } | undefined;
  const call = async (method: string, params: unknown): Promise<unknown> => {
    try {
      return await transportCall(transport, method, params, tags);
    } catch (error) {
      failure = { error };
      throw error;
    }
  };
  try {
    return await request(call);
  } catch (error) {
    throw failure ? failure.error : error;
  }
}
