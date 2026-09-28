/**
 * Classifies a definitive send refusal (spec §7, §8.2, D16). toncenter answers every
 * liteserver refusal, and malformed bytes too, with HTTP 500, which the transport reports
 * as an ambiguous failure that the broadcaster rethrows unclassified. Its definitive 4xx
 * answers (422) mean the request did not parse. So this table serves the 4xx answers of
 * other v2-compatible endpoints, and it matches the chain's own texts only:
 * - liteserver.cpp `perform_sendMessage` prefixes "cannot apply external message to current
 *   state : ", and tonlib names the liteserver's error code ("LITE_SERVER_UNKNOWN: ");
 * - external-message.cpp `run_message_on_account` prefixes "External message was not
 *   accepted: cannot run message on account: ";
 * - collator.cpp `impl_create_ordinary_transaction` writes "inbound external message
 *   rejected by transaction <HEX>:\nexitcode=<n>, steps=<n>, gas_used=<n>" (then a VM
 *   log) when the wallet code refuses, and "… rejected by account <HEX> before
 *   smart-contract execution" when the balance cannot pay the import fee;
 * - ext-message-checker.cpp writes "Failed to unpack account state";
 * - liteserver-cache.hpp answers a repeated `sendMessage` "duplicate message", behind
 *   "cannot send external message : " (liteserver.cpp).
 *
 * Every text-based answer is a refusal or a success, never `rejected`: one endpoint's text
 * decides no verdict (lessons 3 and 16; Plan 2.5 refusal equivalence), and a refused TON
 * message still ends, proven, when it expires. Bytes that are no external message are
 * `rejected` by the broadcaster itself, before anything is sent. Reasons are fixed texts
 * (R24): a node's text carries addresses. Each pattern is linear and reads a bounded
 * prefix (lesson 20). SDK-free.
 */
import type { BroadcastResult } from '../../core/driver/types';

type RefusalCode = Extract<BroadcastResult, { kind: 'refused' }>['code'];

const refused = (code: RefusalCode, reason: string): BroadcastResult =>
  Object.freeze({ kind: 'refused', code, reason });

/** Only this much of a text is read; every chain text above ends its verdict well within. */
const MAX_TEXT = 1024;

/**
 * The wallet code's refusals by exit code, all state-dependent (another seqno, a later
 * clock, a W5 extension that turns signatures back on): wallet-v4-code.fc checks 36, 33, 34
 * and 35; wallet_v5.fc `process_signed_request` checks 135, 132, 133, 134 and 136.
 */
const BY_EXIT_CODE: ReadonlyMap<string, BroadcastResult> = new Map([
  ['33', refused('NONCE_CONFLICT', 'seqno mismatch')],
  ['133', refused('NONCE_CONFLICT', 'seqno mismatch')],
  ['36', refused('TX_EXPIRED', 'message expired')],
  ['136', refused('TX_EXPIRED', 'message expired')],
  ['34', refused('TX_REFUSED', 'wallet id mismatch')],
  ['134', refused('TX_REFUSED', 'wallet id mismatch')],
  ['35', refused('TX_REFUSED', 'signature not accepted')],
  ['135', refused('TX_REFUSED', 'signature not accepted')],
  ['132', refused('TX_REFUSED', 'signature disabled')],
]);

/**
 * The wallet code refused, or its compute phase never ran. The code and the steps must each
 * end at their comma, so a text cut short is never read as another code.
 */
const BY_TRANSACTION =
  /inbound external message rejected by transaction [0-9A-Fa-f]{64}:\nexitcode=(-?\d{1,10}), steps=(\d{1,10}),/;

/**
 * No code runs: the account does not exist, or has no code and no matching `StateInit`, no
 * gas, or is frozen (a skipped compute phase reads `exitcode=0, steps=0`).
 */
const INACTIVE = refused('TX_REFUSED', 'wallet not active or not funded');
const NO_ACCOUNT = /(?:^|: )Failed to unpack account state\s*$/;

/**
 * The balance cannot pay the import fee (transaction.cpp `unpack_input_msg`). The same text
 * covers message shapes the builder never makes (an anycast or too deep destination).
 */
const BY_ACCOUNT =
  /inbound external message rejected by account [0-9A-Fa-f]{64} before smart-contract execution/;
const NO_FUNDS = refused('INSUFFICIENT_FUNDS', 'insufficient funds');

/** tonlib's answers to bytes that are no message; exact, anchored texts. */
const MALFORMED = /^(?:Failed to unpack Message\s*$|INVALID_BAG_OF_CELLS: )/;
const MALFORMED_RESULT = refused('TX_REFUSED', 'malformed message');

/**
 * Success (spec §8.4): this liteserver already took these exact bytes (it forgets a send
 * that failed). Matched as strictly as a refusal (M4): the whole answer, and only after
 * every refusal pattern.
 */
const ALREADY_KNOWN =
  /^(?:LITE_SERVER_UNKNOWN: )?cannot send external message : duplicate message\s*$/;
const ALREADY_KNOWN_RESULT: BroadcastResult = Object.freeze({ kind: 'already-known' });

const REFUSED_BY_NODE = refused('TX_REFUSED', 'refused by the node');

export function classifyBroadcastError(message: string): BroadcastResult {
  // A v2 body the transport cut (300 characters) stays JSON-escaped: `\n` is two characters.
  const text = message.slice(0, MAX_TEXT).replace(/\\n/g, '\n');
  const compute = BY_TRANSACTION.exec(text);
  if (compute) {
    if (compute[1] === '0' && compute[2] === '0') return INACTIVE;
    return BY_EXIT_CODE.get(compute[1] as string) ?? REFUSED_BY_NODE;
  }
  if (NO_ACCOUNT.test(text)) return INACTIVE;
  if (BY_ACCOUNT.test(text)) return NO_FUNDS;
  if (MALFORMED.test(text)) return MALFORMED_RESULT;
  if (ALREADY_KNOWN.test(text)) return ALREADY_KNOWN_RESULT;
  return REFUSED_BY_NODE;
}
