/**
 * TON message bodies over `@ton/core`: text comments (the memo), native transfers, TEP-74
 * jetton transfers, and the decoders the verdict and history paths use. Loaded only
 * through the adapter manifest's `load()`.
 */
import {
  Address,
  Cell,
  beginCell,
  comment,
  internal,
  loadMessageRelaxed,
  loadOutList,
  type MessageRelaxed,
} from '@ton/core';
import { ProviderError, ValidationError } from '../../core/errors/error';
import { parseTonAddress, rawAddress, type TonWorkchain } from './address';
import { bocWithinLimits } from './api';
import { MAX_COINS } from './fees';

/** TEP-74 op codes, and the text-comment op (0). */
export const OP = Object.freeze({
  comment: 0,
  jettonTransfer: 0x0f8a7ea5,
  jettonInternalTransfer: 0x178d4519,
  jettonNotification: 0x7362d09c,
  jettonExcesses: 0xd53276db,
  w5SignedExternal: 0x7369676e,
  w5SignedInternal: 0x73696e74,
});

/** The longest memo, in UTF-8 bytes (library policy: comments stay a few cells). */
export const MAX_MEMO_BYTES = 1024;

/**
 * The longest provider text `addressFromBoc` decodes (untrusted text is capped before
 * decoding). An address is one cell of at most 1023 bits, under 200 base64 characters as
 * a BOC; the rest leaves room for a slice that still carries refs, so a jetton wallet is
 * never refused for its encoding.
 */
export const MAX_ADDRESS_BOC_LENGTH = 4096;

// The body limits (`MAX_BODY_CELLS`, `MAX_BODY_BOC_LENGTH`) and their header check live
// in the SDK-free `api.ts`, which bounds the cells it hands on the same way.
export { MAX_BODY_BOC_LENGTH, MAX_BODY_CELLS } from './api';

/**
 * The most cells a comment's snake chain may span. A cell holds at most 127 bytes, so a
 * memo of `MAX_MEMO_BYTES` spans 9 cells; 256 cells (about 32 KB of text) keeps the
 * longer comments other wallets write readable while bounding the work on an untrusted
 * body. A longer chain reads as no comment.
 */
export const MAX_COMMENT_CELLS = 256;

/**
 * An address read from an untrusted body, in raw form; null for a workchain other than 0
 * or -1, which names no TON account.
 */
function toRaw(address: Address): string | null {
  const workchain = address.workChain;
  if (workchain !== 0 && workchain !== -1) return null;
  return rawAddress(workchain as TonWorkchain, address.hash);
}

/**
 * The SDK's `Address` for a raw address, parsed strictly: `Address.parseRaw` takes any
 * `parseInt` workchain and throws a bare `Error`.
 */
export function sdkAddress(raw: string): Address {
  const parsed = parseTonAddress(raw);
  if (parsed?.form !== 'raw') {
    throw new ValidationError('INVALID_ADDRESS', 'not a raw TON address');
  }
  return new Address(parsed.workchain, Buffer.from(parsed.hash));
}

const MAX_QUERY_ID = (1n << 64n) - 1n;

/**
 * An amount that does not fit `Coins` is refused with a fixed text that never carries it
 * (`@ton/core` would throw a bare `Error` naming the value).
 */
function coins(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_COINS) {
    throw new ValidationError('INVALID_AMOUNT', 'a TON amount must be in [0, 2^120 - 1]');
  }
  return value;
}

/** A TEP-74 `query_id` is a uint64: range-checked here, never wrapped. */
function queryIdOf(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_QUERY_ID) {
    throw new ValidationError('INVALID_INTENT', 'a TON query id must be a uint64');
  }
  return value;
}

export function memoBytes(memo: string): number {
  return Buffer.byteLength(memo, 'utf8');
}

/** A text comment: op 0, then the UTF-8 text as a snake string. */
export function commentCell(memo: string): Cell {
  return comment(memo);
}

/** A native transfer of `value` nanograms; `bounce` comes from the recipient's address. */
export function nativeMessage(args: {
  readonly to: string;
  readonly value: bigint;
  readonly bounce: boolean;
  readonly memo?: string;
}): MessageRelaxed {
  return internal({
    to: sdkAddress(args.to),
    value: coins(args.value),
    bounce: args.bounce,
    ...(args.memo !== undefined ? { body: commentCell(args.memo) } : {}),
  });
}

