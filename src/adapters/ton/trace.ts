/**
 * The verdict on one of our own Attempts (D11, lesson 7): did the value move? A TON wallet
 * transaction "succeeds" even when it moved nothing (send mode +2 skips a message it cannot
 * pay), and a transfer can still bounce, or a jetton move fail, one or two hops later. So an
 * Attempt succeeded only when:
 * - the wallet transaction consumed the request's seqno and ran it to the end;
 * - every message of the signed request is among its outgoing messages (a missing one is a
 *   skip only when the wallet's action phase itself counts that many skipped actions);
 * - no native message came back bounced (a `nofunds` or `negfunds` bounce, a failed action
 *   phase without send mode +16 and a non-bounceable message all leave the value with the
 *   recipient, M7);
 * - every jetton request reached a jetton wallet as an `internal_transfer` of a positive
 *   amount from our wallet, sent by our jetton wallet and run to the end by the receiving
 *   one (the exact amount is not required: the phantom-success rule), and both jetton
 *   wallets are the master's own for the sender and the intended recipient. That last
 *   check needs chain reads, so the verdict returns the `legs` for the caller to confirm
 *   (`confirmLegs` in `reader.ts`); the receiving wallet's own 707 check then holds.
 * Only a request that consumed its seqno is final (lessons 16–18): any other run (a failed
 * action phase, or a compute phase that failed before `commit()`) left the same message
 * valid until it expires, so anyone may replay it and move the value; such a run decides
 * nothing (`pending`), and only the seqno or the proven expiry can.
 * Used on the verdict paths only (`observe`, `includedFinal`; lesson 15). Every body read
 * here is bound to the hash the quorum keyed (C1, `messageBody`). A batch is one Attempt:
 * one bounced output fails it, although the other outputs moved. Lesson 18 (widened): only
 * the chain's own record of a failure decides `failed`; an answer that contradicts the
 * chain or the signed request (a message missing that the wallet did not skip, a jetton
 * wallet that ran the transfer yet sent nothing from the sender, phases that contradict
 * each other) throws a retryable `PROVIDER_INCONSISTENT`, which decides nothing.
 */
import { ProviderError } from '../../core/errors/error';
import type { V3Message, V3Trace, V3Transaction } from './api';
import { ran, threwAfterCommit } from './decode';
import {
  decodeComment,
  decodeJettonInternalTransfer,
  decodeJettonTransfer,
  decodeWalletRequest,
  messageBody,
  messageFacts,
} from './messages';
import { externalHashOf } from './wallets';

/** One jetton transfer: the jetton wallets whose owners must be `from` and `recipient`. */
export interface JettonLeg {
  readonly senderWallet: string;
  readonly recipientWallet: string;
  readonly recipient: string;
}

export type Verdict =
  | { readonly kind: 'success'; readonly legs: readonly JettonLeg[] }
  | { readonly kind: 'failed'; readonly reason: string }
  /**
   * Not decidable yet: the trace is still being executed or indexed, or the request ran
   * without consuming its seqno and may still run again until it expires.
   */
  | { readonly kind: 'pending' };

/** Fixed reasons (R24): no addresses, amounts or node text. */
export const REASONS = Object.freeze({
  walletFailed: 'the wallet transaction failed',
  skipped: 'the wallet skipped a message',
  bounced: 'transfer bounced',
  jettonBounced: 'jetton transfer bounced',
  jettonUnverified: 'the jetton wallets are not the master’s',
});

const PENDING: Verdict = Object.freeze({ kind: 'pending' });
const failed = (reason: string): Verdict => Object.freeze({ kind: 'failed', reason });

const inconsistent = (reason: string) =>
  new ProviderError('PROVIDER_INCONSISTENT', reason, { retryable: true });

/**
 * wallet_v5.fc: an external request whose send mode lacks +2, refused after `commit()`
 * stored the next seqno. The scripted node records it as a failed compute phase; the chain
 * counts that phase a success and runs the empty action list committed with the seqno.
 */
const W5_REFUSED_AFTER_COMMIT = 137;

/**
 * Whether the wallet transaction of an external request `tx` consumed the request's seqno,
 * so that the same message can never run again: its action phase succeeded (the new seqno
 * stands with the actions), or its compute phase failed with 137 after committing it (W5).
 * Any other run left the old seqno (transaction.cpp: a failed action phase drops the
 * compute phase's state, and a compute phase that failed before `commit()` never had one):
 * a foreign request signed with the same key, or our own, whose action phase failed does
 * not consume the seqno. Throws the retryable contradiction of `ran`.
 */
export function consumesSeqno(tx: V3Transaction): boolean {
  if (ran(tx)) return true;
  return (
    !tx.compute.success &&
    !tx.compute.skipped &&
    tx.compute.exitCode === W5_REFUSED_AFTER_COMMIT
  );
}

/**
 * C1: whether `tx` is our Attempt: the external message to `from` whose TEP-467 hash,
 * computed here from the bound body, is the Attempt id. The indexer's `hash_norm` only
 * finds candidates; it never decides.
 */
export function isOwnAttempt(tx: V3Transaction, from: string, refId: string): boolean {
  if (!tx.inMsg || tx.inMsg.source !== null || tx.account !== from) return false;
  const body = messageBody(tx.inMsg);
  return body !== null && externalHashOf(tx.account, body) === refId;
}

/**
 * The transaction in `trace` that received `message`, which `sender` sent. An internal
 * message is delivered once, to its destination, with its value: anything else contradicts
 * the chain.
 */
