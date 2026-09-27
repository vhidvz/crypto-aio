/**
 * Broadcast classification (pure). Esplora forwards bitcoind's `sendrawtransaction` error as
 * an HTTP 400 body, in one of two formats:
 * - Blockstream electrs: `sendrawtransaction RPC error -26: min relay fee not met, 100 < 141`
 * - mempool/electrs: `sendrawtransaction RPC error: {"code":-26,"message":"min relay fee …"}`
 *
 * Lesson 3 (R63/R64): `rejected` only for exact, anchored reject reasons that make these
 * bytes invalid by consensus on every node (bitcoind's `CheckTransaction` and consensus
 * script checks, and an undecodable transaction); everything that depends on state, policy
 * or node configuration is `refused`, which is also the default for unknown texts. A
 * `rejected` reason counts only under the code bitcoind answers it with, so a text outside
 * bitcoind's structured answer never ends an Attempt. Reasons are fixed literals: bitcoind's
 * texts carry txids, amounts and fee rates (R24).
 */
import type { BroadcastResult } from '../../core/driver/types';

export interface NodeError {
  readonly code?: number;
  readonly message: string;
}

/**
 * Lesson 20: only a body's head is read. bitcoind's code and reject reason come first and its
 * texts are far shorter; unbounded, the mempool/electrs pattern is quadratic in the length.
 */
const MAX_BODY = 1_024;

/**
 * The bitcoind error inside an Esplora 400 body, or the body's head when it is neither
 * format.
 */
export function parseNodeError(body: string): NodeError {
  const text = body.slice(0, MAX_BODY).trim();
  const json = /RPC error: (\{.*\})$/s.exec(text);
  if (json) {
    try {
      const parsed = JSON.parse(json[1] as string) as {
        code?: unknown;
        message?: unknown;
      };
      if (typeof parsed.message === 'string') {
        return {
          ...(typeof parsed.code === 'number' ? { code: parsed.code } : {}),
          message: parsed.message,
        };
      }
    } catch {
      // Fall through: not the mempool/electrs format after all.
    }
  }
  // The transport keeps only the first 300 characters of a 400 body (`details.body`), which
  // leaves the JSON of a long message unterminated: its code and the head of its message
  // classify it as the Blockstream format of the same answer does.
  const cut = /RPC error: \{"code":(-?\d+),"message":"(.*)$/s.exec(text);
  if (cut) return { code: Number(cut[1]), message: cut[2] as string };
  const plain = /RPC error (-?\d+): (.*)$/s.exec(text);
  if (plain) return { code: Number(plain[1]), message: plain[2] as string };
  return { message: text };
}

/** A reject reason at the start of the message, followed by nothing, `,`, `.` or a space. */
const reason = (...names: readonly string[]): RegExp =>
  new RegExp(
    `^(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:$|,| \\(|\\.| )`,
  );

const ALREADY_KNOWN = reason(
  'txn-already-in-mempool',
  'txn-already-known',
  'txn-same-nonwitness-data-in-mempool',
  'Transaction outputs already in utxo set',
  'Transaction already in block chain',
);

/**
 * Consensus failures of these exact bytes (bitcoind `CheckTransaction`, consensus scripts),
 * each under the code bitcoind answers it with: -26 (`RPC_VERIFY_REJECTED`, a mempool
 * rejection) or -22 (`RPC_DESERIALIZATION_ERROR`, undecodable hex).
 */
const REJECTED: readonly (readonly [number, RegExp, string])[] = [
  [
    -26,
    reason(
      'bad-txns-vin-empty',
      'bad-txns-vout-empty',
      'bad-txns-oversize',
      'bad-txns-vout-negative',
      'bad-txns-vout-toolarge',
      'bad-txns-txouttotal-toolarge',
      'bad-txns-inputs-duplicate',
      'bad-txns-prevout-null',
      'bad-txns-in-belowout',
      'bad-txns-inputvalues-outofrange',
      'bad-txns-fee-outofrange',
      'coinbase',
    ),
    'invalid by consensus rules',
  ],
  [
    -26,
    reason('mandatory-script-verify-flag-failed', 'block-script-verify-flag-failed'),
    'script verification failed',
  ],
  [-22, reason('TX decode failed'), 'the transaction does not decode'],
];

const FEE_TOO_LOW = reason(
  'min relay fee not met',
  'mempool min fee not met',
  'insufficient fee',
);
const SPENT = reason(
  'bad-txns-inputs-missingorspent',
  'Missing inputs',
  'Inputs missing or spent',
  'txn-mempool-conflict',
  'bad-txns-spends-conflicting-tx',
);

export function classifyBroadcast(error: NodeError): BroadcastResult {
  const message = error.message.trim();
  if (ALREADY_KNOWN.test(message) || error.code === -27) return { kind: 'already-known' };
  for (const [code, pattern, text] of REJECTED) {
    if (error.code === code && pattern.test(message))
      return { kind: 'rejected', reason: text };
  }
  if (FEE_TOO_LOW.test(message)) {
    return { kind: 'refused', code: 'FEE_TOO_LOW', reason: 'fee too low for the node' };
  }
  if (SPENT.test(message)) {
    return {
      kind: 'refused',
      code: 'TX_REFUSED',
      reason: 'inputs missing or already spent',
    };
  }
  return {
    kind: 'refused',
    code: 'TX_REFUSED',
    reason: 'the node refused the transaction',
  };
}
