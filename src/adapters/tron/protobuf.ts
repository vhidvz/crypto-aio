/**
 * The protobuf wire reader the Tron family shares (F4-R22): the codec (`codec.ts`) reads
 * chain transactions with it, and the broadcast classifier (`errors.ts`) the bytes it sent.
 * SDK-free, so the classifier never loads tronweb. Linear in the input (lesson 20): each
 * length is checked against the bytes left before it is used, a varint stops at 64 bits,
 * and field number 0, a group or an unknown wire type makes the message unreadable (`null`),
 * as does a truncated field.
 */

/** A varint as a bigint, length-delimited bytes, or `null` for an opaque fixed-width field. */
export type WireValue = bigint | Uint8Array | null;

export interface WireField {
  readonly field: number;
  readonly value: WireValue;
  /** The field's encoded length, tag included. */
  readonly length: number;
}

/**
 * What a reader does with a fixed-width field (wire types 1 and 5): `opaque` keeps it as a
 * `null` value, for chain data that may carry fields the reader never reads (the codec);
 * `refuse` makes the message unreadable, for a reader that names every field it accepts
 * (the classifier).
 */
export type FixedWidth = 'opaque' | 'refuse';

/** The wire type a known field must have (`singular`). */
export type FieldKinds = Readonly<Record<number, 'varint' | 'bytes'>>;

/** One protobuf message's fields, in order; `null` when the bytes do not read. */
export function wireFields(bytes: Uint8Array, fixed: FixedWidth): WireField[] | null {
  const out: WireField[] = [];
  let i = 0;
  const varint = (): bigint | null => {
    let result = 0n;
    for (let shift = 0n; shift < 64n; shift += 7n) {
      const byte = bytes[i++];
      // The tenth byte carries the 64th bit only.
      if (byte === undefined || (shift === 63n && byte > 1)) return null;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
    }
    return null;
  };
  while (i < bytes.length) {
    const start = i;
    const key = varint();
    if (key === null || key >> 3n === 0n) return null;
    const wire = key & 7n;
    let value: WireValue;
    if (wire === 0n) {
      value = varint();
      if (value === null) return null;
    } else if (wire === 2n) {
      const length = varint();
      if (length === null || length > BigInt(bytes.length - i)) return null;
      value = bytes.subarray(i, i + Number(length));
      i += Number(length);
    } else if ((wire === 1n || wire === 5n) && fixed === 'opaque') {
      i += wire === 1n ? 8 : 4;
      if (i > bytes.length) return null;
      value = null;
    } else {
      return null;
    }
    out.push({ field: Number(key >> 3n), value, length: i - start });
  }
  return out;
}

/**
 * A message whose fields are each singular, by number; `null` when the bytes do not read or
 * a field number repeats, so a value is never guessed between protobuf's merge and last-wins
 * rules. With `kinds`, only the listed fields are accepted, each of its wire type, and a
 * fixed-width field is refused; without, any field is kept and a fixed-width one is opaque.
 */
export function singular(
  bytes: Uint8Array | null,
  kinds?: FieldKinds,
): Map<number, WireValue> | null {
  const fields = bytes ? wireFields(bytes, kinds ? 'refuse' : 'opaque') : null;
  if (!fields) return null;
  const out = new Map<number, WireValue>();
  for (const { field, value } of fields) {
    if (out.has(field)) return null;
    if (kinds) {
      const kind = Object.hasOwn(kinds, field) ? kinds[field] : undefined;
      if (kind === undefined || (kind === 'varint') !== (typeof value === 'bigint')) {
        return null;
      }
    }
    out.set(field, value);
  }
  return out;
}

/** A field's bytes, or `null` when it is absent or not length-delimited. */
export const bytesOf = (value: WireValue | undefined): Uint8Array | null =>
  value instanceof Uint8Array ? value : null;
