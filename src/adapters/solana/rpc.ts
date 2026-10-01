/**
 * The Solana driver's path to the core transport. Every JSON-RPC call
 * is one direct `transport.rpc` call carrying the tags of the `ChainDriver` method that made
 * it; `@solana/web3.js` is never on a request path. Answers are validated here: a malformed
 * answer is a retryable `PROVIDER_UNAVAILABLE`, never a foreign error.
 */
import {
  ProviderError,
  isCryptoAioError,
  type CryptoAioError,
} from '../../core/errors/error';
import type { Transport } from '../../core/transport/types';
import { canonicalJson } from '../../core/util/json';
import type { Commitment, SolanaCallTags } from './types';

export const READ: SolanaCallTags = Object.freeze({ purpose: 'read', retry: 'safe' });
export const MONITOR: SolanaCallTags = Object.freeze({
  purpose: 'monitor',
  retry: 'safe',
});
export const PROOF: SolanaCallTags = Object.freeze({
  purpose: 'proof',
  retry: 'safe',
  quorum: 'proof',
});
export const BROADCAST: SolanaCallTags = Object.freeze({
  purpose: 'broadcast',
  retry: 'ambiguous-on-failure',
});

export const withSignal = (tags: SolanaCallTags, signal?: AbortSignal): SolanaCallTags =>
  signal ? { ...tags, signal } : tags;

/** Solana's JSON-RPC server errors (agave `rpc-client-api/src/custom_error.rs`). */
export const RPC_CODES = Object.freeze({
  BLOCK_CLEANED_UP: -32001,
  SEND_TRANSACTION_PREFLIGHT_FAILURE: -32002,
  TRANSACTION_SIGNATURE_VERIFICATION_FAILURE: -32003,
  BLOCK_NOT_AVAILABLE: -32004,
  SLOT_SKIPPED: -32007,
  LONG_TERM_STORAGE_SLOT_SKIPPED: -32009,
  TRANSACTION_HISTORY_NOT_AVAILABLE: -32011,
  BLOCK_STATUS_NOT_AVAILABLE_YET: -32014,
  MIN_CONTEXT_SLOT_NOT_REACHED: -32016,
  LONG_TERM_STORAGE_UNREACHABLE: -32019,
  FILTER_TRANSACTION_NOT_FOUND: -32020,
});

/** "Not yet": the endpoint has not reached that slot or state. */
const NOT_YET = new Set<number>([
  RPC_CODES.BLOCK_NOT_AVAILABLE,
  RPC_CODES.BLOCK_STATUS_NOT_AVAILABLE_YET,
  RPC_CODES.MIN_CONTEXT_SLOT_NOT_REACHED,
]);

/** "No longer, or never here": pruned, not in long-term storage, or no history at all. */
const GONE = new Set<number>([
  RPC_CODES.BLOCK_CLEANED_UP,
  RPC_CODES.LONG_TERM_STORAGE_SLOT_SKIPPED,
  RPC_CODES.TRANSACTION_HISTORY_NOT_AVAILABLE,
  RPC_CODES.LONG_TERM_STORAGE_UNREACHABLE,
]);

/** The JSON-RPC code of a definitive, non-ambiguous `RPC_ERROR`; otherwise `undefined`. */
export function rpcCode(error: unknown): number | undefined {
  if (!isCryptoAioError(error, 'RPC_ERROR') || error.ambiguous) return undefined;
  const code = error.details?.rpcCode;
  return typeof code === 'number' ? code : undefined;
}

/** The node's message of a definitive, non-ambiguous `RPC_ERROR`. */
export function rpcMessage(error: CryptoAioError): string {
  return String(error.details?.rpcMessage ?? error.message);
}

const hasCode = (error: unknown, codes: ReadonlySet<number>): boolean => {
  const code = rpcCode(error);
  return code !== undefined && codes.has(code);
};

/** The endpoint has not reached that block or state yet (`null`, decides nothing). */
export const isNotYet = (error: unknown): boolean => hasCode(error, NOT_YET);

/** The endpoint no longer holds that block or history, or never did (decides nothing). */
export const isGone = (error: unknown): boolean => hasCode(error, GONE);

/** The endpoint says the slot was skipped, or is missing on this endpoint (`-32007`). */
export const isSkipped = (error: unknown): boolean =>
  rpcCode(error) === RPC_CODES.SLOT_SKIPPED;