/**
 * A TEP-74 `transfer` to the sender's own jetton wallet: `amount` base units to the owner
 * `destination`, excess back to `responseDestination`, and `forwardAmount` nanograms with
 * the memo (if any) as the recipient's notification payload.
 */
export function jettonMessage(args: {
  readonly jettonWallet: string;
  readonly attached: bigint;
  readonly queryId: bigint;
  readonly amount: bigint;
  readonly destination: string;
  readonly responseDestination: string;
  readonly forwardAmount: bigint;
  readonly memo?: string;
}): MessageRelaxed {
  const to = sdkAddress(args.jettonWallet);
  const attached = coins(args.attached);
  const body = beginCell()
    .storeUint(OP.jettonTransfer, 32)
    .storeUint(queryIdOf(args.queryId), 64)
    .storeCoins(coins(args.amount))
    .storeAddress(sdkAddress(args.destination))
    .storeAddress(sdkAddress(args.responseDestination))
    .storeMaybeRef(null)
    .storeCoins(coins(args.forwardAmount));
  if (args.memo !== undefined) body.storeBit(true).storeRef(commentCell(args.memo));
  else body.storeBit(false);
  return internal({
    to,
    value: attached,
    bounce: true,
    body: body.endCell(),
  });
}

/** A one-cell slice holding `raw`: the `get_wallet_address` argument, as base64 BOC. */
export function addressArgument(raw: string): string {
  return beginCell().storeAddress(sdkAddress(raw)).endCell().toBoc().toString('base64');
}

/** The address a get-method returned in a cell or slice (base64 BOC); null if none. */
export function addressFromBoc(boc: string): string | null {
  if (typeof boc !== 'string' || boc.length > MAX_ADDRESS_BOC_LENGTH) return null;
  try {
    const address = Cell.fromBoc(Buffer.from(boc, 'base64'))[0]
      ?.beginParse()
      .loadMaybeAddress();
    return address ? toRaw(address) : null;
  } catch {
    return null;
  }
}

/**
 * The text of a comment body, or undefined for any other body. The snake string is read
 * in one pass: `@ton/core`'s `loadStringTail` recurses per cell and concatenates at each
 * level, which is quadratic in the chain length (3.6 s for one 1 MB comment). Past
 * `MAX_COMMENT_CELLS` cells, or for a cell that is not a whole number of bytes with at
 * most one ref, it is no comment.
 */
