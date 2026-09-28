/**
 * The Solana wire format the driver reads and writes itself, SDK-free: compact-u16 lengths,
 * a legacy message's parts (header, keys, blockhash and instructions, which the builder
 * reads back before anything is signed), and a signed transaction (signatures followed by
 * the message). Message compilation stays with the SDK (`web3.ts`).
 *
 * Read bytes are untrusted (a stored message, a node's answer): every length prefix is
 * checked against the bytes that remain before anything is sliced or allocated, and a
 * malformed input is `null`, never a throw (lesson 20). Written values are range-checked
 * with fixed texts, never wrapped (lesson 19).
 */
import { ValidationError } from '../../core/errors/error';
import { encodeBase58 } from './keys';

const MAX_LENGTH = 0xffff;
const KEY_BYTES = 32;
const BLOCKHASH_BYTES = 32;
const SIGNATURE_BYTES = 64;

/** Solana's compact-u16 ("shortvec") length prefix. */
export function encodeLength(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > MAX_LENGTH) {
    throw new ValidationError(
      'INVALID_INTENT',
      'a length does not fit in its compact-u16 field',
    );
  }
  const out: number[] = [];
  let rest = value;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(byte);
      return Uint8Array.from(out);
    }
    out.push(byte | 0x80);
  }
}

/**
 * A compact-u16 at `offset`: its value and the offset after it, or `null`. Only the
 * canonical form is read, as the runtime reads it: at most three bytes, no zero byte after
 * the first (an alias of a shorter form), and no value above 65,535.
 */
export function decodeLength(
  bytes: Uint8Array,
  offset: number,
): { readonly value: number; readonly next: number } | null {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = bytes[offset + i];
    if (byte === undefined || (byte === 0 && i > 0)) return null;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) {
      return value > MAX_LENGTH ? null : { value, next: offset + i + 1 };
    }
  }
  return null;
}

/** One instruction of a legacy message: its program's key index, account indexes and data. */
export interface MessageInstruction {
  readonly program: number;
  /** Indexes into the message's keys. */
  readonly accounts: Uint8Array;
  readonly data: Uint8Array;
}

/**
 * The parts of one well-formed legacy message. Keys, the blockhash, account indexes and data
 * are views into the message bytes, not copies.
 */
export interface MessageParts {
  /** Signers: the first `required` keys; the fee payer first. */
  readonly required: number;
  readonly readonlySigned: number;
  readonly readonlyUnsigned: number;
  readonly keys: readonly Uint8Array[];
  readonly blockhash: Uint8Array;
  readonly instructions: readonly MessageInstruction[];
}

/**
 * The parts of `message`, or `null` unless it is exactly one well-formed legacy message (the
 * runtime's sanitize rules): at least one signer, a writable fee payer, signer and read-only
 * non-signer ranges within the keys, every program and account index within the keys, no
 * program at index 0, and no trailing bytes. Each count is checked against the bytes that
 * remain before anything is read, so the work and the views it makes are linear in the input.
 */
export function parseMessage(message: Uint8Array): MessageParts | null {
  const required = message[0];
  const readonlySigned = message[1];
  const readonlyUnsigned = message[2];
  if (
    required === undefined ||
    readonlySigned === undefined ||
    readonlyUnsigned === undefined
  ) {
    return null;
  }
  // A versioned message starts with 0x80 | version; the driver only builds legacy ones.
  if (required === 0 || (required & 0x80) !== 0 || readonlySigned >= required) {
    return null;
  }
  const keys = decodeLength(message, 3);
  if (!keys || keys.value < required + readonlyUnsigned) return null;
  let at = keys.next + KEY_BYTES * keys.value + BLOCKHASH_BYTES;
  if (at > message.length) return null;
  const instructions = decodeLength(message, at);
  // Each instruction takes at least three bytes: its program index and two lengths.
  if (!instructions || 3 * instructions.value > message.length - instructions.next) {
    return null;
  }
  at = instructions.next;
  const list: MessageInstruction[] = [];
  for (let i = 0; i < instructions.value; i++) {
    const program = message[at];
    if (program === undefined || program === 0 || program >= keys.value) return null;
    const accounts = decodeLength(message, at + 1);
    if (!accounts || accounts.value > message.length - accounts.next) return null;
    for (let j = accounts.next; j < accounts.next + accounts.value; j++) {
      if ((message[j] as number) >= keys.value) return null;
    }
    const data = decodeLength(message, accounts.next + accounts.value);
    if (!data || data.value > message.length - data.next) return null;
    list.push({
      program,
      accounts: message.subarray(accounts.next, accounts.next + accounts.value),
      data: message.subarray(data.next, data.next + data.value),
    });
    at = data.next + data.value;
  }
  if (at !== message.length) return null;
  const start = keys.next + KEY_BYTES * keys.value;
  return {
    required,
    readonlySigned,
    readonlyUnsigned,
    keys: Array.from({ length: keys.value }, (_, i) =>
      message.subarray(keys.next + KEY_BYTES * i, keys.next + KEY_BYTES * (i + 1)),
    ),
    blockhash: message.subarray(start, start + BLOCKHASH_BYTES),
    instructions: list,
  };
}

/**
 * A legacy message's signer addresses, in order, or `null` unless `message` is exactly one
 * well-formed legacy message (`parseMessage`).
 */
export function messageSigners(message: Uint8Array): readonly string[] | null {
  const parts = parseMessage(message);
  return parts ? parts.keys.slice(0, parts.required).map(encodeBase58) : null;
}

/** A signed transaction: the signatures (64 bytes each), in signer order, then the message. */
export function signedTransaction(
  signatures: readonly Uint8Array[],
  message: Uint8Array,
): Uint8Array {
  if (signatures.some((signature) => signature.length !== SIGNATURE_BYTES)) {
    throw new ValidationError('INVALID_INTENT', 'a Solana signature is exactly 64 bytes');
  }
  const prefix = encodeLength(signatures.length);
  const start = prefix.length + SIGNATURE_BYTES * signatures.length;
  const out = new Uint8Array(start + message.length);
  out.set(prefix, 0);
  signatures.forEach((signature, i) =>
    out.set(signature, prefix.length + SIGNATURE_BYTES * i),
  );
  out.set(message, start);
  return out;
}
