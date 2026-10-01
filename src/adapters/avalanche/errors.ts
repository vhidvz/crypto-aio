/**
 * Broadcast classification (pure). AvalancheGo answers a refused `issueTx` with a JSON-RPC
 * error (-32000) whose message is its Go error chain, e.g. `couldn't issue tx: failed
 * verification: failed to read consumed UTXO …: not found` (P-Chain) or `failed to get
 * utxo …: not found` (X-Chain); the texts below are AvalancheGo's (`vms/txs/mempool`,
 * `vms/components/avax`, `vms/platformvm/utxo`, `vms/secp256k1fx`). A node answers a
 * duplicate with the id, as a success; the text is still recognized here.
 *
 * Lesson 21: a node's rejection is a claim. Every transaction this driver builds is checked
 * before it is signed and its signature verified by the core, so no answer here is
 * `rejected`: each is a `refused` (state-dependent, never terminal) with a code, and the core
 * first looks up the Attempt's own id (spec §8.2). Reasons are fixed texts (R24): the node's
 * carry ids and amounts.
 */
import type { BroadcastResult } from '../../core/driver/types';

/** Lesson 20: only a message's head is read. */
const MAX_MESSAGE = 1_024;

const RULES: readonly (readonly [RegExp, BroadcastResult])[] = [
  [/\bduplicate tx\b/, { kind: 'already-known' }],
  [
    /\binsufficient (?:unlocked )?funds\b/,
    {
      kind: 'refused',
      code: 'FEE_TOO_LOW',
      reason: 'the transaction burns less than the chain charges now',
    },
  ],
  [
    /\bfailed to (?:get|read consumed) utxo\b/i,
    {
      kind: 'refused',
      code: 'TX_REFUSED',
      reason: 'an input is already spent, or not known to the node yet',
    },
  ],
  [
    /\btx conflicts with other tx\b/,
    {
      kind: 'refused',
      code: 'TX_REFUSED',
      reason: 'it conflicts with a transaction in the mempool',
    },
  ],
  [
    /\bmempool is full\b/,
    { kind: 'refused', code: 'TX_REFUSED', reason: 'the node mempool is full' },
  ],
  [
    /\btx too large\b/,
    {
      kind: 'refused',
      code: 'TX_REFUSED',
      reason: 'the transaction is larger than the mempool takes',
    },
  ],
  [
    /\boutput is time locked\b/,
    { kind: 'refused', code: 'TX_REFUSED', reason: 'an input is still time locked' },
  ],
];

const DEFAULT: BroadcastResult = {
  kind: 'refused',
  code: 'TX_REFUSED',
  reason: 'the node refused the transaction',
};

export function classifyIssueError(message: string): BroadcastResult {
  const head = message.slice(0, MAX_MESSAGE);
  for (const [pattern, result] of RULES) if (pattern.test(head)) return result;
  return DEFAULT;
}
