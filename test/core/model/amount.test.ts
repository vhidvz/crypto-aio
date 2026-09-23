import { Amount } from '../../../src/core/model/amount';
import type { AssetInfo } from '../../../src/core/model/asset';
import { thrown } from '../../helpers';

const native: AssetInfo = {
  id: 'testchain:local/native',
  chain: 'testchain',
  network: 'local',
  ref: 'native',
  metadata: { symbol: 'TST', decimals: 18 },
};
const usd: AssetInfo = {
  id: 'testchain:local/erc20:0xabc',
  chain: 'testchain',
  network: 'local',
  ref: { standard: 'erc20', contract: '0xabc' },
  metadata: { symbol: 'USD', decimals: 6 },
};
const whole: AssetInfo = {
  ...native,
  id: 'testchain:local/erc20:0xw',
  metadata: { symbol: 'W', decimals: 0 },
};

describe('Amount', () => {
  it('parses decimal strings using the asset decimals', () => {
    expect(Amount.parse('1.5', native).base).toBe(1_500_000_000_000_000_000n);
    expect(Amount.parse('0.000001', usd).base).toBe(1n);
    expect(Amount.parse('0', usd).base).toBe(0n);
    expect(Amount.parse('42', whole).base).toBe(42n);
    expect(Amount.parse('1.50', usd).base).toBe(1_500_000n);
  });

  it('never rounds or truncates extra precision', () => {
    expect(thrown(() => Amount.parse('0.0000001', usd))).toMatchObject({
      code: 'INVALID_AMOUNT',
      message: expect.stringMatching(/7 fractional digits but USD has 6 decimals/),
    });
    expect(thrown(() => Amount.parse('1.0', whole))).toMatchObject({
      code: 'INVALID_AMOUNT',
    });
  });

  // Review Focus 1: malformed decimal strings are rejected, never coerced.
  it.each([
    '1.',
    '.5',
    '1e3',
    ' 1',
    '1 ',
    '-1',
    '+1',
    '0x10',
    '1_000',
    '１',
    '',
    '01',
    '1,5',
    'NaN',
  ])('rejects %p', (input) => {
    expect(thrown(() => Amount.parse(input, native))).toMatchObject({
      code: 'INVALID_AMOUNT',
    });
  });

  it('accepts bigint as base units and rejects JS numbers and negatives', () => {
    expect(Amount.from(7n, usd).base).toBe(7n);
    expect(thrown(() => Amount.from(1.5, usd))).toMatchObject({
      code: 'INVALID_AMOUNT',
      message: expect.stringMatching(/numbers are not accepted/),
    });
    expect(thrown(() => Amount.from(-1n, usd))).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(thrown(() => Amount.from(null, usd))).toMatchObject({
      code: 'INVALID_AMOUNT',
    });
  });

  it('refuses Amounts of a different asset', () => {
    const a = Amount.from('1', native);
    expect(Amount.from(a, native)).toBe(a);
    expect(thrown(() => Amount.from(a, usd))).toMatchObject({
      code: 'INVALID_AMOUNT',
      message: expect.stringMatching(/denominated in 'testchain:local\/native'/),
    });
  });

  it('formats minimal decimal strings', () => {
    expect(Amount.fromBase(1_500_000_000_000_000_000n, native).toDecimalString()).toBe(
      '1.5',
    );
    expect(Amount.fromBase(1n, usd).toDecimalString()).toBe('0.000001');
    expect(Amount.fromBase(0n, usd).toDecimalString()).toBe('0');
    expect(Amount.fromBase(5n, whole).format()).toBe('5 W');
    expect(JSON.stringify(Amount.fromBase(10n, usd))).toBe(
      '{"base":"10","asset":"testchain:local/erc20:0xabc"}',
    );
  });

  it('does same-asset arithmetic only', () => {
    const one = Amount.parse('1', usd);
    const two = Amount.parse('2', usd);
    expect(one.plus(two).toDecimalString()).toBe('3');
    expect(two.minus(one).equals(one)).toBe(true);
    expect(one.compare(two)).toBe(-1);
    expect(two.compare(one)).toBe(1);
    expect(one.compare(Amount.fromBase(1_000_000n, usd))).toBe(0);
    expect(thrown(() => one.minus(two))).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(thrown(() => one.plus(Amount.parse('1', native)))).toMatchObject({
      code: 'INVALID_AMOUNT',
    });
    expect(Amount.fromBase(0n, usd).isZero()).toBe(true);
  });
});
