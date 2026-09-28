/**
 * Broadcast classification (lesson 3, R24, R63/R64), pure. java-tron answers
 * `/wallet/broadcasthex` with HTTP 200 and `{ result: false, code, message }`, so the
 * transport never sees these as errors. The codes, texts and their order are java-tron's
 * (`Wallet.broadcastTransaction`, `Manager.pushTransaction` and `processTransaction`,
 * checked against GreatVoyage-v4.8.2.2, `d5c3d1d1`; Plan 4 Task 3's verified list).
 * - `rejected` only on definitive evidence: the refusal code plus an exact, anchored text
 *   that consensus also refuses for these bytes on every node at every time — a signature
 *   under 65 bytes, no contract, a transfer to self, a non-positive amount, or a size over
 *   the constant 512,000-byte limit. Numbers in those texts must show the defect: a text
 *   that contradicts itself decides nothing.
 * - Refusal codes java-tron gives before it pools the transaction are `refused`, the
 *   default for any text: account state, permissions, chain parameters and node policy
 *   can change.
 * - Node-local codes (busy, not connected, not solidified, "P2P broadcast failed.", which
 *   java-tron returns after it pooled the transaction), `OTHER_ERROR` (its catch-all, which
 *   also covers a failure after pooling) and any empty or unknown code are thrown as a
 *   retryable `PROVIDER_UNAVAILABLE` marked `ambiguous`: possibly sent, even for a bare
 *   `Blockchain.broadcast` caller.
 * Nothing here decides from text alone (P25-R21): the code gates every result. Reasons are
 * fixed literals: no address, amount, transaction id or node text. Every pattern is
 * anchored and linear (lesson 20), whatever the message's length.
 */
import type { BroadcastResult } from '../../core/driver/types';
import { ProviderError } from '../../core/errors/error';
import type { BroadcastAnswer } from './http';

type RefusalCode = Extract<BroadcastResult, { kind: 'refused' }>['code'];

const refused = (code: RefusalCode, reason: string): BroadcastResult =>
  Object.freeze({ kind: 'refused', code, reason });
const rejected = (reason: string): BroadcastResult =>
  Object.freeze({ kind: 'rejected', reason });

const ACCEPTED: BroadcastResult = Object.freeze({ kind: 'accepted' });
/** `Dup transaction.`, or `Transaction already exists.` from the id cache: never a failure. */
const ALREADY_KNOWN: BroadcastResult = Object.freeze({ kind: 'already-known' });

/** `Constant.PER_SIGN_LENGTH`: consensus (`TransactionCapsule.checkWeight`) refuses less. */
const MIN_SIGNATURE_BYTES = 65;
/** `Constant.TRANSACTION_MAX_BYTE_SIZE` (500 KiB). */
const MAX_TX_BYTES = 512_000;
/** `Constant.MAX_RESULT_SIZE_IN_TX` × 2, which the "with result" size check adds. */
const RESULT_BYTES = 128;

interface Permanent {
  readonly code: string;
  readonly text: RegExp;
  /** For a text with a number: whether the number shows the defect (else it decides nothing). */
  readonly shows?: (value: number) => boolean;
  readonly result: BroadcastResult;
}

const PERMANENT: readonly Permanent[] = [
  {
    // Admission refuses sizes outside 65–68 (`SignUtils.isValidLength`), but consensus keeps
    // `size < 65` (its own comment: longer historical signatures carry padding), so only a
    // shorter signature is invalid everywhere.
    code: 'SIGERROR',
    text: /^Validate signature error: Signature size is (0|[1-9]\d{0,9})$/,
    shows: (size) => size < MIN_SIGNATURE_BYTES,
    result: rejected('malformed signature'),
  },
  {
    // `Wallet.broadcastTransaction`: no contract at all (TransferActuator's use of the same
    // text needs a missing parameter, which a parsed transaction never has).
    code: 'CONTRACT_VALIDATE_ERROR',
    text: /^Contract validate error : No contract!$/,
    result: rejected('no contract'),
  },
  {
    code: 'CONTRACT_VALIDATE_ERROR',
    text: /^Contract validate error : Cannot transfer TRX to yourself\.$/,
    result: rejected('transfer to self'),
  },
  {
    code: 'CONTRACT_VALIDATE_ERROR',
    text: /^Contract validate error : Amount must be greater than 0\.$/,
    result: rejected('non-positive amount'),
  },
  {
    // `Manager.validateCommon`, applied in blocks too: the whole transaction.
    code: 'TOO_BIG_TRANSACTION_ERROR',
    text: /^Too big transaction, TxId [0-9a-f]{64}, the size is (0|[1-9]\d{0,18}) bytes, maxTxSize 512000$/,
    shows: (size) => size > MAX_TX_BYTES,
    result: rejected('transaction too large'),
  },
  {
    // The size without results + 128 bytes; in blocks only under
    // `allowConsensusLogicOptimization`, so only a size the plain check also refuses.
    code: 'TOO_BIG_TRANSACTION_ERROR',
    text: /^Too big transaction with result, TxId [0-9a-f]{64}, the size is (0|[1-9]\d{0,18}) bytes, maxTxSize 512000$/,
    shows: (size) => size - RESULT_BYTES > MAX_TX_BYTES,
    result: rejected('transaction too large'),
  },
];

