/**
 * Classifies a node's answer to `eth_sendRawTransaction`. The patterns are
 * geth's texts (txpool and RPC), which the geth-derived clients of most built-in chains
 * share; an Ethereum endpoint may run any client, so a text not listed here falls to the
 * safe default, a generic refusal. The returned reasons are short, fixed texts: a
 * node's own text can carry addresses and amounts ("insufficient funds …: address 0x… have
 * … want …") and is never passed on. Every result is frozen, so no caller can alter a later
 * one.
 */
import type { BroadcastResult } from '../../core/driver/types';
import { readSentTx, signatureValuesValid, type EvmSentTx } from './rawtx';

type RefusalCode = Extract<BroadcastResult, { kind: 'refused' }>['code'];

const refused = (code: RefusalCode, reason: string): BroadcastResult =>
  Object.freeze({ kind: 'refused', code, reason });
const rejected = (reason: string): BroadcastResult =>
  Object.freeze({ kind: 'rejected', reason });

/** Success: the node already holds these bytes, or they are already mined. */
const ALREADY_KNOWN =
  /already known|known transaction|already imported|alreadyknown|already exists|already in chain/i;
const ALREADY_KNOWN_RESULT: BroadcastResult = Object.freeze({ kind: 'already-known' });

/**
 * State-dependent or node policy: the same bytes may become valid later or on another node,
 * or may already be included (observed only).
 */
const REFUSED: readonly (readonly [RegExp, BroadcastResult])[] = [
  [/nonce too low/i, refused('NONCE_CONFLICT', 'nonce too low')],
  [/nonce too high|nonce gap/i, refused('NONCE_TOO_HIGH', 'nonce too high')],
  [/insufficient funds/i, refused('INSUFFICIENT_FUNDS', 'insufficient funds')],
  [
    /replacement transaction underpriced/i,
    refused('FEE_TOO_LOW', 'replacement underpriced'),
  ],
  [
    /underpriced|fee too low|less than block base fee|gas price too low|below minimum/i,
    refused('FEE_TOO_LOW', 'fee too low'),
  ],
  // The block gas limit can rise.
  [
    /exceeds block gas limit/i,
    refused('TX_REFUSED', 'gas limit above the block gas limit'),
  ],
  // A pool gates types on the forks active at its head (a syncing node) and on its config.
  [
    /transaction type not supported|tx type not supported/i,
    refused('TX_REFUSED', 'unsupported transaction type'),
  ],
  // Arbitrum's intrinsic gas includes the L1 poster cost, which moves.
  [/intrinsic gas too low/i, refused('TX_REFUSED', 'gas limit below intrinsic gas')],
  // Node policy: another node may accept the same bytes.
  [/only replay-protected/i, refused('TX_REFUSED', 'replay protection required')],
  [/oversized data/i, refused('TX_REFUSED', 'transaction too large')],
];

/** A rejection and the check that confirms it for the bytes we sent. */
interface Rejection {
  readonly pattern: RegExp;
  readonly result: BroadcastResult;
  readonly holds: (sent: EvmSentTx | 'malformed', chainId: bigint) => boolean;
}

/**
 * Invalid by construction: these bytes can never be included on any node. Exact texts only,
 * so a state-dependent cause that merely shares a word is never taken for one of these.
 * `invalid chain id` comes first: geth wraps it as "invalid sender: invalid chain id …".
 */
const REJECTED: readonly Rejection[] = [
  {
    pattern: /invalid chain id/i,
    result: rejected('wrong chain id'),
    holds: (sent, chainId) =>
      sent !== 'malformed' && sent.chainId !== undefined && sent.chainId !== chainId,
  },
  {
    pattern: /invalid sender|invalid signature|invalid transaction v, r, s values/i,
    result: rejected('invalid signature'),
    holds: (sent) => sent !== 'malformed' && !signatureValuesValid(sent),
  },
  {
    pattern: /\brlp:|typed transaction too short/i,
    result: rejected('malformed transaction'),
    holds: (sent) => sent === 'malformed',
  },
  {
    pattern: /max priority fee per gas higher than max fee per gas|tip above fee cap/i,
    result: rejected('priority fee above the fee cap'),
    holds: (sent) =>
      sent !== 'malformed' &&
      sent.type === 2 &&
      (sent.maxPriorityFeePerGas as bigint) > (sent.maxFeePerGas as bigint),
  },
];

const REFUSED_BY_NODE = refused('TX_REFUSED', 'refused by the node');

/**
 * `rejected` ends an Attempt without proof, so any doubt falls toward `refused`: the
 * refusal patterns are checked first ("invalid sender: transaction type not supported" is a
 * refusal), and an unlisted text is a refusal.
 */
function classified(message: string): {
  readonly result: BroadcastResult;
  readonly rejection?: Rejection;
} {
  if (ALREADY_KNOWN.test(message)) return { result: ALREADY_KNOWN_RESULT };
  for (const [pattern, result] of REFUSED) {
    if (pattern.test(message)) return { result };
  }
  const rejection = REJECTED.find((entry) => entry.pattern.test(message));
  return rejection
    ? { result: rejection.result, rejection }
    : { result: REFUSED_BY_NODE };
}

/** The node's answer at its word (see `classifyOwnBroadcast` for the bytes we sent). */
export function classifyBroadcastError(message: string): BroadcastResult {
  return classified(message).result;
}

/** A rejection this driver cannot confirm for the bytes it sent: observed, never terminal. */
const UNCONFIRMED: BroadcastResult = refused(
  'TX_REFUSED',
  'the node claimed the transaction is invalid',
);

/**
 * A node's rejection is a claim. The answer to `sentHex`, the
 * bytes this driver sent on the network whose chain id is `chainId`: a `rejected` stands
 * only when its reason holds for those bytes, read SDK-free (`readSentTx`); otherwise it is a
 * refusal, so a lying endpoint that relays our bytes can never end the Operation and invite
 * a second payment. Every other answer is the node's, as `classifyBroadcastError` reads it.
 */
export function classifyOwnBroadcast(
  message: string,
  sentHex: string,
  chainId: bigint,
): BroadcastResult {
  const { result, rejection } = classified(message);
  if (!rejection) return result;
  const sent = readSentTx(sentHex);
  return sent !== undefined && rejection.holds(sent, chainId) ? result : UNCONFIRMED;
}
