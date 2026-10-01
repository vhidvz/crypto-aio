import { secret } from '../../../src/core/secret/secret';
import { deepFreeze } from '../../../src/core/util/freeze';

describe('deepFreeze', () => {
  it('freezes arrays and plain objects all the way down', () => {
    const data = deepFreeze({ a: [{ b: 1 }], c: Object.create(null) as object });
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.a)).toBe(true);
    expect(Object.isFrozen(data.a[0])).toBe(true);
    expect(Object.isFrozen(data.c)).toBe(true);
  });

  it('walks into an object frozen only at its top', () => {
    const inner = { x: 1 };
    deepFreeze({ outer: Object.freeze({ inner }) });
    expect(Object.isFrozen(inner)).toBe(true);
  });

  it('leaves class instances, bytes and functions as they are', () => {
    class Box {
      value = 1;
    }
    const box = new Box();
    const bytes = new Uint8Array([1, 2]);
    const fn = (): number => 1;
    const key = secret('k');
    const data = deepFreeze({ box, bytes, fn, key });
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(box)).toBe(false);
    expect(Object.isFrozen(fn)).toBe(false);
    expect(data.bytes).toBe(bytes);
    bytes[0] = 9;
    expect(data.bytes[0]).toBe(9);
    expect(data.key).toBe(key);
  });

  it('freezes a reference cycle instead of overflowing the stack', () => {
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', a };
    a.b = b;
    a.self = [a];
    expect(deepFreeze(a)).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.isFrozen(a.self)).toBe(true);
  });

  it('returns primitives unchanged', () => {
    expect(deepFreeze(5)).toBe(5);
    expect(deepFreeze(null)).toBe(null);
    expect(deepFreeze(undefined)).toBe(undefined);
    expect(deepFreeze('s')).toBe('s');
  });
});
