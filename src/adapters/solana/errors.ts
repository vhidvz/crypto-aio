/**
 * Broadcast classification. `rejected` is only for bytes that are invalid by construction
 * on every node: a signature that does not verify. Everything that depends on state,
 * time, fork or node policy (an unknown or expired blockhash, balances, rent, account
 * locks, versions, sizes) is `refused`, and so is every error not listed. Reasons are
 * fixed literals that never repeat the node's text, which can carry addresses or amounts.
 *
 * A preflight failure (`-32002`) carries the simulation result as its `data`, whose `err` is
 * agave's `TransactionError` in serde's form (`"BlockhashNotFound"`,
 * `{"InstructionError":[3,{"Custom":1}]}`). When that result is readable it decides, not the
 * text one endpoint chose to show; otherwise the texts decide: agave's `TransactionError`
 * displays behind `sendTransaction`'s preflight prefix, matched whole.
 *
 * A node's rejection is a claim. `classifyBroadcastError` takes the node
 * at its word; `classifyOwnBroadcast`, which the broadcaster uses, keeps a `rejected` only
 * when the bytes that were sent really carry a signature that does not verify, checked here
 * with the core's own ed25519 rule (the one that accepted our signer's signatures). A claim
 * for bytes whose signatures all verify, or for bytes that do not read as one signed legacy
 * transaction, is `refused`, which is not terminal. A terminal `rejected` lets a caller pay
 * again, so an endpoint that relayed the bytes, or keeps them to relay later, would make
 * that a second payment. The core verifies every signature before it is stored, so a true
 * rejection of our own Attempt should not happen; a refusal costs liveness only, and the
 * expiry proof still ends the Operation.
 */
import type { BroadcastResult } from '../../core/driver/types';
import { ed25519Scheme } from '../../core/registry/schemes';
import { MAX_TRANSACTION_SIZE } from './programs';
import { RPC_CODES, record } from './rpc';
import { parseSignedTransaction } from './wire';

const PREFLIGHT = 'Transaction simulation failed: ';

type Refused = Extract<BroadcastResult, { kind: 'refused' }>;

const refused = (code: Refused['code'], reason: string): Refused =>
  Object.freeze({ kind: 'refused', code, reason });

const ALREADY_KNOWN_RESULT: BroadcastResult = Object.freeze({ kind: 'already-known' });
const INVALID_SIGNATURE: BroadcastResult = Object.freeze({
  kind: 'rejected',
  reason: 'invalid signature',
});
const BLOCKHASH_NOT_FOUND = refused('TX_REFUSED', 'blockhash not found');
const INSUFFICIENT_FUNDS = refused('INSUFFICIENT_FUNDS', 'insufficient funds');
const INSUFFICIENT_FOR_FEE = refused('INSUFFICIENT_FUNDS', 'insufficient funds for fee');
const INSUFFICIENT_FOR_RENT = refused(
  'INSUFFICIENT_FUNDS',
  'insufficient funds for rent',
);
const DEFAULT_REFUSAL = refused('TX_REFUSED', 'refused by the node');

/** Anchored, whole-message texts. */
const ALREADY_KNOWN = `${PREFLIGHT}This transaction has already been processed`;

/** The two signature texts, each only under its own code. */
const REJECTED: readonly { readonly code: number; readonly text: string }[] = [
  {
    code: RPC_CODES.SEND_TRANSACTION_PREFLIGHT_FAILURE,
    text: `${PREFLIGHT}Transaction did not pass signature verification`,
  },
  {
    code: RPC_CODES.TRANSACTION_SIGNATURE_VERIFICATION_FAILURE,
    text: 'Transaction signature verification failure',
  },
];

const REFUSED: readonly { readonly pattern: RegExp; readonly result: Refused }[] = [
  {
    pattern: /^Transaction simulation failed: Blockhash not found$/,
    result: BLOCKHASH_NOT_FOUND,
  },
  {
    pattern:
      /^Transaction simulation failed: Attempt to debit an account but found no record of a prior credit\.$/,
    result: INSUFFICIENT_FUNDS,
  },
  {
    pattern: /^Transaction simulation failed: Insufficient funds for fee$/,
    result: INSUFFICIENT_FOR_FEE,
  },
  {
    pattern:
      /^Transaction simulation failed: Transaction results in an account \(\d+\) with insufficient funds for rent$/,
    result: INSUFFICIENT_FOR_RENT,
  },
  {
    // System `ResultWithNegativeLamports` and Token `InsufficientFunds` are both error 1,
    // the only programs of ours that return it.
    pattern:
      /^Transaction simulation failed: Error processing Instruction \d+: custom program error: 0x1$/,
    result: INSUFFICIENT_FUNDS,
  },
  {
    pattern:
      /^Transaction simulation failed: Error processing Instruction \d+: insufficient funds for instruction$/,
    result: INSUFFICIENT_FUNDS,
  },
];

