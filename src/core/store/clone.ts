/**
 * Deep-clones plain JSON-like data: objects, arrays, `bigint`, `Uint8Array` and other
 * primitives.
 *
 * Deliberately not `structuredClone`: under a sandboxed test runtime (e.g. Jest's
 * per-file VM context), `structuredClone` rebuilds objects against the *host*
 * realm's `Object`/`Array`, so a cloned plain object's prototype ends up `!==` the
 * caller's own `Object.prototype` and `assert.deepStrictEqual` reports a spurious
 * mismatch. This clone is realm-safe: it never uses `instanceof` against this
 * module's own constructors, only `Array.isArray`, `Object.prototype.toString` and
 * prototype-chain shape, so it works the same regardless of which realm the input
 * came from.
 *
 * Only plain data is accepted. A future serialized store (Redis/Postgres) round-trips
 * exactly two non-JSON shapes over the wire — `bigint` and `Uint8Array` — via a
 * tagged encoding. Anything else (`Date`, `Map`, `Set`, `RegExp`, a class instance
 * such as `Amount`/`Address`, a function, a symbol, or a typed array other than
 * `Uint8Array`) has no such encoding, so it is rejected loudly here rather than
 * silently corrupted (as a naive recursive clone would do to a `Uint8Array`, turning
 * its bytes into a `{0: ..., 1: ...}` object) or silently dropped. This also covers
 * symbol-keyed own properties on an otherwise plain object: `Object.entries` skips
 * them silently, so they are rejected explicitly instead of being dropped without
 * a trace.
 */
export function clone<T>(value: T): T {
  if (value === null || value === undefined) return value;

  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'bigint') {
    return value;
  }
  if (kind === 'function' || kind === 'symbol') return reject(value);

  // kind === 'object' from here on.
  if (Array.isArray(value)) {
    // `Array.from` (called on this realm's own `Array`) always builds a this-realm
    // array; `value.map(...)` would not — a foreign-realm array's inherited `.map`
    // uses species-based construction and returns a result still rooted in the
    // *foreign* `Array.prototype`, reintroducing the same realm mismatch this
    // function exists to avoid.
    return Array.from(value as unknown[], (item: unknown) => clone(item)) as unknown as T;
  }
  if (Object.prototype.toString.call(value) === '[object Uint8Array]') {
    return new Uint8Array(value as unknown as Uint8Array) as unknown as T;
  }
  if (isPlainObject(value as object)) {
    if (Object.getOwnPropertySymbols(value as object).length > 0) return reject(value);
    const out: Record<string, unknown> =
      Object.getPrototypeOf(value as object) === null ? Object.create(null) : {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = clone(item);
    }
    return out as T;
  }
  return reject(value);
}

/** True for `{}`/`Object.create(null)`-shaped objects, from any realm. */
function isPlainObject(value: object): boolean {
  const proto: object | null = Object.getPrototypeOf(value);
  if (proto === null) return true;
  return Object.getPrototypeOf(proto) === null;
}

function reject(value: unknown): never {
  throw new TypeError(
    'memory store accepts only plain data (objects, arrays, primitives, bigint, ' +
      `Uint8Array); got ${Object.prototype.toString.call(value)}`,
  );
}
