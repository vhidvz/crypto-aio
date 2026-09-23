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
