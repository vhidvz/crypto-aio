import { classifyBroadcastError } from '../../../src/adapters/evm/errors';
import {
  feeDraft,
  feeOf,
  feesFromHistory,
  gasLimitFrom,
  legacyPrice,
  median,
  meetsBump,
  minimumBump,
  parseFeeOverride,
} from '../../../src/adapters/evm/fees';

const GWEI = 1_000_000_000n;
const history = {
  oldestBlock: 10n,
  baseFeePerGas: [5n * GWEI, 6n * GWEI, 7n * GWEI, 8n * GWEI],
  reward: [
    [1n * GWEI, 2n * GWEI, 9n * GWEI],
    [3n * GWEI, 4n * GWEI, 5n * GWEI],
    [0n, 1n * GWEI, 6n * GWEI],
  ],
  gasUsedRatio: [0.4, 0.5, 0.6],
};

describe('EVM fee policy', () => {
  it("takes the median of each speed's percentile and lets the next base fee double", () => {
    expect(median([3n, 1n, 2n])).toBe(2n);
    expect(median([4n, 1n, 3n, 2n])).toBe(2n);
    expect(median([])).toBe(0n);
    expect(feesFromHistory(history, 'slow', 0n)).toEqual({
      params: {
        type: 'eip1559',
        maxFeePerGas: 17n * GWEI,
        maxPriorityFeePerGas: 1n * GWEI,
      },
      baseFeePerGas: 8n * GWEI,
    });
    expect(feesFromHistory(history, 'fast', 0n).params).toMatchObject({
      maxPriorityFeePerGas: 6n * GWEI,
    });
    expect(feesFromHistory(history, 'normal', 25n * GWEI).params).toEqual({
      type: 'eip1559',
      maxFeePerGas: 41n * GWEI,
      maxPriorityFeePerGas: 25n * GWEI,
    });
    expect(legacyPrice(3n, 'normal')).toEqual({ type: 'legacy', gasPrice: 4n });
    expect(legacyPrice(100n, 'fast')).toEqual({ type: 'legacy', gasPrice: 125n });
  });

  it('refuses a fee history without a next base fee or with a short reward row (retryable)', () => {
    const malformed = expect.objectContaining({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      message: 'malformed fee history',
    });
    expect(() => feesFromHistory({ ...history, baseFeePerGas: [] }, 'slow', 0n)).toThrow(
      malformed,
    );
    const short = {
      ...history,
      reward: [...history.reward.slice(0, 2), [0n, 1n * GWEI]],
    };
    expect(() => feesFromHistory(short, 'fast', 0n)).toThrow(malformed);
    expect(() => feesFromHistory(short, 'slow', 0n)).toThrow(malformed);
  });

  it('keeps a plain transfer at 21000 gas and adds 20% headroom to anything else', () => {
    expect(gasLimitFrom(21_000n)).toBe(21_000n);
    expect(gasLimitFrom(51_000n)).toBe(61_200n);
    expect(gasLimitFrom(21_001n)).toBe(25_202n);
  });

  it('drafts an upper bound, or an expected cost when an L1 data fee is included', () => {
    const params = {
      type: 'eip1559',
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
    } as const;
    expect(feeDraft('fast', 21_000n, params, { baseFeePerGas: 5n })).toEqual({
      kind: 'evm-1559',
      speed: 'fast',
      charges: [{ asset: 'native', amount: 420_000n, label: 'network' }],
      bound: 'upper',
      details: {
        gasLimit: 21_000n,
        maxFeePerGas: 20n,
        maxPriorityFeePerGas: 2n,
        baseFeePerGas: 5n,
        expected: 147_000n,
      },
    });
    const legacy = feeDraft(
      'custom',
      30_000n,
      { type: 'legacy', gasPrice: 3n },
      { l1Fee: 11n },
    );
    expect(legacy).toMatchObject({
      kind: 'evm-legacy',
      bound: 'expected',
      details: { gasLimit: 30_000n, gasPrice: 3n, l1Fee: 11n, expected: 90_011n },
    });
    expect(legacy.charges).toEqual([
      { asset: 'native', amount: 90_000n, label: 'network' },
      { asset: 'native', amount: 11n, label: 'l1-data' },
    ]);
    expect(feeOf(legacy.details)).toEqual({
      gasLimit: 30_000n,
      params: { type: 'legacy', gasPrice: 3n },
    });
    expect(() => feeOf({ fee: 1n })).toThrow(
      expect.objectContaining({ code: 'INVALID_INTENT' }),
    );
  });

  it("accepts only overrides of the network's fee model", () => {
    expect(
      parseFeeOverride(
        { maxFeePerGas: 9n, maxPriorityFeePerGas: 0n, gasLimit: 50_000n },
        'evm-1559',
      ),
    ).toEqual({
      params: { type: 'eip1559', maxFeePerGas: 9n, maxPriorityFeePerGas: 0n },
      gasLimit: 50_000n,
    });
    expect(parseFeeOverride({ gasPrice: 7n }, 'evm-legacy')).toEqual({
      params: { type: 'legacy', gasPrice: 7n },
    });
    const bad = [
      [{ gasPrice: 7n }, 'evm-1559'],
      [{ maxFeePerGas: 9n, maxPriorityFeePerGas: 1n }, 'evm-legacy'],
      [{ maxFeePerGas: 9n, maxPriorityFeePerGas: 10n }, 'evm-1559'],
      [{ maxFeePerGas: 9, maxPriorityFeePerGas: 1n }, 'evm-1559'],
      [{ maxFee: 9n, maxPriorityFeePerGas: 1n }, 'evm-1559'],
      [{ gasPrice: 7n, gasLimit: 20_999n }, 'evm-legacy'],
      [{ gasPrice: 0n }, 'evm-legacy'],
      [{ maxFeePerGas: 9n, maxPriorityFeePerGas: -1n }, 'evm-1559'],
      [{ maxFeePerGas: 9n }, 'evm-1559'],
      [{ gasLimit: 50_000n }, 'evm-legacy'],
    ] as const;
    for (const [override, model] of bad) {
      expect(() => parseFeeOverride(override, model)).toThrow(
        expect.objectContaining({ code: 'INVALID_INTENT' }),
      );
    }
  });

  it('requires both the fee cap and the tip to rise by the bump, strictly (R48)', () => {
    const before = {
      type: 'eip1559',
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
    } as const;
    expect(
      meetsBump(
        before,
        { type: 'eip1559', maxFeePerGas: 110n, maxPriorityFeePerGas: 11n },
        10,
      ),
    ).toBe(true);
    expect(
      meetsBump(
        before,
        { type: 'eip1559', maxFeePerGas: 200n, maxPriorityFeePerGas: 10n },
        10,
      ),
    ).toBe(false);
    // Both prices strictly higher, but the cap 1 wei short of the 10% bump.
    expect(
      meetsBump(
        before,
        { type: 'eip1559', maxFeePerGas: 109n, maxPriorityFeePerGas: 11n },
        10,
      ),
    ).toBe(false);
    expect(meetsBump(before, { type: 'legacy', gasPrice: 999n }, 10)).toBe(false);
    expect(minimumBump(before, 10)).toEqual({
      type: 'eip1559',
      maxFeePerGas: 110n,
      maxPriorityFeePerGas: 11n,
    });
    expect(minimumBump({ type: 'legacy', gasPrice: 7n }, 10)).toEqual({
      type: 'legacy',
      gasPrice: 8n,
    });
    expect(
      meetsBump({ type: 'legacy', gasPrice: 7n }, { type: 'legacy', gasPrice: 8n }, 10),
    ).toBe(true);
    // geth: every price strictly higher, so a zero tip must still rise.
    const free = {
      type: 'eip1559',
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 0n,
    } as const;
    expect(minimumBump(free, 10)).toEqual({
      type: 'eip1559',
      maxFeePerGas: 110n,
      maxPriorityFeePerGas: 1n,
    });
    expect(meetsBump(free, { ...free, maxFeePerGas: 200n }, 10)).toBe(false);
    expect(meetsBump(free, minimumBump(free, 10), 10)).toBe(true);
    expect(minimumBump({ type: 'legacy', gasPrice: 0n }, 10)).toEqual({
      type: 'legacy',
      gasPrice: 1n,
    });
  });
});