/** Any answer meaning "this endpoint cannot show that": it never decides anything. */
export const isNotAvailable = (error: unknown): boolean =>
  isNotYet(error) || isGone(error) || isSkipped(error);

/** A retryable error that decides nothing: the endpoint no longer holds what was asked. */
export const gone = (what: string) =>
  new ProviderError('PROVIDER_UNAVAILABLE', `the endpoint no longer holds ${what}`);

/** A retryable error that decides nothing: the endpoints cannot show this yet. */
export const notYet = (what: string) =>
  new ProviderError('PROVIDER_UNAVAILABLE', `the endpoints cannot show ${what} yet`);

/**
 * On a proof path only a definitive negative proof answers "no". Any
 * other definitive RPC error (agave 4.3.0's `getBlocks` answers `-32602 "BigTable query
 * failed"` for a range below its local ledger, `-32603` on a blockstore error) decides
 * nothing: it becomes a retryable `PROVIDER_UNAVAILABLE`. Every other error (retryable
 * ones, `PROVIDER_MISCONFIGURED`) is returned unchanged.
 */
export function undecided(error: unknown, what: string): unknown {
  if (!isCryptoAioError(error, 'RPC_ERROR')) return error;
  return new ProviderError(
    'PROVIDER_UNAVAILABLE',
    `the endpoints cannot show ${what}: ${rpcMessage(error)}`,
    {
      cause: error,
      context: error.context,
      ...(error.details ? { details: error.details } : {}),
    },
  );
}

export const malformed = (what: string) =>
  new ProviderError('PROVIDER_UNAVAILABLE', `malformed ${what} answer`);

export const inconsistent = (what: string) =>
  new ProviderError('PROVIDER_INCONSISTENT', what, { retryable: true });

/** A JSON object's fields, or `null` for anything else (arrays and `null` included). */
export const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * An unsigned 64-bit JSON integer (lamports, slots, heights) as a `bigint`. Every call
 * parses with `exactIntegers`, so a value above 2^53 − 1 arrives as a `bigint`; a
 * number outside the safe range was rounded somewhere and is refused as malformed.
 */
export function u64(value: unknown, what: string): bigint {
  if (typeof value === 'bigint' && value >= 0n && value < 2n ** 64n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw malformed(what);
}

/** A decimal string of base units (token amounts), as a `bigint`. */
export function amountString(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw malformed(what);
  }
  const amount = BigInt(value);
  if (amount >= 2n ** 64n) throw malformed(what);
  return amount;
}

/** The `value` of an RPC response with context (`{ context: { slot }, value }`). */
export function contextValue(result: unknown, what: string): unknown {
  const body = record(result);
  if (!body || !record(body.context) || !('value' in body)) throw malformed(what);
  return body.value;
}

/** A block header as `getBlock` returns it with `transactionDetails: 'none'`. */
export interface BlockHeader {
  readonly blockhash: string;
  readonly previousBlockhash: string;
  readonly parentSlot: bigint;
  readonly blockHeight: bigint;
  /** Unix seconds, when the node estimates one. */
  readonly blockTime?: number;
}

export function blockHeader(result: unknown): BlockHeader {
  const block = record(result);
  if (!block) throw malformed('getBlock');
  const { blockhash, previousBlockhash, parentSlot, blockHeight, blockTime } = block;
  if (typeof blockhash !== 'string' || typeof previousBlockhash !== 'string') {
    throw malformed('getBlock');
  }
  // Blocks from before block heights were recorded (2020) carry `blockHeight: null`.
  if (blockHeight === null) throw malformed('getBlock (no block height)');
  return {
    blockhash,
    previousBlockhash,
    parentSlot: u64(parentSlot, 'parent slot'),
    blockHeight: u64(blockHeight, 'block height'),
    ...(typeof blockTime === 'number' && Number.isSafeInteger(blockTime)
      ? { blockTime }
      : {}),
  };
}

export const pick = (value: unknown, keys: readonly string[]): unknown => {
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(keys.map((key) => [key, object[key] ?? null]));
};

/** The consensus fields of a block header, compared under a quorum. */
export const BLOCK_FIELDS = [
  'blockhash',
  'previousBlockhash',
  'parentSlot',
  'blockHeight',
] as const;

