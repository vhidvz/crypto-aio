import { Address } from '../../../src/core/model/address';
import { Amount } from '../../../src/core/model/amount';
import type { AssetInfo } from '../../../src/core/model/asset';
import { feeTotal, isFeeSpeed, type FeeEstimate } from '../../../src/core/model/fee';
import {
  collectOutputs,
  intentHash,
  summarizeIntent,
  toStoredIntent,
  type NormalizedIntent,
} from '../../../src/core/model/intent';
import { thrown } from '../../helpers';

const native: AssetInfo = {
  id: 'c:n/native',
  chain: 'c',
  network: 'n',
  ref: 'native',
  metadata: { symbol: 'C', decimals: 8 },
};
const token: AssetInfo = {
  id: 'c:n/t:0x1',
  chain: 'c',
  network: 'n',
  ref: { standard: 't', contract: '0x1' },
  metadata: { symbol: 'T', decimals: 2 },
};

describe('Address', () => {
  it('compares by canonical form and formats through the codec', () => {
    const a = new Address(
      'c',
      { canonical: 'abc', display: 'ABC', variant: { bounce: true } },
      (addr, o) => (o?.raw ? addr.canonical : `fmt:${addr.display}`),
    );
    expect(a.equals('abc')).toBe(true);
    expect(a.equals({ canonical: 'abc', display: 'x' })).toBe(true);
    expect(a.equals(new Address('other', { canonical: 'abc', display: 'abc' }))).toBe(
      false,
    );
    expect(a.format()).toBe('fmt:ABC');
    expect(a.format({ raw: true })).toBe('abc');
    expect(String(a)).toBe('ABC');
    expect(JSON.parse(JSON.stringify(a))).toEqual({
      chain: 'c',
      canonical: 'abc',
      display: 'ABC',
      variant: { bounce: true },
    });
    expect(new Address('c', { canonical: 'q', display: 'q' }).format()).toBe('q');
  });
});

describe('fees', () => {
  it('totals charges per asset', () => {
    const fee: FeeEstimate = {
      kind: 'x',
      speed: 'normal',
      bound: 'upper',
      details: {},
      charges: [
        { amount: Amount.fromBase(5n, native), label: 'network' },
        { amount: Amount.fromBase(2n, native), label: 'rent' },
        { amount: Amount.fromBase(9n, token), label: 'attached' },
      ],
    };
    expect(feeTotal(fee, native.id)?.base).toBe(7n);
    expect(feeTotal(fee, token.id)?.base).toBe(9n);
    expect(feeTotal(fee, 'c:n/t:0x2')).toBeUndefined();
    expect(isFeeSpeed('fast')).toBe(true);
    expect(isFeeSpeed({ gasPrice: 1n })).toBe(false);
  });
});

describe('intent helpers', () => {
  it('accepts either the shorthand or outputs, not both', () => {
    expect(collectOutputs({ to: 'a', amount: '1' })).toEqual([{ to: 'a', amount: '1' }]);
    expect(collectOutputs({ outputs: [{ to: 'a', amount: 1n }] })).toHaveLength(1);
    expect(thrown(() => collectOutputs({ to: 'a' }))).toMatchObject({
      code: 'INVALID_INTENT',
    });
    expect(
      thrown(() => collectOutputs({ to: 'a', amount: '1', outputs: [] })),
    ).toMatchObject({ code: 'INVALID_INTENT' });
    expect(thrown(() => collectOutputs({ outputs: [] }))).toMatchObject({
      code: 'INVALID_INTENT',
    });
    expect(thrown(() => collectOutputs({}))).toMatchObject({ code: 'INVALID_INTENT' });
  });

  it('hashes the normalized intent deterministically', () => {
    const normalized = (amount: Amount): NormalizedIntent => ({
      asset: native,
      outputs: [{ to: new Address('c', { canonical: 'to1', display: 'TO1' }), amount }],
      from: new Address('c', { canonical: 'from1', display: 'FROM1' }),
      fee: 'normal',
    });
    const a = toStoredIntent(normalized(Amount.parse('1.5', native)));
    const b = toStoredIntent(normalized(Amount.fromBase(150_000_000n, native)));
    expect(intentHash('c', 'n', a)).toBe(intentHash('c', 'n', b));
    expect(intentHash('c', 'n', a)).not.toBe(intentHash('c', 'other', a));
    expect(a).toEqual({
      assetId: 'c:n/native',
      asset: 'native',
      outputs: [{ to: 'to1', amount: 150_000_000n }],
      from: 'from1',
      fee: 'normal',
    });
    expect(summarizeIntent({ ...a, memo: 'm' })).toEqual({
      asset: 'c:n/native',
      outputs: [{ to: 'to1', amount: '150000000' }],
      memo: 'm',
    });
  });
});
