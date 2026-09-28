import { hexToBytes } from '@noble/hashes/utils';
import { compactSize } from '../../../src/adapters/utxo/address';
import {
  MAX_STANDARD_WEIGHT,
  selectCoins,
  txWeight,
  vsizeOf,
  type Spendable,
} from '../../../src/adapters/utxo/coinselect';
import {
  classifyBroadcast,
  classifyOwnBroadcast,
  parseNodeError,
  type TxBytes,
} from '../../../src/adapters/utxo/errors';
import {
  assertSaneFee,
  feeAt,
  rateForSpeed,
  rateFromOverride,
  replacementFloor,
  satPerKvB,
} from '../../../src/adapters/utxo/fees';

const POLICY = {
  minRelayFee: 1_000n,
  maxFeeRate: 1_000_000n,
  maxFee: 10_000_000n,
  maxEstimatedFeeRate: 200_000n,
};
const P2WPKH = hexToBytes('0014' + '11'.repeat(20));
const P2TR = hexToBytes('5120' + '22'.repeat(32));
const coin = (n: number, value: bigint): Spendable => ({
  outpoint: `${n.toString(16).padStart(64, '0')}:0`,
  txid: n.toString(16).padStart(64, '0'),
  vout: 0,
  value,
});

describe('fee rates', () => {
  it('reads Esplora sat/vB floats as sat/kvB without float noise', () => {
    expect(satPerKvB(2.304)).toBe(2_304n);
    expect(satPerKvB(1.0679999999999998)).toBe(1_068n);
    expect(satPerKvB(0.09999999999999999)).toBe(100n);
    expect(satPerKvB(12.3456)).toBe(12_346n);
  });

  it('takes the target, else the nearest faster one, never below the relay floor', () => {
    const estimates = new Map([
      [1, 30],
      [3, 20],
      [6, 10],
      [144, 0.5],
    ]);
    expect(rateForSpeed(estimates, 'normal', POLICY)).toBe(10_000n);
    expect(rateForSpeed(estimates, 'fast', POLICY)).toBe(30_000n);
    expect(rateForSpeed(estimates, 'slow', POLICY)).toBe(1_000n);
  });

  it('decides nothing when one endpoint estimates an absurd rate (M3)', () => {
    expect(rateForSpeed(new Map([[6, 200]]), 'normal', POLICY)).toBe(200_000n);
    expect(() => rateForSpeed(new Map([[6, 200.001]]), 'normal', POLICY)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
    );
    // An explicit override is bounded by maxFeeRate only.
    expect(rateFromOverride({ satPerVByte: 500n }, POLICY)).toBe(500_000n);
  });

  it('decides nothing on mainnet without an estimate, and uses a test network fallback', () => {
    expect(() => rateForSpeed(new Map(), 'normal', POLICY)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
    );
    expect(rateForSpeed(new Map(), 'normal', { ...POLICY, feeFallback: 1_000n })).toBe(
      1_000n,
    );
  });

  it('clamps a registry fallback below the relay floor up to the floor', () => {
    // feeFallback is registry data, not checked against minRelayFee when the config loads.
    expect(rateForSpeed(new Map(), 'normal', { ...POLICY, feeFallback: 500n })).toBe(
      1_000n,
    );
    expect(rateForSpeed(new Map(), 'slow', { ...POLICY, feeFallback: 0n })).toBe(1_000n);
    expect(rateForSpeed(new Map(), 'fast', { ...POLICY, feeFallback: 2_500n })).toBe(
      2_500n,
    );
  });

  it('decides nothing on a malformed estimate, and never throws a foreign error', () => {
    // Finite but huge: x × 1e6 overflows to Infinity inside satPerKvB.
    for (const bad of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_VALUE,
      1e303,
      1e7 + 1,
    ]) {
      expect(() => rateForSpeed(new Map([[6, bad]]), 'normal', POLICY)).toThrow(
        expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
      );
    }
  });

  it('parses { satPerVByte } strictly (Review Focus 4)', () => {
    expect(rateFromOverride({ satPerVByte: 3n }, POLICY)).toBe(3_000n);
    expect(rateFromOverride({ satPerVByte: '2.5' }, POLICY)).toBe(2_500n);
    expect(rateFromOverride({ satPerVByte: '1.001' }, POLICY)).toBe(1_001n);
    for (const bad of [
      { satPerVByte: 2 },
      { satPerVByte: '2.0001' },
      { satPerVByte: '-1' },
      { satPerVByte: '1e3' },
      { satPerVByte: ' 5' },
      { satPerVByte: 5n, extra: 1 },
      { satPerKvB: 5_000n },
    ]) {
      expect(() => rateFromOverride(bad, POLICY)).toThrow(
        expect.objectContaining({ code: 'INVALID_INTENT' }),
      );
    }
    expect(() => rateFromOverride({ satPerVByte: '0.5' }, POLICY)).toThrow(
      expect.objectContaining({ code: 'FEE_TOO_LOW' }),
    );
  });

  it('refuses an absurd fee before signing (Review Focus 4)', () => {
    expect(() => assertSaneFee(feeAt(1_000_000n, 200), 200, POLICY)).not.toThrow();
    expect(() => assertSaneFee(feeAt(1_000_001n, 200), 200, POLICY)).toThrow(
      expect.objectContaining({ code: 'INVALID_INTENT' }),
    );
    expect(() => assertSaneFee(10_000_001n, 100_000, POLICY)).toThrow(
      expect.objectContaining({ code: 'INVALID_INTENT' }),
    );
  });

  it('floors a replacement at rules 3, 4 and a strictly higher rate', () => {
    // Rule 4 dominates: 1,000 + 1 sat/vB x 150 vB.
    expect(replacementFloor({ fee: 1_000n, vsize: 150 }, 150, 1_000n)).toBe(1_150n);
    // A much larger replacement: the rate rule dominates (1,000/100 x 400 + 1).
    expect(replacementFloor({ fee: 1_000n, vsize: 100 }, 400, 100n)).toBe(4_001n);
    // M1: the replaced size can be smaller than estimated (a 71-byte signature), and v28/v29
    // compare rates truncated to sat/kvB: the rate rule clears both.
    expect(replacementFloor({ fee: 1_410n, vsize: 141, minVsize: 140 }, 209, 100n)).toBe(
      2_106n,
    );
    expect(replacementFloor({ fee: 1_410n, vsize: 141 }, 209, 100n)).toBe(2_091n);
    expect(feeAt(1_000n, 141)).toBe(141n);
    expect(feeAt(1_500n, 141)).toBe(212n);
  });
});