/**
 * The `err` of a preflight failure's simulation result (the transport's `rpcData`, a JSON
 * text, or the object itself); `undefined` when there is none or it cannot be read. The
 * transport keeps only the first 512 characters, so a long log list makes it unreadable.
 */
function simulationError(data: unknown): unknown {
  let result = data;
  if (typeof data === 'string') {
    try {
      result = JSON.parse(data) as unknown;
    } catch {
      return undefined;
    }
  }
  const body = record(result);
  return body && 'err' in body ? body.err : undefined;
}

/** The refusal a structured `TransactionError` means, as the texts above do. */
function refusalFor(err: unknown): Refused {
  switch (err) {
    case 'BlockhashNotFound':
      return BLOCKHASH_NOT_FOUND;
    case 'AccountNotFound':
      return INSUFFICIENT_FUNDS;
    case 'InsufficientFundsForFee':
      return INSUFFICIENT_FOR_FEE;
  }
  const tagged = record(err);
  if (tagged && 'InsufficientFundsForRent' in tagged) return INSUFFICIENT_FOR_RENT;
  const instruction = tagged?.InstructionError;
  if (Array.isArray(instruction) && instruction.length === 2) {
    const detail: unknown = instruction[1];
    if (detail === 'InsufficientFunds' || record(detail)?.Custom === 1) {
      return INSUFFICIENT_FUNDS;
    }
  }
  return DEFAULT_REFUSAL;
}

/**
 * Classifies a definitive `sendTransaction` error: its JSON-RPC code, its message and, when
 * the node sent one, its `data` (`details.rpcData`).
 */
export function classifyBroadcastError(
  code: number | undefined,
  message: string,
  data?: unknown,
): BroadcastResult {
  const err =
    code === RPC_CODES.SEND_TRANSACTION_PREFLIGHT_FAILURE
      ? simulationError(data)
      : undefined;
  // The safe answer (the core keeps watching the Attempt): either source suffices.
  if (message === ALREADY_KNOWN || err === 'AlreadyProcessed')
    return ALREADY_KNOWN_RESULT;
  // The one verdict that ends an Attempt for good: the anchored text under its own code,
  // and a readable structured error must agree with it.
  if (
    REJECTED.some((entry) => entry.code === code && entry.text === message) &&
    (err === undefined || err === 'SignatureFailure')
  ) {
    return INVALID_SIGNATURE;
  }
  if (err !== undefined) return refusalFor(err);
  return REFUSED.find((entry) => entry.pattern.test(message))?.result ?? DEFAULT_REFUSAL;
}

/** A rejection this driver cannot confirm for the bytes it sent: observed, never terminal. */
const CLAIMED_INVALID_SIGNATURE = refused(
  'TX_REFUSED',
  'the node claimed an invalid signature',
);

/**
 * Whether `sent` carries a signature that does not verify (each signature against its
 * signer's key, in order, over the message), or `undefined` when the bytes do not read as
 * one signed legacy transaction within the packet limit (larger bytes are refused before
 * any parsing).
 */
function carriesBadSignature(sent: Uint8Array): boolean | undefined {
  if (sent.length > MAX_TRANSACTION_SIZE) return undefined;
  const tx = parseSignedTransaction(sent);
  if (!tx) return undefined;
  return tx.signatures.some(
    (signature, i) =>
      !ed25519Scheme.verify({
        publicKey: tx.parts.keys[i] as Uint8Array,
        payload: tx.message,
        signature,
      }),
  );
}

/**
 * The node's answer to `sent`, the bytes this driver sent. A `rejected` stands
 * only when `sent` carries a signature that does not verify; otherwise the answer is
 * `refused`. Every other answer is the node's, as `classifyBroadcastError` reads it.
 */
export function classifyOwnBroadcast(
  sent: Uint8Array,
  code: number | undefined,
  message: string,
  data?: unknown,
): BroadcastResult {
  const result = classifyBroadcastError(code, message, data);
  if (result.kind !== 'rejected') return result;
  return carriesBadSignature(sent) === true ? result : CLAIMED_INVALID_SIGNATURE;
}
