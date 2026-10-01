/**
 * Lesson 21 for EVM: what a node's rejection claims is checked against the bytes we sent,
 * read here SDK-free. The reader is never stricter than geth: it calls bytes `malformed`
 * only for what geth's RLP decoder also refuses (a broken or non-canonical encoding, an
 * integer with a leading zero or over 256 bits, the wrong number of fields, a `to` that is
 * not 20 bytes), and it reads no access list, so a claim it cannot confirm stays a refusal.
 */
import { fromHex } from '../../core/util/bytes';

/** The fields lesson 21 checks, of one signed legacy, EIP-2930 or EIP-1559 transaction. */
export interface EvmSentTx {
  readonly type: 0 | 1 | 2;
  /** Absent for a legacy transaction signed without EIP-155 (v of 27 or 28). */
  readonly chainId?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  /** The recovery id: `yParity`, or the legacy `v` reduced to 0 or 1; -1 when neither. */
  readonly recovery: number;
  readonly r: bigint;
  readonly s: bigint;
}

/** Lesson 20: twice geth's 128 KiB pool limit, checked before any decoding. */
export const MAX_SENT_BYTES = 2 * 128 * 1024;

class Malformed extends Error {}
type Item = Uint8Array | readonly Item[];

/** One canonical RLP item at `at`, and the offset after it; throws `Malformed`. */
function item(bytes: Uint8Array, at: number): [Item, number] {
  const lead = bytes[at];
  if (lead === undefined) throw new Malformed();
  const span = (offset: number, length: number): [number, number] => {
    const end = offset + length;
    if (end > bytes.length) throw new Malformed();
    return [offset, end];
  };
  const longLength = (width: number): number => {
    const [start, end] = span(at + 1, width);
    if (bytes[start] === 0) throw new Malformed();
    let length = 0;
    for (let i = start; i < end; i++) length = length * 256 + (bytes[i] as number);
    if (length < 56) throw new Malformed();
    return length;
  };
  if (lead < 0x80) return [bytes.subarray(at, at + 1), at + 1];
  if (lead <= 0xbf) {
    const long = lead > 0xb7;
    const width = long ? lead - 0xb7 : 0;
    const length = long ? longLength(width) : lead - 0x80;
    const [start, end] = span(at + 1 + width, length);
    if (!long && length === 1 && (bytes[start] as number) < 0x80) throw new Malformed();
    return [bytes.subarray(start, end), end];
  }
  const long = lead > 0xf7;
  const width = long ? lead - 0xf7 : 0;
  const length = long ? longLength(width) : lead - 0xc0;
  const [start, end] = span(at + 1 + width, length);
  const items: Item[] = [];
  for (let offset = start; offset < end;) {
    const [next, after] = item(bytes, offset);
    if (after > end) throw new Malformed();
    items.push(next);
    offset = after;
  }
  return [items, end];
}

/** A whole buffer as one list of exactly `fields` items. */
function list(bytes: Uint8Array, fields: number): readonly Item[] {
  const [value, end] = item(bytes, 0);
  if (end !== bytes.length || !Array.isArray(value) || value.length !== fields)
    throw new Malformed();
  return value as readonly Item[];
}

/** A canonical unsigned integer of at most `bits` bits. */
function uint(value: Item | undefined, bits: number): bigint {
  if (!(value instanceof Uint8Array) || value.length * 8 > bits || value[0] === 0)
    throw new Malformed();
  let out = 0n;
  for (const byte of value) out = (out << 8n) | BigInt(byte);
  return out;
}

function address(value: Item | undefined): void {
  if (!(value instanceof Uint8Array) || (value.length !== 0 && value.length !== 20))
    throw new Malformed();
}

/**
 * The sent bytes as lesson 21 reads them: the fields, `'malformed'` when geth could not
 * decode them either, or `undefined` when they are unreadable here but may be valid (an
 * EIP-4844 or EIP-7702 transaction, or more than `MAX_SENT_BYTES`): no claim holds for those.
 */
export function readSentTx(hex: string): EvmSentTx | 'malformed' | undefined {
  if (typeof hex !== 'string' || hex.length > 2 + 2 * MAX_SENT_BYTES) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = fromHex(hex);
  } catch {
    return 'malformed';
  }
  const type = bytes[0];
  if (type === undefined) return 'malformed';
  try {
    if (type >= 0xc0) {
      const [nonce, gasPrice, gas, to, value, , v, r, s] = list(bytes, 9);
      uint(nonce, 64);
      uint(gasPrice, 256);
      uint(gas, 64);
      address(to);
      uint(value, 256);
      const vv = uint(v, 256);
      const eip155 = vv >= 35n;
      return {
        type: 0,
        ...(eip155 ? { chainId: (vv - 35n) / 2n } : {}),
        recovery: eip155
          ? Number((vv - 35n) % 2n)
          : vv === 27n || vv === 28n
            ? Number(vv - 27n)
            : -1,
        r: uint(r, 256),
        s: uint(s, 256),
      };
    }
    if (type === 1 || type === 2) {
      const fields = list(bytes.subarray(1), type === 1 ? 11 : 12);
      const chainId = uint(fields[0], 256);
      uint(fields[1], 64);
      const prices = type === 2 ? [uint(fields[2], 256), uint(fields[3], 256)] : [];
      if (type === 1) uint(fields[2], 256);
      const rest = type === 1 ? 3 : 4;
      uint(fields[rest], 64);
      address(fields[rest + 1]);
      uint(fields[rest + 2], 256);
      const [yParity, r, s] = fields.slice(-3);
      const parity = uint(yParity, 256);
      return {
        type,
        chainId,
        ...(type === 2
          ? {
              maxPriorityFeePerGas: prices[0] as bigint,
              maxFeePerGas: prices[1] as bigint,
            }
          : {}),
        recovery: parity <= 1n ? Number(parity) : -1,
        r: uint(r, 256),
        s: uint(s, 256),
      };
    }
    // geth reads any other first byte above 0x7f as a legacy list, and fails.
    if (type >= 0x80) return 'malformed';
    return undefined;
  } catch (error) {
    if (error instanceof Malformed) return 'malformed';
    throw error;
  }
}

/** secp256k1's group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** geth's `ValidateSignatureValues` with Homestead's low-s rule, over the recovery id. */
export function signatureValuesValid(tx: EvmSentTx): boolean {
  return (
    (tx.recovery === 0 || tx.recovery === 1) &&
    tx.r >= 1n &&
    tx.r < N &&
    tx.s >= 1n &&
    tx.s <= N / 2n
  );
}