describe('transaction size', () => {
  it('matches the standard sizes of each wallet type (1 input, 2 p2wpkh outputs)', () => {
    const two = [22, 22];
    expect(vsizeOf(txWeight('p2wpkh', 1, two))).toBe(141);
    expect(vsizeOf(txWeight('p2sh-p2wpkh', 1, two))).toBe(164);
    expect(vsizeOf(txWeight('p2pkh', 1, two))).toBe(220);
    expect(vsizeOf(txWeight('p2tr', 1, two))).toBe(130);
  });

  it('sizes CompactSize counts at every width boundary (lesson 19)', () => {
    const cases: [number, number][] = [
      [0, 1],
      [0xfc, 1],
      [0xfd, 3],
      [0xffff, 3],
      [0x10000, 5],
      [0xffffffff, 5],
      [0x100000000, 9],
    ];
    for (const [n, bytes] of cases) expect(compactSize(n)).toBe(bytes);
  });
});

describe('selectCoins', () => {
  const base = {
    changeScript: P2WPKH,
    inputType: 'p2wpkh' as const,
    rate: 10_000n,
    dustRelayFee: 3_000n,
    strategy: 'accumulative' as const,
  };

  it('accumulates the largest outputs first and pays change back', () => {
    const selection = selectCoins({
      ...base,
      candidates: [coin(1, 30_000n), coin(2, 80_000n), coin(3, 50_000n)],
      outputs: [{ script: P2TR, value: 100_000n }],
    });
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.inputs.map((i) => i.value)).toEqual([80_000n, 50_000n]);
    expect(selection.fee).toBe(feeAt(10_000n, selection.vsize));
    expect(selection.change).toBe(130_000n - 100_000n - selection.fee);
  });

  it('gives change below the dust threshold to the fee (Review Focus 4)', () => {
    const fee = feeAt(10_000n, vsizeOf(txWeight('p2wpkh', 1, [34])));
    const selection = selectCoins({
      ...base,
      candidates: [coin(1, 100_000n)],
      outputs: [{ script: P2TR, value: 100_000n - fee - 200n }],
    });
    expect(selection).toMatchObject({ ok: true, change: 0n, fee: fee + 200n });
  });

  it('skips outputs worth less than their own spending fee, except with "all"', () => {
    const candidates = [coin(1, 100_000n), coin(2, 500n)];
    const outputs = [{ script: P2TR, value: 98_000n }];
    const accumulative = selectCoins({ ...base, candidates, outputs });
    expect(accumulative.ok ? accumulative.inputs.length : -1).toBe(1);
    const all = selectCoins({
      ...base,
      candidates,
      outputs: [{ script: P2TR, value: 90_000n }],
      strategy: 'all',
    });
    expect(all.ok ? all.inputs.map((i) => i.value) : []).toEqual([100_000n, 500n]);
  });

  it('keeps the required inputs of a replacement first', () => {
    const selection = selectCoins({
      ...base,
      required: [coin(9, 20_000n)],
      candidates: [coin(1, 90_000n)],
      outputs: [{ script: P2TR, value: 50_000n }],
    });
    expect(selection.ok ? selection.inputs.map((i) => i.outpoint) : []).toEqual([
      coin(9, 0n).outpoint,
      coin(1, 0n).outpoint,
    ]);
  });

  it('reports the shortfall with the fee of spending everything', () => {
    const selection = selectCoins({
      ...base,
      candidates: [coin(1, 10_000n)],
      outputs: [{ script: P2TR, value: 50_000n }],
    });
    expect(selection).toMatchObject({ ok: false, available: 10_000n });
    if (selection.ok) return;
    expect(selection.required).toBe(50_000n + selection.fee);
  });

  it('spends an output named twice by the listing only once', () => {
    const selection = selectCoins({
      ...base,
      required: [coin(9, 20_000n)],
      candidates: [
        coin(1, 40_000n),
        coin(1, 40_000n),
        coin(9, 20_000n),
        coin(2, 30_000n),
      ],
      outputs: [{ script: P2TR, value: 85_000n }],
    });
    expect(selection.ok ? selection.inputs.map((i) => i.outpoint) : []).toEqual([
      coin(9, 0n).outpoint,
      coin(1, 0n).outpoint,
      coin(2, 0n).outpoint,
    ]);
    const short = selectCoins({
      ...base,
      candidates: [coin(1, 40_000n), coin(1, 40_000n)],
      outputs: [{ script: P2TR, value: 60_000n }],
    });
    expect(short).toMatchObject({ ok: false, available: 40_000n });
  });

  it('spends everything before it reports a shortfall that everything covers', () => {
    // p2tr at 1 sat/vB: one input is 230 WU, so its cost rounds up to 58 vB alone, but the
    // second-to-third step is 57 vB (169 -> 226). A 58-sat output is skipped as worth no
    // more than its cost, yet all three inputs pay 50,000 + 226 exactly.
    const p2tr = selectCoins({
      ...base,
      inputType: 'p2tr',
      rate: 1_000n,
      candidates: [coin(1, 30_000n), coin(2, 20_168n), coin(3, 58n)],
      outputs: [{ script: P2TR, value: 50_000n }],
    });
    expect(p2tr).toMatchObject({ ok: true, change: 0n, fee: 226n, vsize: 226 });
    expect(p2tr.ok ? p2tr.inputs.map((i) => i.value) : []).toEqual([
      30_000n,
      20_168n,
      58n,
    ]);
    // p2sh-p2wpkh at 1.5 sat/vB: 91 vB costs 137 sat alone (136.5 rounded up), but the
    // first-to-second step costs 136 (218 -> 354).
    const nested = selectCoins({
      ...base,
      inputType: 'p2sh-p2wpkh',
      rate: 1_500n,
      candidates: [coin(1, 50_217n), coin(2, 137n)],
      outputs: [{ script: P2TR, value: 50_000n }],
    });
    expect(nested).toMatchObject({ ok: true, change: 0n, fee: 354n, vsize: 236 });
  });

  it('refuses a transaction above the standard weight', () => {
    const candidates = Array.from({ length: 1_500 }, (_, i) => coin(i + 1, 1_000_000n));
    expect(txWeight('p2wpkh', 1_500, [22]) > MAX_STANDARD_WEIGHT).toBe(true);
    expect(() =>
      selectCoins({
        ...base,
        candidates,
        outputs: [{ script: P2TR, value: 1_000_000n }],
        strategy: 'all',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INTENT' }));
  });
});

describe('broadcast classification (lesson 3, R24)', () => {
  const blockstream = (code: number, message: string) =>
    `sendrawtransaction RPC error ${code}: ${message}`;
  const mempool = (code: number, message: string) =>
    `sendrawtransaction RPC error: ${JSON.stringify({ code, message })}`;

  it.each([
    [-26, 'txn-already-in-mempool', { kind: 'already-known' }],
    [-27, 'Transaction outputs already in utxo set', { kind: 'already-known' }],
    [-26, 'txn-same-nonwitness-data-in-mempool', { kind: 'already-known' }],
    [
      -26,
      'bad-txns-in-belowout, value in (100) < value out (200)',
      { kind: 'rejected', reason: 'invalid by consensus rules' },
    ],
    [
      -26,
      'bad-txns-inputs-duplicate',
      { kind: 'rejected', reason: 'invalid by consensus rules' },
    ],
    [
      -26,
      'mandatory-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation)',
      { kind: 'rejected', reason: 'script verification failed' },
    ],
    [
      -26,
      'block-script-verify-flag-failed (Invalid Schnorr signature)',
      { kind: 'rejected', reason: 'script verification failed' },
    ],
    [
      -22,
      'TX decode failed. Make sure the tx has at least one input.',
      { kind: 'rejected', reason: 'the transaction does not decode' },
    ],
    [
      -26,
      'min relay fee not met, 100 < 141',
      { kind: 'refused', code: 'FEE_TOO_LOW', reason: 'fee too low for the node' },
    ],
    [
      -26,
      'mempool min fee not met, 141 < 705',
      { kind: 'refused', code: 'FEE_TOO_LOW', reason: 'fee too low for the node' },
    ],
    [
      -26,
      'insufficient fee, rejecting replacement 1111111111111111111111111111111111111111111111111111111111111111, less fees than conflicting txs; 100 < 200',
      { kind: 'refused', code: 'FEE_TOO_LOW', reason: 'fee too low for the node' },
    ],
    [
      -25,
      'bad-txns-inputs-missingorspent',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'inputs missing or already spent' },
    ],
    [
      -26,
      'txn-mempool-conflict',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'inputs missing or already spent' },
    ],
    [
      -26,
      'non-mandatory-script-verify-flag (Non-canonical DER signature)',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'the node refused the transaction' },
    ],
    [
      -26,
      'mempool-script-verify-flag-failed (Non-canonical DER signature)',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'the node refused the transaction' },
    ],
    [
      -26,
      'dust',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'the node refused the transaction' },
    ],
    [
      -26,
      'tx-size',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'the node refused the transaction' },
    ],
    [
      -26,
      'mempool full',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'the node refused the transaction' },
    ],
    [
      -26,
      'too-long-mempool-chain, too many descendants',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'the node refused the transaction' },
    ],
    [
      -26,
      'non-BIP68-final',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'the node refused the transaction' },
    ],
    [
      -25,
      'Fee exceeds maximum configured by user (e.g. -maxtxfee, maxfeerate)',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'the node refused the transaction' },
    ],
    [
      -26,
      'coinbase-ish text that is not a reason',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'the node refused the transaction' },
    ],
  ] as const)('%s %s', (code, message, expected) => {
    expect(classifyBroadcast(parseNodeError(blockstream(code, message)))).toEqual(
      expected,
    );
    expect(classifyBroadcast(parseNodeError(mempool(code, message)))).toEqual(expected);
  });

  const REFUSED_BY_NODE = {
    kind: 'refused',
    code: 'TX_REFUSED',
    reason: 'the node refused the transaction',
  } as const;

  it('classifies a body cut at the transport limit the same in both formats', () => {
    // The transport keeps the first 300 characters of a 400 body (`details.body`), which
    // leaves mempool/electrs' JSON unterminated when bitcoind's message is long.
    const cut = (body: string) => body.slice(0, 300);
    const tail = `, "input 0" ${'ab'.repeat(200)}`;
    for (const [code, message, expected] of [
      [
        -26,
        `block-script-verify-flag-failed (Invalid Schnorr signature)${tail}`,
        { kind: 'rejected', reason: 'script verification failed' },
      ],
      [
        -26,
        `insufficient fee, rejecting replacement${tail}`,
        { kind: 'refused', code: 'FEE_TOO_LOW', reason: 'fee too low for the node' },
      ],
      [-27, `outputs${tail}`, { kind: 'already-known' }],
      [-26, `dust${tail}`, REFUSED_BY_NODE],
    ] as const) {
      expect(mempool(code, message).length).toBeGreaterThan(300);
      expect(classifyBroadcast(parseNodeError(cut(blockstream(code, message))))).toEqual(
        expected,
      );
      expect(classifyBroadcast(parseNodeError(cut(mempool(code, message))))).toEqual(
        expected,
      );
    }
  });

  it("rejects only under bitcoind's own code for the reason (lesson 3)", () => {
    // A consensus text outside bitcoind's structured answer, or under another code,
    // decides nothing: `rejected` ends the Attempt, so any doubt falls to a refusal.
    for (const error of [
      { message: 'bad-txns-in-belowout, value in (100) < value out (200)' },
      { message: 'mandatory-script-verify-flag-failed (Invalid Schnorr signature)' },
      { message: 'TX decode failed. Make sure the tx has at least one input.' },
      { code: -25, message: 'bad-txns-inputs-duplicate' },
      {
        code: -26,
        message: 'TX decode failed. Make sure the tx has at least one input.',
      },
      {
        code: -22,
        message: 'block-script-verify-flag-failed (Invalid Schnorr signature)',
      },
    ]) {
      expect(classifyBroadcast(error)).toEqual(REFUSED_BY_NODE);
    }
    expect(classifyBroadcast(parseNodeError('bad-txns-inputs-duplicate'))).toEqual(
      REFUSED_BY_NODE,
    );
  });

  it('defaults an unknown body to a refusal and never echoes node text', () => {
    const result = classifyBroadcast(parseNodeError('<html>bad gateway 1.2.3.4</html>'));
    expect(result).toEqual({
      kind: 'refused',
      code: 'TX_REFUSED',
      reason: 'the node refused the transaction',
    });
  });

  it('reads only the head of a 100,000-character body (lesson 20)', () => {
    // Unbounded, the mempool/electrs pattern retries at every "RPC error: {" (quadratic).
    // The cap is pinned by structure, not time: an answer past the first 1,024 characters
    // is never read, so it cannot decide anything.
    expect(
      classifyBroadcast(
        parseNodeError('x'.repeat(1_024) + blockstream(-26, 'bad-txns-inputs-duplicate')),
      ),
    ).toEqual(REFUSED_BY_NODE);
    const hostile = 'sendrawtransaction RPC error: {'.repeat(100_000 / 31 + 1);
    expect(hostile.length).toBeGreaterThan(100_000);
    expect(classifyBroadcast(parseNodeError(hostile))).toEqual(REFUSED_BY_NODE);
    const tail = 'x'.repeat(100_000);
    for (const body of [
      blockstream(-26, `bad-txns-inputs-duplicate, ${tail}`),
      mempool(-26, `bad-txns-inputs-duplicate, ${tail}`),
    ]) {
      expect(classifyBroadcast(parseNodeError(body))).toEqual({
        kind: 'rejected',
        reason: 'invalid by consensus rules',
      });
    }
  });
});

