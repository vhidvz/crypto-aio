import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bytesOf, singular, wireFields } from '../../../src/adapters/tron/protobuf';
import { fromHex } from '../../../src/core/util/bytes';

const read = (hex: string, fixed: 'opaque' | 'refuse') => wireFields(fromHex(hex), fixed);

describe('the shared protobuf reader', () => {
  it('reads varints and length-delimited fields in order, with each encoded length', () => {
    // field 1 varint 150, field 2 bytes "hi", field 5 varint 0
    const fields = read('089601' + '12026869' + '2800', 'refuse');
    expect(fields).toEqual([
      { field: 1, value: 150n, length: 3 },
      { field: 2, value: fromHex('6869'), length: 4 },
      { field: 5, value: 0n, length: 2 },
    ]);
    expect(read('', 'refuse')).toEqual([]);
  });

  it('keeps a fixed-width field opaque for the codec, and refuses it for the classifier', () => {
    // field 3 fixed64, field 4 fixed32, then field 1 varint 1
    const hex = '19' + '00'.repeat(8) + '25' + '00'.repeat(4) + '0801';
    expect(read(hex, 'opaque')).toEqual([
      { field: 3, value: null, length: 9 },
      { field: 4, value: null, length: 5 },
      { field: 1, value: 1n, length: 2 },
    ]);
    expect(read(hex, 'refuse')).toBeNull();
    // A truncated fixed-width field never reads.
    expect(read('19' + '00'.repeat(7), 'opaque')).toBeNull();
    expect(read('25' + '00'.repeat(3), 'opaque')).toBeNull();
  });

  it('reads nothing malformed: field 0, groups, unknown wire types, truncation, varints over 64 bits', () => {
    for (const fixed of ['opaque', 'refuse'] as const) {
      for (const hex of [
        '0001', // field number 0
        '0b', // start group
        '0c', // end group
        '0e', // wire type 6
        '0f', // wire type 7
        '08', // a varint with no value
        '0880', // a varint cut short
        '1203aabb', // bytes longer than what is left
        `12${'ff'.repeat(9)}01`, // a length far beyond the input
        `08${'ff'.repeat(9)}02`, // a value over 64 bits
        `08${'80'.repeat(10)}00`, // an eleven-byte varint
      ]) {
        expect(read(hex, fixed)).toBeNull();
      }
      // The largest 64-bit varint reads.
      expect(read(`08${'ff'.repeat(9)}01`, fixed)).toEqual([
        { field: 1, value: 2n ** 64n - 1n, length: 11 },
      ]);
    }
  });

  it('reads singular messages: a repeated field reads as nothing, and kinds name every field', () => {
    expect(singular(fromHex('0801' + '1200'))).toEqual(
      new Map<number, unknown>([
        [1, 1n],
        [2, fromHex('')],
      ]),
    );
    expect(singular(fromHex('0801' + '0802'))).toBeNull();
    expect(singular(null)).toBeNull();
    // Without kinds any field is kept, a fixed-width one as null.
    expect(singular(fromHex('19' + '00'.repeat(8)))).toEqual(new Map([[3, null]]));
    const kinds = { 1: 'varint', 2: 'bytes' } as const;
    expect(singular(fromHex('0801' + '1200'), kinds)?.get(1)).toBe(1n);
    for (const hex of [
      '1801', // a field the kinds do not name
      '1a00', // one of another wire type
      '0a00', // field 1 as bytes
      '1001', // field 2 as a varint
      '0801' + '0801', // repeated
      '09' + '00'.repeat(8), // fixed-width
    ]) {
      expect(singular(fromHex(hex), kinds)).toBeNull();
    }
    expect(bytesOf(fromHex('ab'))).toEqual(fromHex('ab'));
    expect(bytesOf(1n)).toBeNull();
    expect(bytesOf(null)).toBeNull();
    expect(bytesOf(undefined)).toBeNull();
  });

  it('reads large inputs in one linear pass', () => {
    // 200,000 one-byte varint fields, and one field of 1 MiB.
    expect(read('0801'.repeat(200_000), 'refuse')).toHaveLength(200_000);
    const big = read(`12808040${'61'.repeat(1_048_576)}`, 'refuse');
    expect(big?.[0]?.length).toBe(1 + 3 + 1_048_576);
  });

  it('is SDK-free, and so is the classifier that uses it', () => {
    for (const file of ['protobuf.ts', 'errors.ts']) {
      const source = readFileSync(
        join(__dirname, '..', '..', '..', 'src', 'adapters', 'tron', file),
        'utf8',
      );
      expect(source).not.toMatch(/from\s+['"](?:tronweb|\.\/codec)['"]/);
    }
  });
});
