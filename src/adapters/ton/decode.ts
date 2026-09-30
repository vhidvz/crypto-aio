/**
 * Indexed TON transactions as `DriverTransaction`s (spec §6.6), for anyone's transactions:
 * `getTransaction` and `history` report what the chain did (lesson 15). Locators (D15):
 * `msg:in` for the inbound internal message's value, `msg:in:jetton` for the jettons it
 * brings, `msg:<i>` for outbound message `i`.
 *
 * Execution status: a wallet (external-in) transaction executed when its compute and action
 * phases succeeded and its code did not throw after committing; an internal one whenever its
 * value stayed, i.e. no bounce phase sent it back (M7): a non-bounceable deposit to a fresh
 * address is `aborted` on chain yet credited, and so is a non-bounceable message to a
 * failing contract, a failed action phase without send mode +16 and a `nofunds` or
 * `negfunds` bounce. Jettons move only when the jetton wallet ran the message to the end
 * (a failed phase drops its state). Bodies are bound to their keyed hashes (C1). Jetton
 * movements are decoded only for a jetton wallet the master itself names for its owner
 * (`jetton`, resolved by the reader): anyone can deploy a contract that claims a master or
 * sends a `transfer_notification`. A record whose phases contradict each other decides
 * nothing (lesson 18, widened).
 */
import type { Cell } from '@ton/core';
import type {
  DriverTransaction,
  DriverTransfer,
  DriverTxObservation,
} from '../../core/driver/types';
import { ProviderError } from '../../core/errors/error';
import type { V3Message, V3Transaction } from './api';
import {
  decodeComment,
  decodeJettonInternalTransfer,
  decodeJettonNotification,
  decodeJettonTransfer,
  messageBody,
} from './messages';
import { externalHashOf } from './wallets';

/** A jetton wallet proven to belong to `owner` under `master`. */
export interface VerifiedJettonWallet {
  readonly address: string;
  readonly owner: string;
  readonly master: string;
}

/**
 * Whether the contract ran its inbound message to the end, so its state changes and
 * outgoing messages stand: its compute and action phases both succeeded. The chain records
 * nothing else (transaction.cpp, collator.cpp):
 * - an action phase follows exactly a successful compute phase, and a skipped compute
 *   phase never succeeded;
 * - `aborted` is exactly "not ran" (M3: a skipped compute phase included);
 * - a bounce phase exists exactly for a bounceable inbound message (`bounce_enabled`, the
 *   message's own flag; never an external one or a bounce) whose phases failed, and always
 *   when its compute phase did (I1);
 * - the outgoing messages are distinct, as many as the action phase created when it ran,
 *   and nothing but the bounce when it did not (M1).
 * A record that breaks any of these contradicts the chain: a retryable
 * `PROVIDER_INCONSISTENT`, which decides nothing (lesson 18, widened), never a default
 * (lesson 6).
 */
export function ran(tx: V3Transaction): boolean {
  const { compute, action, inMsg, outMsgs } = tx;
  const done = compute.success && action?.success === true;
  // Unknown (null) when the indexer leaves an inbound internal message's flag out.
  const bounceable = !inMsg || inMsg.source === null ? false : inMsg.bounce;
  if (
    (action !== undefined) !== compute.success ||
    (compute.skipped && compute.success) ||
    tx.aborted === done ||
    (tx.bounce !== undefined && (done || bounceable === false)) ||
    (bounceable === true && !compute.success && tx.bounce === undefined) ||
    new Set(outMsgs.map((m) => m.hash)).size !== outMsgs.length ||
    (done
      ? outMsgs.length !== action?.msgsCreated
      : // F6-R14: a flag the indexer leaves out (null) says nothing against the chain.
        outMsgs.some((m) => m.bounced === false))
  ) {
    throw new ProviderError(
      'PROVIDER_INCONSISTENT',
      'the indexed transaction phases contradict each other',
      { retryable: true },
    );
  }
  return done;
}

/**
 * Whether the code committed its state (`COMMIT`), then threw: the chain counts that
 * compute phase a success (transaction.cpp: `success = accepted && committed`) and runs only
 * the actions committed before, so the code did not finish what it was asked. W5 refuses an
 * external request without send mode +2 this way (137).
 */
export function threwAfterCommit(tx: V3Transaction): boolean {
  const code = tx.compute.exitCode;
  return tx.compute.success && code !== undefined && code !== 0 && code !== 1;
}

/** Whether the transaction did what its inbound message asked, as the chain reports it. */
export function executed(tx: V3Transaction): boolean {
  const done = ran(tx);
  if (tx.inMsg?.source === null) return done && !threwAfterCommit(tx);
  return tx.bounce !== 'ok';
}

type BodyKind =
  | 'empty'
  | 'comment'
  | 'jetton-request'
  | 'jetton-arrival'
  | 'jetton-notification'
  | 'bounced'
  | 'other';

/** A message body's kind, read once (a body may hold up to 2^13 cells). */
function bodyOf(message: V3Message): {
  readonly kind: BodyKind;
  readonly comment?: string;
  readonly cell?: Cell;
} {
  if (message.bounced) return { kind: 'bounced' };
  const cell = messageBody(message);
  if (!cell || (cell.bits.length === 0 && cell.refs.length === 0))
    return { kind: 'empty' };
  const comment = decodeComment(cell);
  if (comment !== undefined) return { kind: 'comment', comment };
  if (decodeJettonTransfer(cell)) return { kind: 'jetton-request' };
  if (decodeJettonInternalTransfer(cell)) return { kind: 'jetton-arrival', cell };
  if (decodeJettonNotification(cell)) return { kind: 'jetton-notification', cell };
  return { kind: 'other' };
}

