/**
 * Avalanche's CB58 encoding (base58 of the bytes followed by the last 4 bytes of their
 * SHA-256), the form of every transaction, block, asset and blockchain id. SDK-free.
 * Decoding checks the checksum; avalanchejs's own decoder does not.
 */
import { sha256 } from '@noble/hashes/sha256';
import { base58 } from '@scure/base';
import { equalBytes } from '../../core/util/bytes';

/** An id is 32 bytes: 36 with the checksum, at most 50 base58 characters. */
const ID_TEXT = /^[1-9A-HJ-NP-Za-km-z]{32,50}$/;

export function cb58Encode(bytes: Uint8Array): string {
  const out = new Uint8Array(bytes.length + 4);
  out.set(bytes, 0);
  out.set(sha256(bytes).subarray(-4), bytes.length);
  return base58.encode(out);
}

/** The bytes of a CB58 string, or `undefined` when it is not one (bad text or checksum). */
export function cb58Decode(text: string): Uint8Array | undefined {
  let raw: Uint8Array;
  try {
    raw = base58.decode(text);
  } catch {
    return undefined;
  }
  if (raw.length < 4) return undefined;
  const body = raw.subarray(0, -4);
  return equalBytes(sha256(body).subarray(-4), raw.subarray(-4))
    ? Uint8Array.from(body)
    : undefined;
}

/** Whether `text` is a CB58 id of 32 bytes (a transaction, block, asset or chain id). */
export function isId(text: unknown): text is string {
  if (typeof text !== 'string' || !ID_TEXT.test(text)) return false;
  return cb58Decode(text)?.length === 32;
}

/** The CB58 id of `bytes`: their SHA-256 (transaction and block ids). */
export function idOf(bytes: Uint8Array): string {
  return cb58Encode(sha256(bytes));
}
