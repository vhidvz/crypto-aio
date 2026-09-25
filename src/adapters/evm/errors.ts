/**
 * Classifies a node's answer to `eth_sendRawTransaction` (spec §7, §8.2). The messages are
 * geth's txpool errors, which the geth-derived clients of every built-in chain share. The
 * returned reasons are short, fixed texts (R24): a node's own text can carry addresses and
 * amounts ("insufficient funds …: address 0x… have … want …") and is never passed on.
 */
import type { BroadcastResult } from '../../core/driver/types';

/** Success (spec §8.4): the node already holds these bytes, or they are already mined. */
const ALREADY_KNOWN =
  /already known|known transaction|already imported|alreadyknown|already exists|already in chain/i;

/** Permanently invalid by construction: these bytes can never be included anywhere. */
const REJECTED: readonly (readonly [RegExp, string])[] = [
  [/invalid chain id|chain id mismatch|only replay-protected/i, 'wrong chain id'],
  [/invalid sender|invalid signature|signature/i, 'invalid signature'],
  [
    /rlp|malformed|decode|typed transaction too short|invalid transaction/i,
    'malformed transaction',
  ],
  [
    /transaction type not supported|tx type not supported/i,
    'unsupported transaction type',
  ],
  [/intrinsic gas too low/i, 'gas limit below intrinsic gas'],
  [/oversized data/i, 'transaction too large'],
  [
    /max priority fee per gas higher than max fee per gas|tip above fee cap/i,
    'priority fee above the fee cap',
  ],
];

/** State-dependent: may become valid later, or may already be included (observed only). */
const REFUSED: readonly (readonly [RegExp, BroadcastResult & { kind: 'refused' }])[] = [
  [
    /nonce too low/i,
    { kind: 'refused', code: 'NONCE_CONFLICT', reason: 'nonce too low' },
  ],
  [
    /nonce too high|nonce gap/i,
    { kind: 'refused', code: 'NONCE_TOO_HIGH', reason: 'nonce too high' },
  ],
  [
    /insufficient funds/i,
    { kind: 'refused', code: 'INSUFFICIENT_FUNDS', reason: 'insufficient funds' },
  ],
  [
    /replacement transaction underpriced/i,
    { kind: 'refused', code: 'FEE_TOO_LOW', reason: 'replacement underpriced' },
  ],
  [
    /underpriced|fee too low|less than block base fee|gas price too low|below minimum/i,
    { kind: 'refused', code: 'FEE_TOO_LOW', reason: 'fee too low' },
  ],
  // The block gas limit can rise, so this is not permanent.
  [
    /exceeds block gas limit/i,
    {
      kind: 'refused',
      code: 'TX_REFUSED',
      reason: 'gas limit above the block gas limit',
    },
  ],
];

/**
 * `rejected` ends an Attempt without proof, so any doubt falls toward `refused`: the
 * state-dependent patterns are checked first ("invalid transaction: insufficient funds"
 * is a refusal, not a malformed transaction).
 */
export function classifyBroadcastError(message: string): BroadcastResult {
  if (ALREADY_KNOWN.test(message)) return { kind: 'already-known' };
  for (const [pattern, result] of REFUSED) {
    if (pattern.test(message)) return result;
  }
  for (const [pattern, reason] of REJECTED) {
    if (pattern.test(message)) return { kind: 'rejected', reason };
  }
  return { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' };
}
