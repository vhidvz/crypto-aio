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
 *
 * Lesson 21 (F3-R11): a node's rejection is a claim. `classifyBroadcast` takes the node at its
 * word; `classifyOwnBroadcast` keeps a `rejected` only when the claimed reason holds for the
 * bytes that were sent, checked here, and makes every other one `refused` (non-terminal).
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

/** bitcoind's -22 (`RPC_DESERIALIZATION_ERROR`) reason: the hex does not decode. */
const DECODE_FAILED = 'TX decode failed';

/**
 * Consensus failures of these exact bytes (bitcoind `CheckTransaction`, consensus scripts),
 * each under the code bitcoind answers it with: -26 (`RPC_VERIFY_REJECTED`, a mempool
 * rejection) or -22 (`RPC_DESERIALIZATION_ERROR`, undecodable hex).
 */
const REJECTED: readonly (readonly [number, readonly string[], string])[] = [
  [
    -26,
    [
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
    ],
    'invalid by consensus rules',
  ],
  [
    -26,
    ['mandatory-script-verify-flag-failed', 'block-script-verify-flag-failed'],
    'script verification failed',
  ],
  [-22, [DECODE_FAILED], 'the transaction does not decode'],
];

/** Each rejected reason's own anchored pattern, with the code and the verdict text. */
const CLAIMS: readonly (readonly [number, string, RegExp, string])[] = REJECTED.flatMap(
  ([code, names, text]) => names.map((name) => [code, name, reason(name), text] as const),
);

/** The rejected reason bitcoind's answer claims, or `undefined` when it claims none. */
function claimOf(error: NodeError, message: string) {
  return CLAIMS.find(([code, , pattern]) => error.code === code && pattern.test(message));
}

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
  const claim = claimOf(error, message);
  if (claim) return { kind: 'rejected', reason: claim[3] };
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

/**
 * A transaction's bytes as bitcoind's byte-only checks read them (lesson 21), decoded here
 * from the hex that was sent: its outpoints, its output values as signed 64-bit integers, and
 * its size without witness data.
 */
export interface TxBytes {
  readonly inputs: readonly { readonly txid: string; readonly vout: number }[];
  readonly values: readonly bigint[];
  readonly strippedSize: number;
}

/** Bitcoin Core's `MAX_MONEY` and `MAX_BLOCK_WEIGHT`. */
const MAX_MONEY = 2_100_000_000_000_000n;
const MAX_BLOCK_WEIGHT = 4_000_000;
const NULL_TXID = '0'.repeat(64);

const isNull = (input: TxBytes['inputs'][number]): boolean =>
  input.txid === NULL_TXID && input.vout === 0xffffffff;
const isCoinbase = (tx: TxBytes): boolean =>
  tx.inputs.length === 1 && isNull(tx.inputs[0] as TxBytes['inputs'][number]);

/**
 * bitcoind's reasons the bytes alone decide (`CheckTransaction`, and ATMP's `coinbase`), each
 * as bitcoind tests it. The others (`bad-txns-in-belowout`, `-inputvalues-outofrange`,
 * `-fee-outofrange` and every script check) depend on the spent outputs, and have no rule: the
 * builder spends only outputs whose value and script their previous transaction authenticates
 * (every input, every wallet type, whatever `nonWitnessUtxo` says: F3-R14), and the core
 * verifies every signature, so they cannot hold for our own bytes, and a node that claims one
 * is not believed.
 */
const BYTE_RULES: Readonly<Record<string, (tx: TxBytes) => boolean>> = {
  'bad-txns-vin-empty': (tx) => tx.inputs.length === 0,
  'bad-txns-vout-empty': (tx) => tx.values.length === 0,
  'bad-txns-oversize': (tx) => tx.strippedSize * 4 > MAX_BLOCK_WEIGHT,
  'bad-txns-vout-negative': (tx) => tx.values.some((value) => value < 0n),
  'bad-txns-vout-toolarge': (tx) => tx.values.some((value) => value > MAX_MONEY),
  'bad-txns-txouttotal-toolarge': (tx) =>
    tx.values.every((value) => value >= 0n && value <= MAX_MONEY) &&
    tx.values.reduce((sum, value) => sum + value, 0n) > MAX_MONEY,
  'bad-txns-inputs-duplicate': (tx) =>
    new Set(tx.inputs.map((input) => `${input.txid}:${input.vout}`)).size <
    tx.inputs.length,
  'bad-txns-prevout-null': (tx) => !isCoinbase(tx) && tx.inputs.some(isNull),
  coinbase: isCoinbase,
};

/** A rejection this driver cannot confirm for the bytes it sent: observed, never terminal. */
const UNCONFIRMED: BroadcastResult = {
  kind: 'refused',
  code: 'TX_REFUSED',
  reason: 'the node claimed the transaction is invalid',
};

/**
 * Lesson 21: the node's answer to bytes this driver sent, `bytes` being those bytes decoded
 * strictly (`undefined` when they do not decode). A terminal `rejected` frees the Attempt's
 * inputs for a caller's retry, and if a lying or buggy endpoint relayed the bytes before it
 * claimed them invalid, the retry and the original can both confirm: a double payment. So a
 * rejection stands only when its claimed reason holds for `bytes`: an undecodable hex for
 * `TX decode failed`, a byte rule for a `CheckTransaction` reason. Anything else is `refused`.
 */
export function classifyOwnBroadcast(
  error: NodeError,
  bytes: TxBytes | undefined,
): BroadcastResult {
  const result = classifyBroadcast(error);
  if (result.kind !== 'rejected') return result;
  const name = claimOf(error, error.message.trim())?.[1];
  if (name === DECODE_FAILED) return bytes === undefined ? result : UNCONFIRMED;
  const rule =
    name !== undefined && Object.hasOwn(BYTE_RULES, name) ? BYTE_RULES[name] : undefined;
  return bytes !== undefined && rule?.(bytes) ? result : UNCONFIRMED;
}
