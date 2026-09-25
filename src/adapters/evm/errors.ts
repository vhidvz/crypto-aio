/**
 * Classifies a node's answer to `eth_sendRawTransaction` (spec §7, §8.2). The patterns are
 * geth's texts (txpool and RPC), which the geth-derived clients of most built-in chains
 * share; an Ethereum endpoint may run any client, so a text not listed here falls to the
 * safe default, a generic refusal. The returned reasons are short, fixed texts (R24): a
 * node's own text can carry addresses and amounts ("insufficient funds …: address 0x… have
 * … want …") and is never passed on. Every result is frozen, so no caller can alter a later
 * one.
 */
import type { BroadcastResult } from '../../core/driver/types';

type RefusalCode = Extract<BroadcastResult, { kind: 'refused' }>['code'];

const refused = (code: RefusalCode, reason: string): BroadcastResult =>
  Object.freeze({ kind: 'refused', code, reason });
const rejected = (reason: string): BroadcastResult =>
  Object.freeze({ kind: 'rejected', reason });

/** Success (spec §8.4): the node already holds these bytes, or they are already mined. */
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

/**
 * Invalid by construction: these bytes can never be included on any node. Exact texts only,
 * so a state-dependent cause that merely shares a word is never taken for one of these.
 * `invalid chain id` comes first: geth wraps it as "invalid sender: invalid chain id …".
 */
const REJECTED: readonly (readonly [RegExp, BroadcastResult])[] = [
  [/invalid chain id/i, rejected('wrong chain id')],
  [
    /invalid sender|invalid signature|invalid transaction v, r, s values/i,
    rejected('invalid signature'),
  ],
  [/\brlp:|typed transaction too short/i, rejected('malformed transaction')],
  [
    /max priority fee per gas higher than max fee per gas|tip above fee cap/i,
    rejected('priority fee above the fee cap'),
  ],
];

const REFUSED_BY_NODE = refused('TX_REFUSED', 'refused by the node');

/**
 * `rejected` ends an Attempt without proof, so any doubt falls toward `refused`: the
 * refusal patterns are checked first ("invalid sender: transaction type not supported" is a
 * refusal), and an unlisted text is a refusal.
 */
export function classifyBroadcastError(message: string): BroadcastResult {
  if (ALREADY_KNOWN.test(message)) return ALREADY_KNOWN_RESULT;
  for (const [pattern, result] of REFUSED) {
    if (pattern.test(message)) return result;
  }
  for (const [pattern, result] of REJECTED) {
    if (pattern.test(message)) return result;
  }
  return REFUSED_BY_NODE;
}
