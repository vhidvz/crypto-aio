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

describe('output variants (A8, P6-1)', () => {
  const on = (chain: string): AssetInfo => ({
    id: `${chain}:mainnet/native`,
    chain,
    network: 'mainnet',
    ref: 'native',
    metadata: { symbol: 'X', decimals: 6 },
  });
  const stored = (chain: string, to: string, from: string, variant?: object) =>
    toStoredIntent({
      asset: on(chain),
      outputs: [
        {
          to: new Address(chain, {
            canonical: to,
            display: to,
            ...(variant ? { variant: variant as Record<string, unknown> } : {}),
          }),
          amount: Amount.fromBase(1234n, on(chain)),
        },
      ],
      from: new Address(chain, { canonical: from, display: from }),
      memo: 'm',
      fee: 'normal',
    });

  it('leaves the intent hash of outputs without a variant unchanged', () => {
    // Frozen from the code before A8: an output without a variant hashes exactly as before.
    // EVM and Solana carry none; Tron's `hex` and UTXO's `type` are derived from `canonical`.
    const cases: readonly (readonly [string, string, string, string])[] = [
      [
        'ethereum',
        '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        '0x0000000000000000000000000000000000000001',
        '3b4bc23689ba35bccff579071773602e547c796ebb3b1f2cc230ed0ca18b5aea',
      ],
      [
        'bitcoin',
        'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
        'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        '1ad44b6ebad925bfd80e4380db5802ec14a92480f1a0ed1b70f1edb48317864b',
      ],
      [
        'tron',
        'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
        '57a9a67fddd48de43a513210a0c072e81074c2007c6c32f9ff89e0d8b984297c',
      ],
      [
        'solana',
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        '11111111111111111111111111111111',
        'c2955f1688bc0cc1c162bb64f2b1d763bb3954046528da5ad72ad12c198be4d0',
      ],
    ];
    for (const [chain, to, from, hash] of cases) {
      const intent = stored(chain, to, from);
      expect(intent.outputs[0]).toStrictEqual({ to, amount: 1234n });
      expect(intentHash(chain, 'mainnet', intent)).toBe(hash);
    }
  });

  it('carries a variant to drivers as a plain copy and hashes it', () => {
    const raw = `0:${'ab'.repeat(32)}`;
    const variant = { bounceable: false, testOnly: false, urlSafe: true };
    const plain = stored('ton', raw, raw);
    const nonBounceable = stored('ton', raw, raw, variant);
    const bounceable = stored('ton', raw, raw, { ...variant, bounceable: true });
    expect(nonBounceable.outputs[0]).toEqual({ to: raw, amount: 1234n, variant });
    const hashes = new Set(
      [plain, nonBounceable, bounceable].map((i) => intentHash('ton', 'mainnet', i)),
    );
    expect(hashes.size).toBe(3);
  });

  it('treats an empty variant as none, and refuses an undefined value (P25-R13)', () => {
    const raw = `0:${'ef'.repeat(32)}`;
    const plain = stored('ton', raw, raw);
    const empty = stored('ton', raw, raw, {});
    expect(empty.outputs[0]).toStrictEqual({ to: raw, amount: 1234n });
    expect(intentHash('ton', 'mainnet', empty)).toBe(intentHash('ton', 'mainnet', plain));
    const error = thrown(() => stored('ton', raw, raw, { bounceable: undefined }));
    expect(error).toMatchObject({ code: 'INVALID_ADDRESS' });
  });

  it("stores a copy of the address's variant, holding plain values only (M11)", () => {
    const raw = `0:${'cd'.repeat(32)}`;
    const variant = { bounceable: true, testOnly: false, urlSafe: true };
    const address = new Address('ton', { canonical: raw, display: raw, variant });
    const intent = toStoredIntent({
      asset: on('ton'),
      outputs: [{ to: address, amount: Amount.fromBase(1n, on('ton')) }],
      from: address,
      fee: 'normal',
    });
    expect(intent.outputs[0]?.variant).toEqual(variant);
    expect(intent.outputs[0]?.variant).not.toBe(address.variant);
    for (const bad of [
      { nested: { a: 1 } },
      { bytes: new Uint8Array(1) },
      { big: 1n },
      { [Symbol('s')]: 1 },
    ]) {
      const error = thrown(() => stored('ton', raw, raw, bad));
      expect(error).toMatchObject({ code: 'INVALID_ADDRESS' });
      expect(String((error as Error).message)).not.toContain('cdcd');
    }
  });
});