export function decodeComment(body: Cell): string | undefined {
  try {
    let slice = body.beginParse();
    if (slice.remainingBits < 32 || slice.loadUint(32) !== OP.comment) return undefined;
    const chunks: Buffer[] = [];
    for (let cells = 1; ; cells += 1) {
      if (cells > MAX_COMMENT_CELLS) return undefined;
      const bits = slice.remainingBits;
      if (bits % 8 !== 0 || slice.remainingRefs > 1) return undefined;
      if (bits > 0) chunks.push(slice.loadBuffer(bits / 8));
      if (slice.remainingRefs === 0) break;
      slice = slice.loadRef().beginParse();
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return undefined;
  }
}

/** The comment carried in a `forward_payload:(Either Cell ^Cell)`, if it is one. */
function forwardComment(slice: ReturnType<Cell['beginParse']>): string | undefined {
  if (slice.remainingBits < 1) return undefined;
  const inRef = slice.loadBit();
  if (inRef) return slice.remainingRefs > 0 ? decodeComment(slice.loadRef()) : undefined;
  return decodeComment(beginCell().storeSlice(slice).endCell());
}

export interface JettonTransferBody {
  readonly queryId: bigint;
  readonly amount: bigint;
  readonly destination: string;
  /** Where the excess goes; null for `addr_none` or a workchain other than 0 or -1. */
  readonly responseDestination: string | null;
  /** Whether a `custom_payload` rides along (for the jetton wallet's own code). */
  readonly customPayload: boolean;
  readonly forwardAmount: bigint;
  readonly comment?: string;
}

/** A TEP-74 `transfer` body, or null for any other body. */
export function decodeJettonTransfer(body: Cell): JettonTransferBody | null {
  try {
    const slice = body.beginParse();
    if (slice.loadUint(32) !== OP.jettonTransfer) return null;
    const queryId = slice.loadUintBig(64);
    const amount = slice.loadCoins();
    const destination = slice.loadAddress();
    const response = slice.loadMaybeAddress();
    const customPayload = slice.loadMaybeRef() !== null;
    const forwardAmount = slice.loadCoins();
    const memo = forwardComment(slice);
    const recipient = toRaw(destination);
    if (recipient === null) return null;
    return {
      queryId,
      amount,
      destination: recipient,
      responseDestination: response ? toRaw(response) : null,
      customPayload,
      forwardAmount,
      ...(memo !== undefined ? { comment: memo } : {}),
    };
  } catch {
    return null;
  }
}

export interface JettonInternalTransferBody {
  readonly queryId: bigint;
  readonly amount: bigint;
  /** The sending owner, when the body names one. */
  readonly from: string | null;
  readonly comment?: string;
}

/** A TEP-74 `internal_transfer` body, or null for any other body. */
export function decodeJettonInternalTransfer(
  body: Cell,
): JettonInternalTransferBody | null {
  try {
    const slice = body.beginParse();
    if (slice.loadUint(32) !== OP.jettonInternalTransfer) return null;
    const queryId = slice.loadUintBig(64);
    const amount = slice.loadCoins();
    const from = slice.loadMaybeAddress();
    slice.loadMaybeAddress();
    slice.loadCoins();
    const memo = forwardComment(slice);
    return {
      queryId,
      amount,
      from: from ? toRaw(from) : null,
      ...(memo !== undefined ? { comment: memo } : {}),
    };
  } catch {
    return null;
  }
}

export interface JettonNotificationBody {
  readonly queryId: bigint;
  readonly amount: bigint;
  /** The sending owner, when the body names one. */
  readonly sender: string | null;
  readonly comment?: string;
}

/** A TEP-74 `transfer_notification` body, or null for any other body. */
export function decodeJettonNotification(body: Cell): JettonNotificationBody | null {
  try {
    const slice = body.beginParse();
    if (slice.loadUint(32) !== OP.jettonNotification) return null;
    const queryId = slice.loadUintBig(64);
    const amount = slice.loadCoins();
    const sender = slice.loadMaybeAddress();
    const memo = forwardComment(slice);
    return {
      queryId,
      amount,
      sender: sender ? toRaw(sender) : null,
      ...(memo !== undefined ? { comment: memo } : {}),
    };
  } catch {
    return null;
  }
}

export interface WalletRequest {
  /**
   * `internal`: a W5 signed request relayed in an internal message (gasless). Anyone can
   * post such a body: it proves nothing until `requestIsOwn` authenticates it.
   */
  readonly auth: 'external' | 'internal';
  /** v4r2: the subwallet id; v5r1: the signed 32-bit wallet id. */
  readonly walletId: number;
  readonly seqno: number;
  readonly validUntil: number;
  readonly messages: readonly MessageRelaxed[];
  /** Each message's send mode, as the wallet reads it (`modes[i]` for `messages[i]`). */
  readonly modes: readonly number[];
}

/** A W5 external request's bits: op, wallet id, `valid_until`, seqno, two flags, signature. */
const W5_EXTERNAL_BITS = 32 + 32 + 32 + 32 + 1 + 1 + 512;
/** A v4r2 request's least bits: signature, subwallet id, `valid_until`, seqno. */
const V4_HEADER_BITS = 512 + 32 + 32 + 32;

/**
 * The signed header of an external wallet request, read alone, as the proof reads a
 * consumer's seqno, so that the replay guard knows stored bytes whose message list does
 * not decode: a W5 request's (its op, then the wallet id, `valid_until` and seqno, in a
 * body of exactly a W5 request's length) or a v4r2 request's (after the signature,
 * whatever the op). Null when the body cannot hold one. Nothing here says whose request
 * it is.
 */
export function requestHeaderOf(body: Cell): {
  readonly walletId: number;
  readonly validUntil: number;
  readonly seqno: number;
} | null {
  try {
    const bits = body.bits.length;
    const s = body.beginParse();
    const w5 = bits === W5_EXTERNAL_BITS && s.preloadUint(32) === OP.w5SignedExternal;
    if (!w5 && bits < V4_HEADER_BITS) return null;
    s.skip(w5 ? 32 : 512);
    const walletId = w5 ? s.loadInt(32) : s.loadUint(32);
    const validUntil = s.loadUint(32);
    return { walletId, validUntil, seqno: s.loadUint(32) };
  } catch {
    return null;
  }
}

/**
 * The signed request inside a v4r2 or v5r1 external message body: its seqno, lifetime and
 * the internal messages it asks for. Null for anything else (another wallet, a plugin or
 * extension request): the verdict then has no evidence and decides nothing.
 */
export function decodeWalletRequest(body: Cell): WalletRequest | null {
  try {
    const bits = body.bits.length;
    const head = body.beginParse();
    const op = bits >= 32 ? head.preloadUint(32) : undefined;
    if (op === OP.w5SignedExternal || op === OP.w5SignedInternal) {
      const s = body.beginParse();
      s.skip(32);
      const walletId = s.loadInt(32);
      const validUntil = s.loadUint(32);
      const seqno = s.loadUint(32);
      const list = s.loadMaybeRef();
      if (s.loadBit()) return null; // extended actions: not a plain transfer
      if (s.remainingBits !== 512 || s.remainingRefs !== 0) return null;
      const actions = list ? loadOutList(list.beginParse()) : [];
      const messages: MessageRelaxed[] = [];
      const modes: number[] = [];
      for (const action of actions) {
        if (action.type !== 'sendMsg') return null;
        messages.push(action.outMsg);
        modes.push(action.mode);
      }
      const auth = op === OP.w5SignedExternal ? 'external' : 'internal';
      return { auth, walletId, seqno, validUntil, messages, modes };
    }
    const s = body.beginParse();
    s.skip(512);
    const walletId = s.loadUint(32);
    const validUntil = s.loadUint(32);
    const seqno = s.loadUint(32);
    if (s.loadUint(8) !== 0) return null; // v4 op 0: simple send
    const messages: MessageRelaxed[] = [];
    const modes: number[] = [];
    while (s.remainingRefs > 0) {
      modes.push(s.loadUint(8));
      messages.push(loadMessageRelaxed(s.loadRef().beginParse()));
    }
    if (s.remainingBits !== 0) return null;
    return { auth: 'external', walletId, seqno, validUntil, messages, modes };
  } catch {
    return null;
  }
}

/** A message's destination (raw), value and body hash (hex), for matching on chain. */
export function messageFacts(message: MessageRelaxed): {
  readonly to: string;
  readonly value: bigint;
  readonly bodyHash: string;
  readonly body: Cell;
} | null {
  if (message.info.type !== 'internal') return null;
  const to = toRaw(message.info.dest);
  if (to === null) return null;
  return {
    to,
    value: message.info.value.coins,
    bodyHash: message.body.hash().toString('hex'),
    body: message.body,
  };
}

/** A body cell from a base64 BOC; null when it does not parse. */
export function cellFromBoc(boc: string | null | undefined): Cell | null {
  if (typeof boc !== 'string' || !bocWithinLimits(boc)) return null;
  try {
    const cells = Cell.fromBoc(Buffer.from(boc, 'base64'));
    return cells.length === 1 ? (cells[0] as Cell) : null;
  } catch {
    return null;
  }
}

/**
 * An indexed message's body, bound to the body hash the quorum keyed. A body that does
 * not parse or hash to `bodyHash`, or that comes without one, is a malformed answer
 * (retryable): no verdict or decoding ever reads an unbound body.
 */
export function messageBody(message: {
  readonly body?: string;
  readonly bodyHash?: string;
}): Cell | null {
  if (message.body === undefined) return null;
  const cell = cellFromBoc(message.body);
  if (!cell || !message.bodyHash || cell.hash().toString('hex') !== message.bodyHash) {
    throw new ProviderError(
      'PROVIDER_UNAVAILABLE',
      'the indexer returned a message body that does not match its hash',
      { retryable: true },
    );
  }
  return cell;
}
