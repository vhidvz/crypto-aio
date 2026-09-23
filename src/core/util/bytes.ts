import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from '@noble/hashes/utils';

export { concatBytes, randomBytes, utf8ToBytes };

/** Decodes hex with or without a `0x` prefix. Throws `TypeError` on malformed input. */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new TypeError('invalid hex string');
  }
  return hexToBytes(clean);
}

export function toHex(bytes: Uint8Array, prefix = false): string {
  const hex = bytesToHex(bytes);
  return prefix ? `0x${hex}` : hex;
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Length-checked comparison that does not stop at the first differing byte. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function randomId(prefix: string): string {
  return `${prefix}_${bytesToHex(randomBytes(12))}`;
}