describe("a node's rejection is a claim (lesson 21)", () => {
  const MAX_MONEY = 2_100_000_000_000_000n;
  const A = { txid: 'aa'.repeat(32), vout: 0 };
  const B = { txid: 'bb'.repeat(32), vout: 1 };
  const NULL = { txid: '00'.repeat(32), vout: 0xffffffff };
  const tx = (extra: Partial<TxBytes> = {}): TxBytes => ({
    inputs: [A],
    values: [1_000n],
    strippedSize: 110,
    ...extra,
  });
  const CLAIMED = {
    kind: 'refused',
    code: 'TX_REFUSED',
    reason: 'the node claimed the transaction is invalid',
  };
  const CONSENSUS = { kind: 'rejected', reason: 'invalid by consensus rules' };
  const claim = (message: string, bytes: TxBytes | undefined, code = -26) =>
    classifyOwnBroadcast({ code, message }, bytes);

  it('keeps a byte-only rejection exactly when its reason holds for the bytes', () => {
    // [reason, bytes it holds for, bytes it does not hold for]
    const cases: [string, TxBytes, TxBytes][] = [
      ['bad-txns-vin-empty', tx({ inputs: [] }), tx()],
      ['bad-txns-vout-empty', tx({ values: [] }), tx()],
      [
        'bad-txns-oversize',
        tx({ strippedSize: 1_000_001 }),
        tx({ strippedSize: 1_000_000 }),
      ],
      ['bad-txns-vout-negative', tx({ values: [5n, -1n] }), tx({ values: [0n] })],
      [
        'bad-txns-vout-toolarge',
        tx({ values: [MAX_MONEY + 1n] }),
        tx({ values: [MAX_MONEY] }),
      ],
      [
        'bad-txns-txouttotal-toolarge',
        tx({ values: [MAX_MONEY, 1n] }),
        tx({ values: [MAX_MONEY - 1n, 1n] }),
      ],
      ['bad-txns-inputs-duplicate', tx({ inputs: [A, B, A] }), tx({ inputs: [A, B] })],
      ['bad-txns-prevout-null', tx({ inputs: [A, NULL] }), tx({ inputs: [NULL] })],
      ['coinbase', tx({ inputs: [NULL] }), tx({ inputs: [A, NULL] })],
    ];
    for (const [reason, holds, fails] of cases) {
      expect(claim(`${reason}, detail`, holds)).toEqual(CONSENSUS);
      expect(claim(reason, fails)).toEqual(CLAIMED);
      // Bytes that do not decode prove no `CheckTransaction` reason.
      expect(claim(reason, undefined)).toEqual(CLAIMED);
    }
    // bitcoind names an out-of-range value first (`vout-negative`, `vout-toolarge`); the
    // total counts only when every value is in range.
    for (const values of [[-1n, MAX_MONEY, 2n], [MAX_MONEY + 1n]]) {
      expect(claim('bad-txns-txouttotal-toolarge', tx({ values }))).toEqual(CLAIMED);
    }
    // bitcoind's null outpoint is the zero txid AND vout 0xffffffff.
    const zero = { txid: '00'.repeat(32), vout: 0 };
    expect(claim('bad-txns-prevout-null', tx({ inputs: [A, zero] }))).toEqual(CLAIMED);
    expect(claim('coinbase', tx({ inputs: [zero] }))).toEqual(CLAIMED);
    // A null outpoint beside another is prevout-null; a coinbase is not.
    expect(claim('bad-txns-prevout-null', tx({ inputs: [NULL, NULL] }))).toEqual(
      CONSENSUS,
    );
  });

  it('keeps a decode failure only for bytes that do not decode', () => {
    const message = 'TX decode failed. Make sure the tx has at least one input.';
    expect(claim(message, undefined, -22)).toEqual({
      kind: 'rejected',
      reason: 'the transaction does not decode',
    });
    expect(claim(message, tx(), -22)).toEqual(CLAIMED);
  });

  it('never keeps a reason that depends on the spent outputs', () => {
    const bad = tx({ inputs: [], values: [] });
    for (const reason of [
      'bad-txns-in-belowout, value in (0.001) < value out (0.002)',
      'bad-txns-inputvalues-outofrange',
      'bad-txns-fee-outofrange',
      'mandatory-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation)',
      'block-script-verify-flag-failed (Script evaluated without error but finished with a false/empty top stack element)',
    ]) {
      expect(classifyBroadcast({ code: -26, message: reason }).kind).toBe('rejected');
      expect(claim(reason, tx())).toEqual(CLAIMED);
      expect(claim(reason, bad)).toEqual(CLAIMED);
      expect(claim(reason, undefined)).toEqual(CLAIMED);
    }
  });

  it('leaves every answer that is not a rejection as the classifier gives it', () => {
    for (const [code, message] of [
      [-26, 'min relay fee not met, 100 < 141'],
      [-25, 'bad-txns-inputs-missingorspent'],
      [-27, 'Transaction outputs already in utxo set'],
      [-26, 'dust'],
      [-25, 'bad-txns-vin-empty'],
    ] as const) {
      const error = { code, message };
      expect(classifyOwnBroadcast(error, tx({ inputs: [] }))).toEqual(
        classifyBroadcast(error),
      );
    }
  });
});
