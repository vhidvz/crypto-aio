/**
 * Strict, SDK-free decoding of Solana keys and signatures (lesson 4, R58). Only canonical
 * base58 of exactly 32 (keys) or 64 (signatures) bytes is accepted, so the driver never
 * relies on an SDK's leniency (`new PublicKey()` also takes numbers, arrays and BNs).
 */
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { ValidationError } from '../../core/errors/error';

const ALPHABET = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** The bytes of a canonical base58 string of `length` bytes, or `null`. */
export function decodeBase58(value: unknown, length: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 90) return null;
  if (!ALPHABET.test(value)) return null;
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(value);
  } catch {
    return null;
  }
  // Canonical: exactly `length` bytes, and re-encoding gives the same text back.
  if (bytes.length !== length || base58.encode(bytes) !== value) return null;
  return bytes;
}

export const encodeBase58 = (bytes: Uint8Array): string => base58.encode(bytes);

/** A 32-byte account address (on or off the ed25519 curve: PDAs are addresses too). */
export const isAddress = (value: unknown): value is string =>
  decodeBase58(value, 32) !== null;

/** A 64-byte transaction signature. */
export const isSignature = (value: unknown): value is string =>
  decodeBase58(value, 64) !== null;

/**
 * The address of a wallet's ed25519 public key: exactly 32 bytes that decode to a point on
 * the curve and not of small order. Anything else (a 64-byte secret key, a 32-byte seed
 * that is off the curve, the identity point) is refused with `INVALID_ADDRESS`.
 */
export function addressFromPublicKey(publicKey: Uint8Array): string {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new ValidationError(
      'INVALID_ADDRESS',
      'a Solana public key is exactly 32 bytes',
    );
  }
  let point: ReturnType<typeof ed25519.ExtendedPoint.fromHex>;
  try {
    point = ed25519.ExtendedPoint.fromHex(publicKey);
  } catch {
    throw new ValidationError(
      'INVALID_ADDRESS',
      'the public key is not a point on the ed25519 curve',
    );
  }
  if (point.isSmallOrder()) {
    throw new ValidationError('INVALID_ADDRESS', 'the public key has small order');
  }
  return base58.encode(publicKey);
}