/** Refinements of `CONTRACT_VALIDATE_ERROR`: all state-dependent, so all `refused`. */
const CONTRACT_REFUSALS: readonly (readonly [RegExp, BroadcastResult])[] = [
  // `BandwidthProcessor.consume` refuses a missing owner before any contract check.
  [
    /^Contract validate error : account \[T[1-9A-HJ-NP-Za-km-z]{33}\] does not exist$/,
    refused('INSUFFICIENT_FUNDS', 'sender account not activated'),
  ],
  // TransferActuator's own wording, which `consume` pre-empts in v4.8.2.2.
  [
    /^Contract validate error : Validate TransferContract error, no OwnerAccount\.$/,
    refused('INSUFFICIENT_FUNDS', 'sender account not activated'),
  ],
  // TransferActuator (the amount) and `MUtil.transfer` (a call value).
  [
    /^Contract validate error : Validate (?:TransferContract|InternalTransfer) error, balance is not sufficient\.$/,
    refused('INSUFFICIENT_FUNDS', 'insufficient balance'),
  ],
];

/** The refusals java-tron answers before it pools the transaction, by code. */
const REFUSED: ReadonlyMap<string, BroadcastResult> = new Map([
  ['SIGERROR', refused('TX_REFUSED', 'signature not accepted for this account')],
  ['CONTRACT_VALIDATE_ERROR', refused('TX_REFUSED', 'contract validation failed')],
  ['CONTRACT_EXE_ERROR', refused('TX_REFUSED', 'contract execution failed')],
  [
    'BANDWITH_ERROR',
    refused('INSUFFICIENT_FUNDS', 'insufficient bandwidth or balance for fees'),
  ],
  ['TAPOS_ERROR', refused('TX_REFUSED', 'reference block not on the canonical chain')],
  ['TOO_BIG_TRANSACTION_ERROR', refused('TX_REFUSED', 'transaction refused')],
  ['TRANSACTION_EXPIRATION_ERROR', refused('TX_EXPIRED', 'transaction expired')],
]);

const NODE_LOCAL: ReadonlySet<string> = new Set([
  'SERVER_BUSY',
  'NO_CONNECTION',
  'NOT_ENOUGH_EFFECTIVE_CONNECTION',
  'BLOCK_UNSOLIDIFIED',
]);

function permanent(code: string, message: string): BroadcastResult | undefined {
  for (const rule of PERMANENT) {
    if (rule.code !== code) continue;
    const match = rule.text.exec(message);
    if (match === null) continue;
    if (rule.shows && !rule.shows(Number(match[1]))) return undefined;
    return rule.result;
  }
  return undefined;
}

export function classifyBroadcast(answer: BroadcastAnswer): BroadcastResult {
  if (answer.accepted) return ACCEPTED;
  const { code = '', message = '' } = answer;
  if (code === 'DUP_TRANSACTION_ERROR') return ALREADY_KNOWN;
  const refusal = REFUSED.get(code);
  if (refusal === undefined) {
    throw new ProviderError(
      'PROVIDER_UNAVAILABLE',
      NODE_LOCAL.has(code)
        ? // "P2P broadcast failed." comes after java-tron pooled the transaction.
          'the node could not relay the transaction; it may have been sent'
        : 'the node answered the broadcast without a known refusal; it may have been sent',
      { ambiguous: true },
    );
  }
  const definitive = permanent(code, message);
  if (definitive) return definitive;
  if (code === 'CONTRACT_VALIDATE_ERROR') {
    for (const [text, result] of CONTRACT_REFUSALS) {
      if (text.test(message)) return result;
    }
  }
  return refusal;
}