describe('EVM broadcast classification', () => {
  it.each([
    ['already known', { kind: 'already-known' }],
    ['ALREADY_EXISTS: already known', { kind: 'already-known' }],
    [
      'nonce too low',
      { kind: 'refused', code: 'NONCE_CONFLICT', reason: 'nonce too low' },
    ],
    [
      'nonce too high',
      { kind: 'refused', code: 'NONCE_TOO_HIGH', reason: 'nonce too high' },
    ],
    [
      'replacement transaction underpriced',
      { kind: 'refused', code: 'FEE_TOO_LOW', reason: 'replacement underpriced' },
    ],
    [
      'transaction underpriced',
      { kind: 'refused', code: 'FEE_TOO_LOW', reason: 'fee too low' },
    ],
    [
      'max fee per gas less than block base fee: address 0xabc, maxFeePerGas: 1, baseFee: 2',
      { kind: 'refused', code: 'FEE_TOO_LOW', reason: 'fee too low' },
    ],
    [
      'insufficient funds for gas * price + value: address 0x2c7536E3605D9C16a7a3D7b1898e529396a65c23 have 1 want 2',
      { kind: 'refused', code: 'INSUFFICIENT_FUNDS', reason: 'insufficient funds' },
    ],
    [
      'txpool is full',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    ['invalid chain id for signer', { kind: 'rejected', reason: 'wrong chain id' }],
    ['invalid sender', { kind: 'rejected', reason: 'invalid signature' }],
    [
      'rlp: expected input list for types.LegacyTx',
      { kind: 'rejected', reason: 'malformed transaction' },
    ],
    [
      'invalid transaction: insufficient funds',
      { kind: 'refused', code: 'INSUFFICIENT_FUNDS', reason: 'insufficient funds' },
    ],
    ['transaction already in chain', { kind: 'already-known' }],
    [
      'exceeds block gas limit',
      {
        kind: 'refused',
        code: 'TX_REFUSED',
        reason: 'gas limit above the block gas limit',
      },
    ],
    // R64: only exact texts that are permanent for these bytes on every node are rejected.
    [
      'invalid sender: invalid chain id for signer',
      { kind: 'rejected', reason: 'wrong chain id' },
    ],
    ['invalid signature', { kind: 'rejected', reason: 'invalid signature' }],
    [
      'invalid transaction v, r, s values',
      { kind: 'rejected', reason: 'invalid signature' },
    ],
    [
      'typed transaction too short',
      { kind: 'rejected', reason: 'malformed transaction' },
    ],
    [
      'max priority fee per gas higher than max fee per gas: address 0x2c7536E3605D9C16a7a3D7b1898e529396a65c23, maxPriorityFeePerGas: 3, maxFeePerGas: 2',
      { kind: 'rejected', reason: 'priority fee above the fee cap' },
    ],
    [
      'invalid transaction: txpool is full',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    [
      'malformed request from proxy',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    [
      'failed to decode upstream response',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    [
      'signature service timed out',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    // R63: fork gating, a moving L1 cost and node policy can change for the same bytes.
    [
      'transaction type not supported',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'unsupported transaction type' },
    ],
    [
      'invalid sender: transaction type not supported',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'unsupported transaction type' },
    ],
    [
      'intrinsic gas too low: gas 21000, minimum needed 21600',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'gas limit below intrinsic gas' },
    ],
    [
      'only replay-protected (EIP-155) transactions allowed over RPC',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'replay protection required' },
    ],
    [
      'oversized data: transaction size 200000, limit 131072',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'transaction too large' },
    ],
  ])('%s', (message, expected) => {
    const result = classifyBroadcastError(message);
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toMatch(/0x[0-9a-fA-F]{6}/);
    // A caller cannot alter what later calls return.
    expect(Object.isFrozen(result)).toBe(true);
  });
});
