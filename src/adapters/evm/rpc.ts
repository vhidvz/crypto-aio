/**
 * The clients' common path to the core transport. `EthersClient` (directly) and
 * `Web3Client` (through its EIP-1193 `request` object) end here, so each JSON-RPC
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
const TX = ['hash', 'blockHash', 'blockNumber', 'from', 'to', 'nonce'] as const;
const LOG = ['address', 'topics', 'data', 'logIndex'] as const;

const lowerCased = (value: unknown): unknown =>
  typeof value === 'string'
    ? value.toLowerCase()
    : Array.isArray(value)
      ? value.map(lowerCased)
      : value;

/** The `keys` of `value`, each lower-cased: hex case is formatting, not consensus. */
function lowerCasedFacts(value: unknown, keys: readonly string[]): unknown {
  const facts = pick(value, keys);
  return facts !== null && typeof facts === 'object'
    ? Object.fromEntries(
        Object.entries(facts).map(([key, fact]) => [key, lowerCased(fact)]),
      )
    : facts;
}

/**
 * A transaction's calldata as the client reads it: `input`, or `data` on older nodes,
 * lower-cased. The token verdict decodes it, so a key must compare it under
 * either name, or a first endpoint answering with `data` could alter it unseen.
 */
function calldataOf(tx: unknown): unknown {
  if (tx === null || typeof tx !== 'object') return null;
  const { input, data } = tx as Record<string, unknown>;
  return lowerCased(input ?? data ?? null);
}

/** A transaction's `keys`, lower-cased when `lower`, and its calldata as `input`. */
function txFacts(tx: unknown, keys: readonly string[], lower: boolean): unknown {
  if (tx === null || typeof tx !== 'object') return tx;
  const facts = (lower ? lowerCasedFacts(tx, keys) : pick(tx, keys)) as Record<
    string,
    unknown
  >;
  return { ...facts, input: calldataOf(tx) };
}

/**
 * A receipt's consensus facts include its logs, since a proven token verdict reads them:
 * one endpoint that drops or alters a `Transfer` log must disagree. Hex case is
 * formatting, not consensus, so each log's facts are compared lower-cased. A provider
 * that formats logs another way fails proofs, but only retryably.
 */
function receiptKey(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return result;
  const logs = (result as Record<string, unknown>).logs;
  return {
    ...(pick(result, RECEIPT) as Record<string, unknown>),
    logs: Array.isArray(logs) ? logs.map((log) => lowerCasedFacts(log, LOG)) : null,
  };
}

const BLOCK_TX = ['hash', 'from', 'nonce', 'to'] as const;

/**
 * The consensus facts of a block read with its transactions to find the one that
 * consumed a nonce: the block's number and hash, and each transaction's hash, sender and
 * nonce, with the recipient and calldata that the token verdict reads.
 */
export function blockTransactionsKey(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return result;
  const txs = (result as Record<string, unknown>).transactions;
  return {
    ...(lowerCasedFacts(result, ['number', 'hash']) as Record<string, unknown>),
    transactions: Array.isArray(txs)
      ? txs.map((tx) => txFacts(tx, BLOCK_TX, true))
      : null,
  };
}

const NATIVE_READ: EvmCallTags = { purpose: 'read', retry: 'safe' };
const NATIVE_BROADCAST: EvmCallTags = {
  purpose: 'broadcast',
  retry: 'ambiguous-on-failure',
};

/**
 * The tags of a `crypto-aio/native` client's request: plain reads, except a broadcast, which
 * is one: a failure after the transport may have delivered it is `ambiguous`, never an
 * invitation to sign again with a new nonce.
 */
export const nativeTags = (method: string): EvmCallTags =>
  method === 'eth_sendRawTransaction' ? NATIVE_BROADCAST : NATIVE_READ;

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
      return receiptKey;
    case 'eth_getBlockReceipts':
      return (result) => (Array.isArray(result) ? result.map(receiptKey) : result);
    case 'eth_getTransactionByHash':
      return (result) => txFacts(result, TX, false);
    default:
      return undefined;
  }
}

/**
 * One JSON-RPC call through the transport, under the calling driver method's tags. A quorum
 * compares the caller's own `quorumKey` when it gives one, else the method's consensus
 * facts; a key never travels without a quorum.
 */
export function transportCall(
  transport: Transport,
  method: string,
  params: unknown,
  tags: EvmCallTags,
): Promise<unknown> {
  const { quorumKey: own, ...rest } = tags;
  const quorumKey = rest.quorum !== undefined ? (own ?? quorumKeyFor(method)) : undefined;
  return transport.rpc(method, params ?? [], {
    ...rest,
    ...(quorumKey ? { quorumKey } : {}),
  });
}

/**
 * Runs `request` (an SDK call whose bridge ends in `call`) and, when its last transport call
 * failed, rethrows the transport's own error, never an SDK wrapper of it: web3 turns an
 * "execution reverted" error into a `ContractExecutionError`, which would lose the error's
 * code and ambiguity. A failure followed by a successful call is forgotten.
 */
export async function throughSdk<T>(
  request: (call: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
  transport: Transport,
  tags: EvmCallTags,
): Promise<T> {
  let failure: { readonly error: unknown } | undefined;
  const call = async (method: string, params: unknown): Promise<unknown> => {
    try {
      const result = await transportCall(transport, method, params, tags);
      // Only a failure the SDK did not recover from may replace the SDK's own error.
      failure = undefined;
      return result;
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