/** The token-program instructions (outer and inner) projected to what a verdict reads. */
function tokenInstructions(tx: Record<string, unknown>): unknown[] {
  const message = record(record(tx.transaction)?.message);
  const meta = record(tx.meta);
  const outer = Array.isArray(message?.instructions) ? message.instructions : [];
  const inner = Array.isArray(meta?.innerInstructions)
    ? meta.innerInstructions.flatMap((group) => {
        const list = record(group)?.instructions;
        return Array.isArray(list) ? list : [];
      })
    : [];
  return [...outer, ...inner].flatMap((ix) => {
    const instruction = record(ix);
    const parsed = record(instruction?.parsed);
    const info = record(parsed?.info);
    if (instruction?.program !== 'spl-token' || !parsed || !info) return [];
    return [
      {
        programId: instruction.programId ?? null,
        type: parsed.type ?? null,
        source: info.source ?? null,
        destination: info.destination ?? null,
        authority: info.authority ?? info.multisigAuthority ?? null,
        mint: info.mint ?? null,
        amount: info.amount ?? record(info.tokenAmount)?.amount ?? null,
      },
    ];
  });
}

/** Token balances by account index (providers may list them in another order). */
const tokenBalances = (list: unknown): unknown =>
  Array.isArray(list)
    ? list
        .map((entry) => {
          const balance = record(entry);
          return {
            accountIndex: balance?.accountIndex ?? null,
            mint: balance?.mint ?? null,
            amount: record(balance?.uiTokenAmount)?.amount ?? null,
          };
        })
        .sort((a, b) => Number(a.accountIndex) - Number(b.accountIndex))
    : null;

/**
 * A finalized transaction's consensus facts, as far as a verdict reads them
 * (slot, error, signatures, account keys, token balances, token transfer instructions).
 * Formatting that honest providers differ on (`uiAmount` floats, `stackHeight`, `owner` and
 * `programId` on balances, log messages, compute units, `blockTime`) is left out. The landing
 * guard (`decode.ts`) still requires `programId` on the transfer's balances: providers must
 * report it (current agave does), and through one that leaves it out no SPL verdict ever
 * decides, which costs liveness only.
 */
function transactionKey(result: unknown): unknown {
  if (result === null) return null;
  const tx = record(result);
  if (!tx) throw malformed('getTransaction');
  const meta = record(tx.meta);
  const message = record(record(tx.transaction)?.message);
  const keys = Array.isArray(message?.accountKeys)
    ? message.accountKeys.map((key) => record(key)?.pubkey ?? key)
    : null;
  return {
    slot: tx.slot ?? null,
    err: canonicalJson(meta?.err ?? null),
    signatures: record(tx.transaction)?.signatures ?? null,
    accountKeys: keys,
    preTokenBalances: tokenBalances(meta?.preTokenBalances),
    postTokenBalances: tokenBalances(meta?.postTokenBalances),
    tokenInstructions: tokenInstructions(tx),
  };
}

/**
 * The consensus facts compared under a quorum, per method. A key that throws
 * counts as a disagreement (a retryable `PROVIDER_INCONSISTENT`).
 */
export function quorumKeyFor(method: string): ((result: unknown) => unknown) | undefined {
  switch (method) {
    case 'getBlock':
      return (result) => pick(result, BLOCK_FIELDS);
    case 'getTransaction':
      return transactionKey;
    default:
      return undefined;
  }
}

/**
 * One JSON-RPC call through the transport, under the calling driver method's tags. Solana
 * sends u64 values (lamports) as JSON numbers, so every answer is parsed with
 * `exactIntegers`: nothing above 2^53 − 1 is ever rounded.
 */
export function call(
  transport: Transport,
  method: string,
  params: readonly unknown[],
  tags: SolanaCallTags,
): Promise<unknown> {
  const quorumKey =
    tags.quorum !== undefined ? (tags.quorumKey ?? quorumKeyFor(method)) : undefined;
  return transport.rpc(method, params, {
    ...tags,
    ...(quorumKey ? { quorumKey } : {}),
    exactIntegers: true,
  });
}

/** `getBlock` options for a header (no transactions, no rewards). */
export const headerOptions = (commitment: Commitment) => ({
  commitment,
  transactionDetails: 'none',
  rewards: false,
});

/** `getBlock`/`getTransaction` options for decoding (every transaction version we parse). */
export const parsedOptions = (commitment: Commitment) => ({
  commitment,
  encoding: 'jsonParsed',
  maxSupportedTransactionVersion: 0,
});
