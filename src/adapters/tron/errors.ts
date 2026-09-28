/**
 * Broadcast classification (lesson 3, R24, R63/R64), pure. java-tron answers
 * `/wallet/broadcasthex` with HTTP 200 and `{ result: false, code, message }`, so the
 * transport never sees these as errors. The codes, texts and their order are java-tron's
 * (`Wallet.broadcastTransaction`, `Manager.pushTransaction` and `processTransaction`,
 * checked against GreatVoyage-v4.8.2.2, `d5c3d1d1`; Plan 4 Task 3's verified list).
 * - `rejected` only on definitive evidence: the refusal code plus an exact, anchored text
 *   that consensus also refuses for these bytes on every node at every time — a signature
 *   under 65 bytes, no contract, a transfer to self, a non-positive amount, or a size over
 *   the constant 512,000-byte limit (the signature and size rules only for bytes with one
 *   signature, F4-R23). Numbers in those texts must show the defect: a text that
 *   contradicts itself decides nothing.
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
 *
 * Lesson 21 (F4-R20): a node's rejection is a claim. `classifyBroadcast` takes the node at
 * its word; `classifyOwnBroadcast`, which the broadcaster uses, keeps a `rejected` only when
 * the claimed reason holds for the bytes that were sent (`txBytesOf`, read with the SDK-free
 * reader the codec shares, `protobuf.ts`, F4-R22), and makes every other one `refused`, which
 * is not terminal. A terminal `rejected`
 * lets a caller pay again, so a lying endpoint that relayed the bytes, or keeps them to relay
 * later, would make that a second payment. Our builder refuses every byte-only defect before
 * signing, so a true rejection of our own bytes should not happen; a refusal costs liveness
 * only, and the expiry proof still ends the Operation.
 */
import type { BroadcastResult } from '../../core/driver/types';
import { ProviderError } from '../../core/errors/error';
import { fromHex, toHex, utf8ToBytes } from '../../core/util/bytes';
import type { BroadcastAnswer } from './http';
import { bytesOf, singular, wireFields, type WireValue } from './protobuf';

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

/**
 * Our signed transaction as java-tron's byte-only checks read it (lesson 21), from the hex
 * that was sent.
 */
export interface TronTxBytes {
  /** The serialized `Transaction` without `ret`, which java-tron clears before measuring it. */
  readonly size: number;
  /** Each signature's length, in bytes. */
  readonly signatures: readonly number[];
  /** How many contracts `raw_data` holds (field 11). */
  readonly contracts: number;
  /**
   * The one contract when it is a TransferContract: its addresses as hex and its amount as
   * java-tron reads the `int64` (negative above 2^63 − 1; 0 when absent).
   */
  readonly transfer?: {
    readonly owner: string;
    readonly to: string;
    readonly amount: bigint;
  };
}

interface Permanent {
  readonly code: string;
  readonly text: RegExp;
  /** For a text with a number: whether the number shows the defect (else it decides nothing). */
  readonly shows?: (value: number) => boolean;
  /** Lesson 21: whether the claimed reason holds for the bytes that were sent. */
  readonly holds: (tx: TronTxBytes) => boolean;
  readonly result: BroadcastResult;
}

/**
 * F4-R23: the signature and size rules measure the bytes as sent, while what lands is the
 * txID with any signatures. A relayer may drop a signature, and java-tron reads only a
 * signature's first 65 bytes (`checkWeight`), so it may trim padding too. So a claim holds
 * only for bytes whose txID has no smaller valid form: one signature and, for the size, one
 * of exactly 65 bytes.
 */
const oneSignature = (tx: TronTxBytes): boolean => tx.signatures.length === 1;

/** The size rules: java-tron measures the transaction without `ret` (lesson 21). */
const oversize = (tx: TronTxBytes): boolean =>
  oneSignature(tx) && tx.signatures[0] === MIN_SIGNATURE_BYTES && tx.size > MAX_TX_BYTES;

