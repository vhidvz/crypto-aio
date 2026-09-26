import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { fromHex, toHex } from './bytes';

/**
 * Deterministic JSON for hashing: object keys sorted, `undefined` properties omitted,
 * bigint → `{"$bigint":"<decimal>"}`, Uint8Array → `{"$bytes":"<hex>"}`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new WeakSet()));
}

function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError('canonicalJson: non-finite number');
      return value;
    case 'bigint':
      return { $bigint: value.toString() };
    case 'undefined':
      return undefined;
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
  if (value instanceof Uint8Array) return { $bytes: toHex(value) };
  if (seen.has(value)) throw new TypeError('canonicalJson: circular structure');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const c = canonicalize(item, seen);
        return c === undefined ? null : c;
      });
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const toJSON = (value as { toJSON?: () => unknown }).toJSON;
      if (typeof toJSON === 'function') return canonicalize(toJSON.call(value), seen);
      throw new TypeError('canonicalJson: only plain objects are supported');
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const c = canonicalize((value as Record<string, unknown>)[key], seen);
      if (c !== undefined) out[key] = c;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** P25-R4: the longest integer literal `parseJson` revives, in digits without the sign. */
const MAX_EXACT_DIGITS = 80;

/**
 * `JSON.parse`, optionally exact for integers (A12): with `exactIntegers`, every integer
 * literal outside the safe range becomes a `bigint` read from its source text (Node ≥ 22
 * `JSON.parse` source text access), so a u64 amount is never rounded. Safe integers,
 * fractions and exponents stay numbers, so answers keep their shape for ordinary values.
 * With the flag, an integer literal longer than 80 digits (sign excluded) is malformed and
 * throws a `SyntaxError`, as `JSON.parse` does: no amount is that long (u256 has 78 digits),
 * and `BigInt()` of a multi-megabyte literal would take seconds.
 */
export function parseJson(text: string, exactIntegers = false): unknown {
  // A run of 16 digits is the shortest literal that can leave the safe range; without one,
  // the reviver (about 7 times slower on large bodies) cannot change anything.
  if (!exactIntegers || !/\d{16}/.test(text)) return JSON.parse(text);
  return JSON.parse(
    text,
    (_key: string, value: unknown, context?: { readonly source?: string }) => {
      const source = context?.source;
      if (
        typeof value !== 'number' ||
        Number.isSafeInteger(value) ||
        source === undefined ||
        !/^-?\d+$/.test(source)
      )
        return value;
      const digits = source.startsWith('-') ? source.length - 1 : source.length;
      if (digits > MAX_EXACT_DIGITS)
        throw new SyntaxError(`integer literal longer than ${MAX_EXACT_DIGITS} digits`);
      return BigInt(source);
    },
  );
}

export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === 'string' ? utf8ToBytes(input) : input));
}

/** JSON that round-trips bigint and Uint8Array (for external store implementations). */
export function stringifyTagged(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return { $bigint: v.toString() };
    if (v instanceof Uint8Array) return { $bytes: toHex(v) };
    return v;
  });
}

export function parseTagged<T = unknown>(text: string): T {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (Object.keys(o).length === 1) {
        if (typeof o.$bigint === 'string') return BigInt(o.$bigint);
        if (typeof o.$bytes === 'string') return fromHex(o.$bytes);
      }
    }
    return v;
  }) as T;
}
