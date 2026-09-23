import { equalBytes, fromHex, randomId, toHex } from '../../../src/core/util/bytes';

describe('bytes', () => {
  it('round-trips hex with and without 0x', () => {
    expect(toHex(fromHex('0x00ff10'))).toBe('00ff10');
    expect(toHex(fromHex('00FF10'), true)).toBe('0x00ff10');
    expect(fromHex('')).toEqual(new Uint8Array());
  });

  it('rejects malformed hex', () => {
    expect(() => fromHex('0x0')).toThrow(TypeError);
    expect(() => fromHex('zz')).toThrow(TypeError);
  });

  it('compares bytes', () => {
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(equalBytes(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
  });

  it('creates prefixed random ids', () => {
    const a = randomId('op');
    expect(a).toMatch(/^op_[0-9a-f]{24}$/);
    expect(randomId('op')).not.toBe(a);
  });
});