/**
 * Whether jettons moved with an inbound message of this kind: an `internal_transfer` the
 * jetton wallet ran to the end (TEP-74 credits only then: a failed phase drops the credit,
 * bounced or not), or a `transfer_notification` (sent only after the credit).
 */
function jettonsMoved(tx: V3Transaction, kind: BodyKind): boolean {
  if (kind === 'jetton-arrival') return ran(tx);
  return kind === 'jetton-notification' && executed(tx);
}

/**
 * The jetton wallet whose ownership decides this transaction's jetton movement: the
 * account itself for an `internal_transfer`, the sender for a `transfer_notification`.
 * Undefined when no jetton moved.
 */
export function jettonWalletToVerify(tx: V3Transaction): string | undefined {
  const inMsg = tx.inMsg;
  if (!inMsg || inMsg.source === null) return undefined;
  const { kind } = bodyOf(inMsg);
  if (!jettonsMoved(tx, kind)) return undefined;
  return kind === 'jetton-arrival' ? tx.account : inMsg.source;
}

/** The jetton movement of `tx`'s inbound jetton body `cell`, for a verified wallet only. */
function jettonTransfer(
  tx: V3Transaction,
  cell: Cell,
  jetton: VerifiedJettonWallet | undefined,
): DriverTransfer | undefined {
  const inMsg = tx.inMsg as V3Message;
  if (!jetton) return undefined;
  const arrival = decodeJettonInternalTransfer(cell);
  if (arrival && jetton.address === tx.account) {
    return {
      locator: 'msg:in:jetton',
      from: arrival.from ? [arrival.from] : [],
      to: jetton.owner,
      asset: { standard: 'jetton', contract: jetton.master },
      amount: arrival.amount,
      source: 'token-event',
      ...(arrival.comment !== undefined ? { memo: arrival.comment } : {}),
    };
  }
  const note = decodeJettonNotification(cell);
  if (note && jetton.address === inMsg.source && jetton.owner === tx.account) {
    return {
      locator: 'msg:in:jetton',
      from: note.sender ? [note.sender] : [],
      to: tx.account,
      asset: { standard: 'jetton', contract: jetton.master },
      amount: note.amount,
      source: 'token-event',
      ...(note.comment !== undefined ? { memo: note.comment } : {}),
    };
  }
  return undefined;
}

/**
 * A wallet request's TEP-467 hash, computed here from its bound body (C1): the indexer's
 * `hash_norm` is only its claim.
 */
function requestHashOf(tx: V3Transaction): string | undefined {
  const inMsg = tx.inMsg;
  if (!inMsg || inMsg.source !== null) return undefined;
  const body = messageBody(inMsg);
  return body ? externalHashOf(tx.account, body) : undefined;
}

export function decodeTransaction(
  tx: V3Transaction,
  options: { readonly blockHash?: string; readonly jetton?: VerifiedJettonWallet } = {},
): DriverTransaction {
  const transfers: DriverTransfer[] = [];
  let partial = false;
  const inMsg = tx.inMsg;
  const ok = executed(tx);
  if (inMsg && inMsg.source !== null && ok) {
    const body = bodyOf(inMsg);
    if (body.kind === 'other' || body.kind === 'jetton-request') partial = true;
    if (inMsg.value !== null && inMsg.value > 0n) {
      transfers.push({
        locator: 'msg:in',
        from: [inMsg.source],
        to: tx.account,
        asset: 'native',
        amount: inMsg.value,
        // A bounced message returns the account's own value: a refund, not a payment.
        source: inMsg.bounced ? 'internal' : 'native',
        ...(body.comment !== undefined ? { memo: body.comment } : {}),
      });
    }
    if (body.cell && jettonsMoved(tx, body.kind)) {
      const jetton = jettonTransfer(tx, body.cell, options.jetton);
      if (!jetton) partial = true;
      // M6: a zero credit moved nothing, as a zero native value does not.
      else if (jetton.amount > 0n) transfers.push(jetton);
    }
  }
  tx.outMsgs.forEach((out, index) => {
    if (out.destination === null || out.value === null) return;
    const body = bodyOf(out);
    if (body.kind === 'other' || body.kind === 'jetton-request') partial = true;
    if (out.value === 0n) return;
    transfers.push({
      locator: `msg:${index}`,
      from: [tx.account],
      to: out.destination,
      asset: 'native',
      amount: out.value,
      source: out.bounced ? 'internal' : 'native',
      ...(body.comment !== undefined ? { memo: body.comment } : {}),
    });
  });
  const observation: DriverTxObservation = {
    seen: 'block',
    txHash: tx.hash,
    blockHeight: BigInt(tx.mcSeqno),
    ...(options.blockHash !== undefined ? { blockHash: options.blockHash } : {}),
    success: ok,
  };
  const messageHash = requestHashOf(tx);
  return {
    id: tx.hash,
    observation,
    fee: [{ asset: 'native', amount: tx.totalFees }],
    transfers,
    decoding: partial ? 'partial' : 'complete',
    timestamp: tx.now,
    details: {
      account: tx.account,
      lt: tx.lt.toString(),
      traceId: tx.traceId,
      aborted: tx.aborted,
      ...(tx.compute.exitCode !== undefined ? { exitCode: tx.compute.exitCode } : {}),
      ...(messageHash !== undefined ? { messageHash } : {}),
    },
  };
}