const PERMANENT: readonly Permanent[] = [
  {
    // Admission refuses sizes outside 65–68 (`SignUtils.isValidLength`), but consensus keeps
    // `size < 65` (its own comment: longer historical signatures carry padding), so only a
    // shorter signature is invalid everywhere.
    code: 'SIGERROR',
    text: /^Validate signature error: Signature size is (0|[1-9]\d{0,9})$/,
    shows: (size) => size < MIN_SIGNATURE_BYTES,
    holds: (tx) => oneSignature(tx) && (tx.signatures[0] as number) < MIN_SIGNATURE_BYTES,
    result: rejected('malformed signature'),
  },
  {
    // `Wallet.broadcastTransaction`: no contract at all (TransferActuator's use of the same
    // text needs a missing parameter, which a parsed transaction never has).
    code: 'CONTRACT_VALIDATE_ERROR',
    text: /^Contract validate error : No contract!$/,
    holds: (tx) => tx.contracts === 0,
    result: rejected('no contract'),
  },
  {
    code: 'CONTRACT_VALIDATE_ERROR',
    text: /^Contract validate error : Cannot transfer TRX to yourself\.$/,
    holds: (tx) => tx.transfer !== undefined && tx.transfer.owner === tx.transfer.to,
    result: rejected('transfer to self'),
  },
  {
    code: 'CONTRACT_VALIDATE_ERROR',
    text: /^Contract validate error : Amount must be greater than 0\.$/,
    holds: (tx) => tx.transfer !== undefined && tx.transfer.amount <= 0n,
    result: rejected('non-positive amount'),
  },
  {
    // `Manager.validateCommon`, applied in blocks too: the whole transaction.
    code: 'TOO_BIG_TRANSACTION_ERROR',
    text: /^Too big transaction, TxId [0-9a-f]{64}, the size is (0|[1-9]\d{0,18}) bytes, maxTxSize 512000$/,
    shows: (size) => size > MAX_TX_BYTES,
    holds: oversize,
    result: rejected('transaction too large'),
  },
  {
    // The size without results + 128 bytes; in blocks only under
    // `allowConsensusLogicOptimization`, so only a size the plain check also refuses.
    code: 'TOO_BIG_TRANSACTION_ERROR',
    text: /^Too big transaction with result, TxId [0-9a-f]{64}, the size is (0|[1-9]\d{0,18}) bytes, maxTxSize 512000$/,
    shows: (size) => size - RESULT_BYTES > MAX_TX_BYTES,
    holds: oversize,
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

function permanent(code: string, message: string): Permanent | undefined {
  for (const rule of PERMANENT) {
    if (rule.code !== code) continue;
    const match = rule.text.exec(message);
    if (match === null) continue;
    if (rule.shows && !rule.shows(Number(match[1]))) return undefined;
    return rule;
  }
  return undefined;
}

/** The node's answer at its word, with the rule when it claims a definitive rejection. */
function classified(answer: BroadcastAnswer): {
  readonly result: BroadcastResult;
  readonly rule?: Permanent;
} {
  if (answer.accepted) return { result: ACCEPTED };
  const { code = '', message = '' } = answer;
  if (code === 'DUP_TRANSACTION_ERROR') return { result: ALREADY_KNOWN };
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
  const rule = permanent(code, message);
  if (rule) return { result: rule.result, rule };
  if (code === 'CONTRACT_VALIDATE_ERROR') {
    for (const [text, result] of CONTRACT_REFUSALS) {
      if (text.test(message)) return { result };
    }
  }
  return { result: refusal };
}

/** The node's answer at its word (see `classifyOwnBroadcast` for our own broadcasts). */
export function classifyBroadcast(answer: BroadcastAnswer): BroadcastResult {
  return classified(answer).result;
}

/** A rejection this driver cannot confirm for the bytes it sent: observed, never terminal. */
const UNCONFIRMED: BroadcastResult = refused(
  'TX_REFUSED',
  'the node claimed the transaction is invalid',
);

/**
 * Lesson 21: the node's answer to bytes this driver sent, `sent` being those bytes read by
 * `txBytesOf` (`undefined` when they do not read). A `rejected` stands only when its claimed
 * reason holds for `sent`; otherwise the answer is `refused`. Every other answer is the
 * node's, as `classifyBroadcast` reads it: acceptance, duplicates, state-dependent refusals
 * (balance, a missing account, bandwidth, TaPoS, expiry, the fee limit) and possibly sent.
 */
export function classifyOwnBroadcast(
  answer: BroadcastAnswer,
  sent: TronTxBytes | undefined,
): BroadcastResult {
  const { result, rule } = classified(answer);
  if (rule === undefined) return result;
  return sent !== undefined && rule.holds(sent) ? result : UNCONFIRMED;
}

/** Lesson 20: bytes are read only up to twice java-tron's transaction limit. */
const MAX_READ_BYTES = 2 * MAX_TX_BYTES;
const INT64_MAX = (1n << 63n) - 1n;
const INT64_SPAN = 1n << 64n;
const TRANSFER_URL = 'type.googleapis.com/protocol.TransferContract';
/** `ContractType.TransferContract`. */
const TRANSFER_TYPE = 1n;

/** A field's bytes, or none: absent fields read as empty, as java-tron reads them. */
const bytesField = (value: WireValue | undefined): Uint8Array =>
  bytesOf(value) ?? new Uint8Array();

/**
 * The bytes a broadcast sent, as the lesson 21 checks read them, SDK-free: `Transaction`
 * (`raw_data` once, signatures, `ret` entries left out of the size), the contracts in
 * `raw_data`, and a single TransferContract's fields. `undefined` for hex that does not read
 * strictly, or is longer than `MAX_READ_BYTES` (lesson 20); no claim holds for it.
 */
export function txBytesOf(hex: string): TronTxBytes | undefined {
  if (typeof hex !== 'string' || hex.length > 2 * MAX_READ_BYTES) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = fromHex(hex);
  } catch {
    return undefined;
  }
  const outer = wireFields(bytes, 'refuse');
  if (!outer) return undefined;
  let raw: Uint8Array | undefined;
  let size = 0;
  const signatures: number[] = [];
  for (const { field, value, length } of outer) {
    if (!(value instanceof Uint8Array)) return undefined;
    if (field === 1 && raw === undefined) raw = value;
    else if (field === 2) signatures.push(value.length);
    else if (field !== 5) return undefined;
    // `ret` (field 5): java-tron clears it before it measures the transaction.
    if (field !== 5) size += length;
  }
  const fields = raw ? wireFields(raw, 'refuse') : null;
  if (!fields) return undefined;
  const contracts = fields.filter((f) => f.field === 11);
  const read = { size, signatures, contracts: contracts.length };
  const only = contracts.length === 1 ? contracts[0]?.value : undefined;
  if (only === undefined) return read;
  if (!(only instanceof Uint8Array)) return undefined;
  const contract = singular(only, {
    1: 'varint',
    2: 'bytes',
    3: 'bytes',
    4: 'bytes',
    5: 'varint',
  });
  if (!contract) return undefined;
  if (contract.get(1) !== TRANSFER_TYPE) return read;
  const any = singular(bytesField(contract.get(2)), { 1: 'bytes', 2: 'bytes' });
  if (!any) return undefined;
  // java-tron unpacks the parameter as the named type; any other type fails otherwise.
  if (toHex(bytesField(any.get(1))) !== toHex(utf8ToBytes(TRANSFER_URL))) return read;
  const transfer = singular(bytesField(any.get(2)), {
    1: 'bytes',
    2: 'bytes',
    3: 'varint',
  });
  if (!transfer) return undefined;
  const amount = (transfer.get(3) as bigint | undefined) ?? 0n;
  return {
    ...read,
    transfer: {
      owner: toHex(bytesField(transfer.get(1))),
      to: toHex(bytesField(transfer.get(2))),
      amount: amount > INT64_MAX ? amount - INT64_SPAN : amount,
    },
  };
}
