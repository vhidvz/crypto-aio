import {
  canonicalJson,
  parseTagged,
  quorumJson,
  sha256Hex,
  stringifyTagged,
} from '../../../src/core/util/json';

describe('canonicalJson', () => {
  it('sorts keys, drops undefined and tags bigint/bytes', () => {
    expect(
      canonicalJson({ b: 1, a: [2n, undefined], c: undefined, d: new Uint8Array([1]) }),
    ).toBe('{"a":[{"$bigint":"2"},null],"b":1,"d":{"$bytes":"01"}}');
  });

  it('is insensitive to insertion order', () => {
    expect(canonicalJson({ x: 1, y: { b: 2, a: 1 } })).toBe(
      canonicalJson({ y: { a: 1, b: 2 }, x: 1 }),
    );
  });

  it('uses toJSON of class instances and rejects cycles and non-finite numbers', () => {
    class A {
      toJSON() {
        return { v: 1 };
      }
    }
    expect(canonicalJson({ a: new A() })).toBe('{"a":{"v":1}}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/circular/);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
  });

  it('allows the same object twice when not circular', () => {
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
  });
});

describe('quorumJson (P25-R21/M1)', () => {
  it('never writes an object as a bigint or bytes tag, and keeps every key', () => {
    const pairs: (readonly [unknown, unknown])[] = [
      [{ n: 2n }, { n: { $bigint: '2' } }],
      [{ b: new Uint8Array([1]) }, { b: { $bytes: '01' } }],
      [{ $a: 1 }, { $$a: 1 }],
      [JSON.parse('{"__proto__":{"x":1}}'), {}],
    ];
    for (const [a, b] of pairs) expect(quorumJson(a)).not.toBe(quorumJson(b));
    // canonicalJson is unchanged (intentHash depends on it): there, the first two collide.
    expect(canonicalJson({ n: { $bigint: '2' } })).toBe(canonicalJson({ n: 2n }));
  });

  it('matches canonicalJson without $ keys, and stays canonical with them', () => {
    const value = { b: 1, a: [2n, undefined], d: new Uint8Array([1]), c: undefined };
    expect(quorumJson(value)).toBe(canonicalJson(value));
    expect(quorumJson({ $x: { y: 1, $z: 2 } })).toBe(quorumJson({ $x: { $z: 2, y: 1 } }));
    expect(quorumJson({ $x: 1 })).toBe('{"$$x":1}');
  });

  it('uses toJSON and rejects cycles as canonicalJson does', () => {
    class A {
      toJSON() {
        return { $v: 1 };
      }
    }
    expect(quorumJson({ a: new A() })).toBe('{"a":{"$$v":1}}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => quorumJson(cyclic)).toThrow(/circular/);
    expect(() => quorumJson({ n: Number.NaN })).toThrow(/non-finite/);
  });
});

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 "abc" vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('tagged JSON', () => {
  it('round-trips bigint and Uint8Array', () => {
    const value = {
      n: 12345678901234567890n,
      b: new Uint8Array([0, 255]),
      s: 'x',
      l: [1n],
    };
    expect(parseTagged(stringifyTagged(value))).toEqual(value);
  });
});
