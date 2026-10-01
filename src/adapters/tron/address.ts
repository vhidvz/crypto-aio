/**
 * Tron addresses, SDK-free: `0x41` + the last 20 bytes of the keccak-256 hash of
 * the uncompressed public key, shown as base58check (`T…`, canonical) or as 42 hex digits
 * (the `hex` variant). Decoding is strict: base58check with the right checksum, exactly 21
 * bytes and the `0x41` prefix, or `41` + 40 hex digits. Public keys must be 33- or 65-byte
 * points on the curve; tronweb's `computeAddress` would hash other lengths as is.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { createBase58check } from '@scure/base';
import type { AddressCodec } from '../../core/driver/types';
import { ValidationError } from '../../core/errors/error';
import type { AddressFormatter, NormalizedAddress } from '../../core/model/address';
import { fromHex, toHex } from '../../core/util/bytes';

const base58check = createBase58check(sha256);
const HEX_ADDRESS = /^41[0-9a-fA-F]{40}$/;
/** Every base58check form of 21 bytes starting `0x41` has exactly 34 characters. */
const BASE58_LENGTH = 34;
const BASE58_ALPHABET = /^T[1-9A-HJ-NP-Za-km-z]*$/;

function invalid(): ValidationError {
  return new ValidationError('INVALID_ADDRESS', 'not a Tron address');
}

/** The 21 address bytes of a base58check or `41…` hex address; throws INVALID_ADDRESS. */
export function addressBytes(value: string): Uint8Array {
  if (typeof value !== 'string') throw invalid();
  if (HEX_ADDRESS.test(value)) return fromHex(value);
  // Base58 decoding is quadratic (10,000 characters block the event loop for about a
  // minute), so this length check is the one gate before the decoder; the alphabet
  // check deliberately leaves the length to it.
  if (value.length !== BASE58_LENGTH || !BASE58_ALPHABET.test(value)) throw invalid();
  let bytes: Uint8Array;
  try {
    bytes = base58check.decode(value);
  } catch {
    throw invalid();
  }
  if (bytes.length !== 21 || bytes[0] !== 0x41) throw invalid();
  return bytes;
}

/** Lower-case `41…` hex form (what the HTTP API takes with `visible: false`). */
export function toHexAddress(value: string): string {
  return toHex(addressBytes(value));
}

/** Base58check `T…` form, the canonical one. */
export function toBase58Address(value: string): string {
  return base58check.encode(addressBytes(value));
}

export function isTronAddress(value: string): boolean {
  try {
    addressBytes(value);
    return true;
  } catch {
    return false;
  }
}

/** Only a 33-byte compressed or 65-byte `0x04` point on the curve; returns 65 bytes. */
export function uncompressedPublicKey(publicKey: Uint8Array): Uint8Array {
  const prefix = publicKey instanceof Uint8Array ? publicKey[0] : undefined;
  const shaped =
    ((prefix === 0x02 || prefix === 0x03) && publicKey.length === 33) ||
    (prefix === 0x04 && publicKey.length === 65);
  try {
    if (shaped) return secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false);
  } catch {
    // Not a point on the curve.
  }
  throw new ValidationError(
    'INVALID_ADDRESS',
    'public key must be a 33- or 65-byte secp256k1 point',
  );
}

export function addressFromPublicKey(publicKey: Uint8Array): string {
  const hash = keccak_256(uncompressedPublicKey(publicKey).subarray(1));
  const bytes = new Uint8Array(21);
  bytes[0] = 0x41;
  bytes.set(hash.subarray(12), 1);
  return base58check.encode(bytes);
}

/**
 * `variant.hex` is part of the intent hash. It is a pure function of `canonical`
 * (a JSON string), so a recipient typed in base58 or in hex hashes the same.
 */
export function normalizeTronAddress(value: string): NormalizedAddress {
  const bytes = addressBytes(value);
  const canonical = base58check.encode(bytes);
  return { canonical, display: canonical, variant: { hex: toHex(bytes) } };
}

/** `address.format({ hex: true })` renders the `41…` hex form; otherwise base58. */
export const formatTronAddress: AddressFormatter = (address, options) =>
  options?.hex === true ? toHexAddress(address.canonical) : address.canonical;

export const tronAddressCodec: AddressCodec = {
  validate: isTronAddress,
  normalize: normalizeTronAddress,
  fromPublicKey: (publicKey) => normalizeTronAddress(addressFromPublicKey(publicKey)),
  format: formatTronAddress,
};
