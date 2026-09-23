import { clone } from '../../../src/core/store/clone';

describe('clone', () => {
  it('round-trips a nested record with a Uint8Array, a bigint and an undefined-valued key', () => {
    const original = {
      id: 'a',
      amount: 5n,
      bytes: new Uint8Array([1, 2, 3]),
      note: undefined,
      tags: ['x', 'y'],
      nested: { child: [1, 2n, { deep: new Uint8Array([9]) }] },
    };
    const cloned = clone(original);
    expect(cloned).toStrictEqual(original);
    expect(Object.prototype.hasOwnProperty.call(cloned, 'note')).toBe(true);
  });

  it('copies bytes: mutating the original afterwards does not change the clone', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const cloned = clone({ bytes });
    bytes[0] = 99;
    expect(cloned.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('turns a Buffer into a plain Uint8Array with the same bytes', () => {
    const buffer = Buffer.from('ab');
    const cloned = clone(buffer);
    expect(cloned).toBeInstanceOf(Uint8Array);
    expect(Object.getPrototypeOf(cloned)).toBe(Uint8Array.prototype);
    expect(Array.from(cloned)).toEqual(Array.from(buffer));
  });

  it('does not share nested objects by reference', () => {
    const original = { child: { value: 1 } };
    const cloned = clone(original);
    expect(cloned).not.toBe(original);
    expect(cloned.child).not.toBe(original.child);
    expect(cloned.child).toEqual(original.child);
  });

  it('rejects a Date', () => {
    expect(() => clone(new Date())).toThrow(TypeError);
  });

  it('rejects a Map', () => {
    expect(() => clone(new Map())).toThrow(TypeError);
  });

  it('rejects a class instance', () => {
    class Foo {
      readonly bar = 1;
    }
    expect(() => clone(new Foo())).toThrow(TypeError);
  });

  it('rejects a function', () => {
    expect(() => clone(() => undefined)).toThrow(TypeError);
  });

  it('clones a frozen plain object', () => {
    const original = Object.freeze({ a: 1, b: [1, 2] });
    const cloned = clone(original);
    expect(cloned).toEqual(original);
    expect(Object.isFrozen(cloned)).toBe(false);
  });
});