function receiver(trace: V3Trace, message: V3Message, sender: string): V3Transaction {
  const found = trace.transactions.filter((t) => t.inMsg?.hash === message.hash);
  const [tx] = found;
  if (!tx) throw inconsistent('a complete trace lacks a delivered message');
  if (
    found.length > 1 ||
    message.source !== sender ||
    tx.account !== message.destination ||
    tx.inMsg?.source !== sender ||
    tx.inMsg.value !== message.value
  ) {
    throw inconsistent('the trace delivered a message other than the one sent');
  }
  return tx;
}

interface Sent {
  readonly out: V3Message;
  /** For a jetton request: its intended recipient (the owner). */
  readonly jettonRecipient?: string;
}

/** A native transfer as our builder signs it: a positive value, no body or a comment. */
function plainTransfer(facts: NonNullable<ReturnType<typeof messageFacts>>): boolean {
  const { value, body } = facts;
  const empty = body.bits.length === 0 && body.refs.length === 0;
  return value > 0n && (empty || decodeComment(body) !== undefined);
}

/**
 * The requested messages, matched one to one with the wallet transaction's outgoing
 * messages; or why some did not go out: the wallet skipped them (send mode +2), or its code
 * threw after committing the seqno.
 */
function sentMessages(root: V3Transaction): readonly Sent[] | 'skipped' | 'threw' {
  const body = messageBody(root.inMsg as V3Message);
  if (!body) throw inconsistent('the indexer has no body for the external message');
  const request = decodeWalletRequest(body);
  if (!request || request.auth !== 'external') {
    throw inconsistent('the indexed external message is not a wallet transfer');
  }
  const unused = [...root.outMsgs];
  const matched: Sent[] = [];
  let missing = 0;
  for (const requested of request.messages) {
    const facts = messageFacts(requested);
    if (!facts)
      throw inconsistent('the signed request holds a message that is not internal');
    // Our builder signs only plain transfers of a positive value and TEP-74 transfers; any
    // other message moves what the verdict cannot see, so it is never judged a success.
    const jetton = decodeJettonTransfer(facts.body);
    if (!jetton && !plainTransfer(facts)) {
      throw inconsistent('the signed request holds a message the verdict cannot judge');
    }
    const index = unused.findIndex(
      (out) =>
        out.destination === facts.to &&
        out.value === facts.value &&
        out.bodyHash === facts.bodyHash,
    );
    if (index < 0) {
      missing += 1;
      continue;
    }
    const [out] = unused.splice(index, 1);
    matched.push({
      out: out as V3Message,
      ...(jetton ? { jettonRecipient: jetton.destination } : {}),
    });
  }
  if (unused.length > 0) {
    throw inconsistent(
      'the wallet transaction sent a message the request did not ask for',
    );
  }
  // `ran` holds, so the action phase is there.
  const skipped = root.action?.skippedActions ?? 0;
  if (missing === 0) {
    if (skipped > 0)
      throw inconsistent('the wallet counts a skip, yet sent every message');
    return matched;
  }
  // Committed, then threw (W5 137 on chain): only what was committed before went out.
  if (threwAfterCommit(root)) return 'threw';
  // Send mode +2: the wallet records every message it skipped (lesson 18, widened).
  if (missing <= skipped) return 'skipped';
  throw inconsistent('the wallet transaction lacks a requested message it did not skip');
}

/**
 * The `internal_transfer` our jetton wallet `hop` sent onwards for our wallet `from`: the
 * message of a positive amount, `null` when it moved nothing.
 */
function onward(hop: V3Transaction, from: string): V3Message | null {
  let nothingMoved = false;
  for (const m of hop.outMsgs) {
    const body = messageBody(m);
    const internal = body ? decodeJettonInternalTransfer(body) : null;
    if (!internal || internal.from !== from) continue;
    // From the sender, a positive amount (the phantom-success rule, final wording).
    if (internal.amount > 0n) return m;
    nothingMoved = true; // a zero amount: nothing moved, so `failed` is accurate
  }
  if (nothingMoved) return null;
  throw inconsistent('the jetton wallet ran the transfer but sent none from the sender');
}

/** The verdict on the Attempt whose wallet transaction is `root`, within `trace`. */
export function attemptVerdict(root: V3Transaction, trace: V3Trace | null): Verdict {
  if (!root.inMsg || root.inMsg.source !== null) {
    throw inconsistent('the attempt is not an external message');
  }
  if (!consumesSeqno(root)) return PENDING;
  if (!root.compute.success) return failed(REASONS.walletFailed);
  const sent = sentMessages(root);
  if (sent === 'threw') return failed(REASONS.walletFailed);
  if (sent === 'skipped') return failed(REASONS.skipped);
  if (!trace || !trace.complete) return PENDING;
  const legs: JettonLeg[] = [];
  for (const { out, jettonRecipient } of sent) {
    const hop = receiver(trace, out, root.account);
    const hopRan = ran(hop);
    if (jettonRecipient === undefined) {
      // The value stays unless the bounce phase sent it back (M7).
      if (hop.bounce === 'ok') return failed(REASONS.bounced);
      continue;
    }
    // The owner's jetton wallet ran `transfer` and sent `internal_transfer` onwards. A
    // failed phase dropped its state: the jettons never left.
    if (!hopRan) return failed(REASONS.jettonBounced);
    const arrivalMessage = onward(hop, root.account);
    if (!arrivalMessage) return failed(REASONS.jettonBounced);
    // TEP-74 707: the receiving wallet takes it only from the sender's jetton wallet.
    const arrival = receiver(trace, arrivalMessage, hop.account);
    // A failed phase drops the credit: the jettons came back, or never arrived.
    if (!ran(arrival)) return failed(REASONS.jettonBounced);
    legs.push({
      senderWallet: hop.account,
      recipientWallet: arrival.account,
      recipient: jettonRecipient,
    });
  }
  return Object.freeze({ kind: 'success', legs });
}
