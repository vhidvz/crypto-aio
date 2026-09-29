import {
  classifyBroadcastError,
  classifyOwnBroadcast,
} from '../../../src/adapters/solana/errors';
import { MEMO_PROGRAM, systemTransfer } from '../../../src/adapters/solana/programs';
import { signedTransaction } from '../../../src/adapters/solana/wire';
import {
  MAX_PRICE_VARIANT,
  VARIANTS,
  computeUnitLimitFor,
  detailsOf,
  fallbackComputeUnitLimit,
  feeDraft,
  lamportsCharged,
  parseOverride,
  priceForSpeed,
  priorityFee,
  signedFee,
  speedPrice,
  variantCounter,
  variantOffsets,
} from '../../../src/adapters/solana/fees';
import {
  BROADCAST,
  MONITOR,
  PROOF,
  READ,
  amountString,
  blockHeader,
  call,
  contextValue,
  gone,
  inconsistent,
  isGone,
  isNotAvailable,
  isNotYet,
  isSkipped,
  malformed,
  notYet,
  quorumKeyFor,
  record,
  rpcCode,
  u64,
  undecided,
  withSignal,
} from '../../../src/adapters/solana/rpc';
import type { Transport } from '../../../src/core/transport/types';
import { ProviderError } from '../../../src/core/errors/error';
import { canonicalJson } from '../../../src/core/util/json';
import { codec } from './support/tx';
import {
  KEY_ADDRESS,
  MINT,
  RECIPIENT,
  RECIPIENT_KEY,
  compileLegacy,
  sign,
} from './support/vectors';

const rpcError = (code: number, message: string, ambiguous = false) =>
  new ProviderError('RPC_ERROR', `x failed: ${message}`, {
    details: { rpcCode: code, rpcMessage: message },
    ambiguous,
  });

describe('Solana answers', () => {
  it('reads u64 values exactly, and never a rounded JSON number', () => {
    expect(u64(0, 'x')).toBe(0n);
    expect(u64(Number.MAX_SAFE_INTEGER, 'x')).toBe(9_007_199_254_740_991n);
    expect(u64(18_446_744_073_709_551_615n, 'x')).toBe(2n ** 64n - 1n);
    // Every call parses with exactIntegers, so a rounded number is refused, never guessed.
    for (const bad of [2 ** 60, -1, 1.5, '5', null, 2n ** 64n, -1n]) {
      expect(() => u64(bad, 'x')).toThrow(
        expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
      );
    }
    expect(amountString('18446744073709551615', 'x')).toBe(2n ** 64n - 1n);
    for (const bad of ['18446744073709551616', '01', '-1', '1.0', 5]) {
      expect(() => amountString(bad, 'x')).toThrow(
        expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
      );
    }
    expect(contextValue({ context: { slot: 1 }, value: null }, 'x')).toBeNull();
    expect(() => contextValue({ value: 1 }, 'x')).toThrow(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
    );
    expect(() =>
      blockHeader({
        blockhash: 'a',
        previousBlockhash: 'b',
        parentSlot: 1,
        blockHeight: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }));
  });

  it('reads a JSON object as a record, and anything else as null', () => {
    const object = { a: 1 };
    expect(record(object)).toBe(object);
    for (const other of [null, undefined, [], [1], 'x', 5, 5n, true]) {
      expect(record(other)).toBeNull();
    }
  });

  it('treats only definitive "cannot show it" codes as not available, split by meaning (I3)', () => {
    for (const code of [-32001, -32004, -32007, -32009, -32011, -32014, -32016, -32019]) {
      expect(isNotAvailable(rpcError(code, 'x'))).toBe(true);
    }
    const kinds = (code: number) =>
      [isNotYet, isGone, isSkipped].map((is) => is(rpcError(code, 'x')));
    expect([-32004, -32014, -32016].map(kinds)).toEqual(
      Array(3).fill([true, false, false]),
    );
    expect([-32001, -32009, -32011, -32019].map(kinds)).toEqual(
      Array(4).fill([false, true, false]),
    );
    expect(kinds(-32007)).toEqual([false, false, true]);
    expect(isNotAvailable(rpcError(-32004, 'x', true))).toBe(false);
    expect(isNotAvailable(rpcError(-32002, 'x'))).toBe(false);
    expect(isNotAvailable(new ProviderError('PROVIDER_UNAVAILABLE', 'down'))).toBe(false);
    expect(rpcCode(rpcError(-32002, 'x', true))).toBeUndefined();
    expect(rpcCode(new Error('foreign'))).toBeUndefined();
  });
});

describe('call()', () => {
  it('parses every answer with exact integers and carries the caller tags (P5-A, lesson 17)', async () => {
    const seen: unknown[] = [];
    const transport = {
      rpc: (method: string, params: unknown, options: unknown) => {
        seen.push({ method, params, options });
        return Promise.resolve(null);
      },
    } as unknown as Transport;
    const key = (value: unknown) => value;
    await call(transport, 'getBlockHeight', [], MONITOR);
    await call(transport, 'getBlock', [1], PROOF);
    await call(transport, 'getBlockHeight', [], { ...PROOF, quorumKey: key });
    expect(seen).toEqual([
      {
        method: 'getBlockHeight',
        params: [],
        options: { purpose: 'monitor', retry: 'safe', exactIntegers: true },
      },
      {
        method: 'getBlock',
        params: [1],
        options: {
          purpose: 'proof',
          retry: 'safe',
          quorum: 'proof',
          quorumKey: expect.any(Function),
          exactIntegers: true,
        },
      },
      {
        method: 'getBlockHeight',
        params: [],
        options: {
          purpose: 'proof',
          retry: 'safe',
          quorum: 'proof',
          quorumKey: key,
          exactIntegers: true,
        },
      },
    ]);
  });
});

describe('transport helpers (F5-R3 M4)', () => {
  it('turns an RPC error into a retryable answer that decides nothing and keeps its evidence (lesson 18)', () => {
    const cause = new ProviderError(
      'RPC_ERROR',
      'getBlocks failed: BigTable query failed',
      {
        details: { rpcCode: -32602, rpcMessage: 'BigTable query failed' },
        context: { chain: 'solana', method: 'getBlocks' },
      },
    );
    const error = undecided(cause, 'the blocks') as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(error.message).toBe(
      'the endpoints cannot show the blocks: BigTable query failed',
    );
    expect(error.cause).toBe(cause);
    expect(error.context).toEqual(cause.context);
    expect(error.details).toEqual(cause.details);
    const bare = undecided(new ProviderError('RPC_ERROR', 'x'), 'y') as ProviderError;
    expect(bare).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(bare.details).toBeUndefined();
    // Every other error, retryable or not, passes through as it is.
    for (const other of [
      new ProviderError('PROVIDER_UNAVAILABLE', 'down'),
      new ProviderError('PROVIDER_INCONSISTENT', 'split', { retryable: true }),
      new ProviderError('PROVIDER_MISCONFIGURED', 'another network'),
      new Error('foreign'),
      'text',
    ]) {
      expect(undecided(other, 'y')).toBe(other);
    }
  });

  it('makes every "decides nothing" error retryable, and none an RPC answer', () => {
    const made = [
      [gone('the block'), 'PROVIDER_UNAVAILABLE'],
      [notYet('the block'), 'PROVIDER_UNAVAILABLE'],
      [malformed('getBlock'), 'PROVIDER_UNAVAILABLE'],
      [inconsistent('the window'), 'PROVIDER_INCONSISTENT'],
    ] as const;
    for (const [error, code] of made) {
      expect(error).toMatchObject({ code, retryable: true });
      expect(isNotAvailable(error)).toBe(false);
    }
  });

  it('tags each purpose with its retry class, and adds a signal only when given one', () => {
    expect(READ).toEqual({ purpose: 'read', retry: 'safe' });
    expect(BROADCAST).toEqual({ purpose: 'broadcast', retry: 'ambiguous-on-failure' });
    for (const tags of [READ, MONITOR, PROOF, BROADCAST]) {
      expect(Object.isFrozen(tags)).toBe(true);
    }
    expect(withSignal(PROOF)).toBe(PROOF);
    const signal = new AbortController().signal;
    const tagged = withSignal(BROADCAST, signal);
    expect(tagged).toEqual({
      purpose: 'broadcast',
      retry: 'ambiguous-on-failure',
      signal,
    });
    expect(tagged.signal).toBe(signal);
    expect(BROADCAST).not.toHaveProperty('signal');
  });

  it('reads a block header exactly, and drops a block time that is not a safe integer', () => {
    const block = {
      blockhash: 'h',
      previousBlockhash: 'p',
      parentSlot: 41,
      blockHeight: 2n ** 60n,
      blockTime: 1_790_000_000,
      rewards: [],
    };
    expect(blockHeader(block)).toStrictEqual({
      blockhash: 'h',
      previousBlockhash: 'p',
      parentSlot: 41n,
      blockHeight: 2n ** 60n,
      blockTime: 1_790_000_000,
    });
    for (const blockTime of [null, undefined, 1.5, 2 ** 60, 2n ** 60n, '1790000000']) {
      const header = blockHeader({ ...block, blockTime });
      expect(header).not.toHaveProperty('blockTime');
      expect(header.parentSlot).toBe(41n);
    }
  });
});

describe('quorum keys (lesson 2, Review Focus 2)', () => {
  const key = quorumKeyFor('getTransaction')!;
  /** A finalized transaction as two honest providers format it differently. */
  const base = (overrides: Record<string, unknown> = {}) => ({
    slot: 42,
    blockTime: 1_790_000_000,
    meta: {
      err: null,
      fee: 5000,
      computeUnitsConsumed: 1234,
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: 'M',
          owner: 'O',
          programId: 'T',
          uiTokenAmount: {
            amount: '10',
            decimals: 6,
            uiAmount: 0.00001,
            uiAmountString: '0.00001',
          },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: 'M',
          owner: 'O',
          programId: 'T',
          uiTokenAmount: {
            amount: '7',
            decimals: 6,
            uiAmount: 0.000007,
            uiAmountString: '0.000007',
          },
        },
      ],
      innerInstructions: [],
      logMessages: ['Program log: x'],
      ...overrides,
    },
    transaction: {
      signatures: ['S'],
      message: {
        accountKeys: [
          { pubkey: 'A', signer: true, writable: true, source: 'transaction' },
          { pubkey: 'B', signer: false, writable: true },
        ],
        instructions: [
          {
            program: 'spl-token',
            programId: 'T',
            parsed: {
              type: 'transferChecked',
              info: {
                source: 'B',
                destination: 'C',
                authority: 'A',
                mint: 'M',
                tokenAmount: { amount: '3', decimals: 6, uiAmount: 0.000003 },
              },
            },
            stackHeight: 1,
          },
        ],
      },
    },
    version: 'legacy',
  });

  it('ignores formatting that honest providers differ on', () => {
    const other = base({
      computeUnitsConsumed: undefined,
      costUnits: 99,
      logMessages: [],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: 'M',
          uiTokenAmount: { amount: '10', decimals: 6, uiAmount: null },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: 'M',
          uiTokenAmount: { amount: '7', decimals: 6, uiAmount: null },
        },
      ],
    });
    (other.transaction.message.instructions[0] as Record<string, unknown>).stackHeight =
      null;
    (other as Record<string, unknown>).blockTime = null;
    expect(canonicalJson(key(other))).toBe(canonicalJson(key(base())));
    // M7: another implementation may list token balances in another order.
    const second = { accountIndex: 0, mint: 'M', uiTokenAmount: { amount: '1' } };
    const ordered = base({
      postTokenBalances: [second, ...(base().meta.postTokenBalances as object[])],
    });
    const reordered = base({
      postTokenBalances: [...(base().meta.postTokenBalances as object[]), second],
    });
    expect(canonicalJson(key(reordered))).toBe(canonicalJson(key(ordered)));
  });

  it('disagrees on any fact a verdict reads', () => {
    const facts = canonicalJson(key(base()));
    const changed = [
      base({ err: { InstructionError: [0, { Custom: 1 }] } }),
      base({
        postTokenBalances: [
          { accountIndex: 1, mint: 'M', uiTokenAmount: { amount: '8' } },
        ],
      }),
      { ...base(), slot: 43 },
    ];
    for (const tx of changed) expect(canonicalJson(key(tx))).not.toBe(facts);
    expect(key(null)).toBeNull();
    expect(() => key(5)).toThrow();
    expect(
      canonicalJson(
        quorumKeyFor('getBlock')!({
          blockhash: 'h',
          previousBlockhash: 'p',
          parentSlot: 1,
          blockHeight: 2,
          blockTime: 9,
          rewards: [],
        }),
      ),
    ).toBe(
      canonicalJson({
        blockhash: 'h',
        previousBlockhash: 'p',
        parentSlot: 1,
        blockHeight: 2,
      }),
    );
    expect(quorumKeyFor('getBalance')).toBeUndefined();
  });
});

describe('the fee policy', () => {
  it('prices speeds by percentile of recent prioritization fees', () => {
    const recent = [0, 0, 10, 20, 30, 40, 50, 60].map((fee, slot) => ({
      prioritizationFee: fee,
      slot,
    }));
    expect(priceForSpeed(recent, 'slow')).toBe(0n);
    expect(priceForSpeed(recent, 'normal')).toBe(20n);
    expect(priceForSpeed(recent, 'fast')).toBe(40n);
    expect(priceForSpeed([], 'fast')).toBe(0n);
    // Exact integers (P5-A): a u64 price above 2^53 − 1 arrives as a bigint. The highest
    // accepted price leaves room for the largest price variant within the u64 range.
    const highest = priceForSpeed([{ prioritizationFee: 2n ** 64n - 1_000n }], 'fast');
    expect(highest).toBe(2n ** 64n - 1_000n);
    expect(highest + variantOffsets(VARIANTS - 1).price).toBe(2n ** 64n - 1n);
    for (const bad of [
      null,
      [{ prioritizationFee: -1 }],
      [{ prioritizationFee: 1.5 }],
      [{}],
      // Lesson 19: outside the u64 range is malformed, never a price to encode, and so is
      // a price the variant would push past it (F5-R3 M1).
      [{ prioritizationFee: 2n ** 64n - 999n }],
      [{ prioritizationFee: 2n ** 64n - 1n }],
      [{ prioritizationFee: 2n ** 64n }],
      [{ prioritizationFee: -1n }],
      [{ prioritizationFee: 2 ** 60 }],
    ]) {
      expect(() => priceForSpeed(bad, 'normal')).toThrow(
        expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
      );
    }
  });

  it('computes limits and priority fees in bigint, rounding the fee up', () => {
    expect(computeUnitLimitFor(10_000n)).toBe(13_000n);
    expect(computeUnitLimitFor(1_300_000n)).toBe(1_400_000n);
    expect(fallbackComputeUnitLimit(3)).toBe(600_000n);
    expect(fallbackComputeUnitLimit(8)).toBe(1_400_000n);
    expect(priorityFee(1n, 20_000n)).toBe(1n);
    expect(priorityFee(0n, 1_400_000n)).toBe(0n);
    expect(priorityFee(1_000_001n, 30_000n)).toBe(30_001n);
  });

  it('keeps build variants distinct and small', () => {
    const next = variantCounter(VARIANTS - 1);
    expect([next(), next(), next()]).toEqual([VARIANTS - 1, 0, 1]);
    expect(variantOffsets(0)).toEqual({ limit: 0n, price: 0n });
    expect(variantOffsets(VARIANTS - 1)).toEqual({ limit: 1_023n, price: 999n });
    const seen = new Set<string>();
    for (let v = 0; v < 5_000; v++) seen.add(canonicalJson(variantOffsets(v)));
    expect(seen.size).toBe(5_000);
  });

  it('accepts only a well-formed override', () => {
    expect(parseOverride({ computeUnitPrice: 5n })).toEqual({ computeUnitPrice: 5n });
    expect(parseOverride({ computeUnitPrice: 0n, computeUnitLimit: 1_400_000n })).toEqual(
      {
        computeUnitPrice: 0n,
        computeUnitLimit: 1_400_000n,
      },
    );
    for (const bad of [
      {},
      { computeUnitPrice: 5 },
      { computeUnitPrice: -1n },
      { computeUnitPrice: 2n ** 64n },
      { computeUnitPrice: 1n, computeUnitLimit: 0n },
      { computeUnitPrice: 1n, computeUnitLimit: 1_400_001n },
      { computeUnitPrice: 1n, gasPrice: 1n },
    ]) {
      expect(() => parseOverride(bad)).toThrow(
        expect.objectContaining({ code: 'INVALID_INTENT' }),
      );
    }
  });

  it('charges network, priority and rent, and bounds the estimate by the rent', () => {
    const details = {
      signatures: 1,
      baseFee: 5_000n,
      computeUnitLimit: 26_000n,
      computeUnitPrice: 1_000n,
      priorityFee: 26n,
      rent: 1_488_440n,
      createsRecipientAccount: true,
    };
    const draft = feeDraft('fast', details);
    expect(draft).toMatchObject({ kind: 'solana', speed: 'fast', bound: 'upper' });
    expect(draft.charges.map((c) => [c.label, c.amount])).toEqual([
      ['network', 5_000n],
      ['priority', 26n],
      ['rent', 1_488_440n],
    ]);
    const exact = feeDraft('custom', {
      ...details,
      rent: 0n,
      createsRecipientAccount: false,
    });
    expect([exact.bound, exact.charges.length]).toEqual(['exact', 2]);
    expect(detailsOf(draft)).toEqual(details);
    expect(() => detailsOf({ ...draft, kind: 'evm-1559' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INTENT' }),
    );
  });
});

describe('the price ceiling (F5-R9 (b))', () => {
  const MAX = 10_000_000n;

  it('clamps a speed below the bound less the largest variant, then adds the variant', () => {
    expect(MAX_PRICE_VARIANT).toBe(variantOffsets(VARIANTS - 1).price);
    expect(speedPrice(20n, 7n, MAX)).toBe(27n);
    expect(speedPrice(MAX - MAX_PRICE_VARIANT, 0n, MAX)).toBe(MAX - 999n);
    expect(speedPrice(MAX - MAX_PRICE_VARIANT + 1n, 0n, MAX)).toBe(MAX - 999n);
    // A lying node's u64-sized price: at most the bound, and the variant survives there.
    expect(speedPrice(2n ** 64n - 1_000n, 0n, MAX)).toBe(MAX - 999n);
    expect(speedPrice(2n ** 64n - 1_000n, 999n, MAX)).toBe(MAX);
    expect(speedPrice(2n ** 64n - 1_000n, 998n, MAX)).toBe(MAX - 1n);
    // The lowest bound leaves only the variant.
    expect(speedPrice(5n, 999n, 999n)).toBe(999n);
    expect(speedPrice(5n, 0n, 999n)).toBe(0n);
  });

  const details = {
    signatures: 1,
    baseFee: 5_000n,
    computeUnitLimit: 1_400_000n,
    computeUnitPrice: MAX,
    priorityFee: 14_000_000n,
    rent: 0n,
    createsRecipientAccount: false,
  };

  it('signs a fee only within the bound, the limit and its own priority fee', () => {
    expect(signedFee(feeDraft('fast', details), MAX)).toEqual(details);
    expect(
      signedFee(
        feeDraft('custom', {
          ...details,
          computeUnitLimit: 1n,
          computeUnitPrice: 0n,
          priorityFee: 0n,
        }),
        MAX,
      ),
    ).toMatchObject({ computeUnitLimit: 1n, computeUnitPrice: 0n });
    let caught: unknown;
    try {
      signedFee(
        feeDraft('fast', {
          ...details,
          computeUnitPrice: MAX + 1n,
          priorityFee: priorityFee(MAX + 1n, 1_400_000n),
        }),
        MAX,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'INVALID_INTENT',
      retryable: false,
      message: expect.stringContaining('maxComputeUnitPrice'),
      details: { required: '10000001', maxComputeUnitPrice: '10000000' },
    });
    for (const tampered of [
      { computeUnitLimit: 0n, priorityFee: 0n },
      { computeUnitLimit: 1_400_001n, priorityFee: priorityFee(MAX, 1_400_001n) },
      { computeUnitPrice: -1n, priorityFee: 0n },
      { priorityFee: 13_999_999n },
      { priorityFee: 14_000_001n },
    ]) {
      expect(() => signedFee(feeDraft('fast', { ...details, ...tampered }), MAX)).toThrow(
        expect.objectContaining({
          code: 'INVALID_INTENT',
          message: 'the fee estimate is not consistent with its own compute budget',
        }),
      );
    }
  });
});

describe('lamports charged (F5-R3 M4)', () => {
  it('adds up the charges of a draft, and only its charges', () => {
    const details = {
      signatures: 1,
      baseFee: 5_000n,
      computeUnitLimit: 26_000n,
      computeUnitPrice: 1_000n,
      priorityFee: 26n,
      rent: 1_488_440n,
      createsRecipientAccount: true,
    };
    const draft = feeDraft('fast', details);
    expect(lamportsCharged(draft)).toBe(1_493_466n);
    // Rent a draft does not charge is not counted.
    const noAccount = feeDraft('custom', { ...details, createsRecipientAccount: false });
    expect(lamportsCharged(noAccount)).toBe(5_026n);
    expect(lamportsCharged({ ...draft, charges: [] })).toBe(0n);
  });
});

describe('broadcast classification (lesson 3, R24)', () => {
  const pre = 'Transaction simulation failed: ';
  it.each([
    [
      -32002,
      `${pre}This transaction has already been processed`,
      { kind: 'already-known' },
    ],
    [
      -32002,
      `${pre}Transaction did not pass signature verification`,
      { kind: 'rejected', reason: 'invalid signature' },
    ],
    [
      -32003,
      'Transaction signature verification failure',
      { kind: 'rejected', reason: 'invalid signature' },
    ],
    [
      -32002,
      `${pre}Blockhash not found`,
      { kind: 'refused', code: 'TX_REFUSED', reason: 'blockhash not found' },
    ],
    [
      -32002,
      `${pre}Attempt to debit an account but found no record of a prior credit.`,
      { kind: 'refused', code: 'INSUFFICIENT_FUNDS', reason: 'insufficient funds' },
    ],
    [
      -32002,
      `${pre}Insufficient funds for fee`,
      {
        kind: 'refused',
        code: 'INSUFFICIENT_FUNDS',
        reason: 'insufficient funds for fee',
      },
    ],
    [
      -32002,
      `${pre}Transaction results in an account (1) with insufficient funds for rent`,
      {
        kind: 'refused',
        code: 'INSUFFICIENT_FUNDS',
        reason: 'insufficient funds for rent',
      },
    ],
    [
      -32002,
      `${pre}Error processing Instruction 3: custom program error: 0x1`,
      { kind: 'refused', code: 'INSUFFICIENT_FUNDS', reason: 'insufficient funds' },
    ],
    [
      -32002,
      `${pre}Error processing Instruction 2: insufficient funds for instruction`,
      { kind: 'refused', code: 'INSUFFICIENT_FUNDS', reason: 'insufficient funds' },
    ],
    // State, fork, version or node policy: refused, never rejected.
    [
      -32002,
      `${pre}Error processing Instruction 3: custom program error: 0x11`,
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    [
      -32002,
      `${pre}Transaction version is unsupported`,
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    [
      -32002,
      `${pre}Transaction failed to sanitize accounts offsets correctly`,
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    [
      -32602,
      'failed to deserialize solana_transaction::versioned::VersionedTransaction: io error',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    [
      -32005,
      'Node is behind by 42 slots',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    // A signature text under an unrelated code, or with a suffix, is not trusted.
    [
      -32602,
      `${pre}Transaction did not pass signature verification`,
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    [
      -32002,
      `${pre}Transaction did not pass signature verification (key 7xKX…)`,
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
  ])('%i %s', (code, message, expected) => {
    const result = classifyBroadcastError(code, message);
    expect(result).toEqual(expected);
    expect(Object.isFrozen(result)).toBe(true);
    if ('reason' in result)
      expect(result.reason).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,}/);
  });

  /** A preflight failure's `data` as the transport keeps it (`rpcData`: agave's order). */
  const simulation = (err: unknown, logs: readonly string[] = []) =>
    JSON.stringify({
      err,
      logs,
      accounts: null,
      unitsConsumed: 0,
      returnData: null,
      innerInstructions: null,
      replacementBlockhash: null,
    });
  const DEFAULT = { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' };
  const FUNDS = {
    kind: 'refused',
    code: 'INSUFFICIENT_FUNDS',
    reason: 'insufficient funds',
  };

  it('reads a preflight failure by its structured error before any text', () => {
    // A provider may reword the text; the code and the simulation's `err` still decide.
    const reworded = 'Transaction simulation failed: reworded';
    const table: readonly (readonly [unknown, object])[] = [
      ['AlreadyProcessed', { kind: 'already-known' }],
      [
        'BlockhashNotFound',
        { kind: 'refused', code: 'TX_REFUSED', reason: 'blockhash not found' },
      ],
      ['AccountNotFound', FUNDS],
      ['InsufficientFundsForFee', { ...FUNDS, reason: 'insufficient funds for fee' }],
      [
        { InsufficientFundsForRent: { account_index: 1 } },
        { ...FUNDS, reason: 'insufficient funds for rent' },
      ],
      [{ InstructionError: [3, { Custom: 1 }] }, FUNDS],
      [{ InstructionError: [2, 'InsufficientFunds'] }, FUNDS],
      [{ InstructionError: [3, { Custom: 17 }] }, DEFAULT],
      ['AccountInUse', DEFAULT],
      // `rejected` is never read from data alone: it needs the anchored text too.
      ['SignatureFailure', DEFAULT],
    ];
    for (const [err, expected] of table) {
      for (const data of [simulation(err), JSON.parse(simulation(err)) as unknown]) {
        const result = classifyBroadcastError(-32002, reworded, data);
        expect(result).toEqual(expected);
        expect(Object.isFrozen(result)).toBe(true);
      }
    }
    // A readable structured error decides over a text that says otherwise.
    const custom1 = `${pre}Error processing Instruction 3: custom program error: 0x1`;
    expect(
      classifyBroadcastError(
        -32002,
        custom1,
        simulation({ InstructionError: [3, { Custom: 17 }] }),
      ),
    ).toEqual(DEFAULT);
    // The transport keeps 512 characters: an unreadable result falls back to the text,
    // even one that, read whole, would have said otherwise.
    const logs = Array<string>(20).fill(
      'Program 11111111111111111111111111111111 invoke [1]',
    );
    const cut = simulation({ InstructionError: [3, { Custom: 17 }] }, logs).slice(0, 512);
    expect(classifyBroadcastError(-32002, custom1, cut)).toEqual(FUNDS);
    // Only a preflight failure carries a simulation result.
    expect(
      classifyBroadcastError(-32602, reworded, simulation('AlreadyProcessed')),
    ).toEqual(DEFAULT);
  });

  it('rejects only when the anchored text and a readable structured error agree', () => {
    const text = `${pre}Transaction did not pass signature verification`;
    const invalid = { kind: 'rejected', reason: 'invalid signature' };
    expect(classifyBroadcastError(-32002, text, simulation('SignatureFailure'))).toEqual(
      invalid,
    );
    expect(classifyBroadcastError(-32002, text, simulation('BlockhashNotFound'))).toEqual(
      {
        kind: 'refused',
        code: 'TX_REFUSED',
        reason: 'blockhash not found',
      },
    );
    expect(classifyBroadcastError(-32002, text, simulation(null))).toEqual(DEFAULT);
    // Each signature text counts only under its own code.
    expect(classifyBroadcastError(-32003, text)).toEqual(DEFAULT);
    expect(
      classifyBroadcastError(-32002, 'Transaction signature verification failure'),
    ).toEqual(DEFAULT);
    // Unreadable data leaves the anchored text alone (the table above, with no data).
    expect(classifyBroadcastError(-32002, text, '{"err":"Signat')).toEqual(invalid);
    // "Already processed" is the one safe answer (the core keeps watching): either suffices.
    expect(
      classifyBroadcastError(
        -32002,
        `${pre}This transaction has already been processed`,
        simulation('BlockhashNotFound'),
      ),
    ).toEqual({ kind: 'already-known' });
  });
});

describe('lesson 21: a claimed signature failure stands only for our bytes (F5-R15)', () => {
  const pre = 'Transaction simulation failed: ';
  const data = (err: unknown) =>
    JSON.stringify({ err, logs: [], accounts: null, unitsConsumed: 0 });
  // Every way a node can claim it: the preflight's structured error (with or without its
  // text agreeing), the preflight's text alone, and -32003's text.
  const claims = [
    [
      'preflight data',
      -32002,
      `${pre}Transaction did not pass signature verification`,
      data('SignatureFailure'),
    ],
    [
      'preflight text',
      -32002,
      `${pre}Transaction did not pass signature verification`,
      undefined,
    ],
    [
      'verification text',
      -32003,
      'Transaction signature verification failure',
      undefined,
    ],
  ] as const;
  const INVALID = { kind: 'rejected', reason: 'invalid signature' };
  const CLAIMED = {
    kind: 'refused',
    code: 'TX_REFUSED',
    reason: 'the node claimed an invalid signature',
  };

  const one = codec.compileMessage(KEY_ADDRESS, MINT, [
    systemTransfer(KEY_ADDRESS, RECIPIENT, 1n),
  ]);
  // Two required signers: the fee payer, then the recipient (each signs its own transfer).
  const two = codec.compileMessage(KEY_ADDRESS, MINT, [
    systemTransfer(KEY_ADDRESS, MINT, 1n),
    systemTransfer(RECIPIENT, KEY_ADDRESS, 1n),
  ]);
  const flip = (bytes: Uint8Array, at: number) => {
    const out = bytes.slice();
    out[at] = (out[at] as number) ^ 1;
    return out;
  };
  const valid = signedTransaction([sign(one)], one);
  const both = signedTransaction([sign(two), sign(two, RECIPIENT_KEY)], two);
  const bad: readonly (readonly [string, Uint8Array])[] = [
    ['a flipped signature bit', flip(valid, 1 + 10)],
    ['a tampered message', flip(valid, valid.length - 1)],
    ['another key', signedTransaction([sign(one, RECIPIENT_KEY)], one)],
    [
      'signatures out of order',
      signedTransaction([sign(two, RECIPIENT_KEY), sign(two)], two),
    ],
    ['a bad second signature', signedTransaction([sign(two), sign(two)], two)],
    ['an all-zero signature', signedTransaction([new Uint8Array(64)], one)],
  ];

  it.each(claims)(
    'refuses a %s claim for bytes whose signatures all verify',
    (_, code, text, raw) => {
      for (const bytes of [valid, both]) {
        const result = classifyOwnBroadcast(bytes, code, text, raw);
        expect(result).toEqual(CLAIMED);
        expect(Object.isFrozen(result)).toBe(true);
        // The node at its word would have ended the Attempt.
        expect(classifyBroadcastError(code, text, raw)).toEqual(INVALID);
      }
    },
  );

  it.each(claims)(
    'keeps a %s rejection when our bytes carry a bad signature',
    (_, code, text, raw) => {
      for (const [, bytes] of bad) {
        expect(classifyOwnBroadcast(bytes, code, text, raw)).toEqual(INVALID);
      }
    },
  );

  it('cannot confirm a claim for bytes that do not read: refused, never a throw', () => {
    const [, code, text] = claims[2];
    const unreadable = [
      new Uint8Array(),
      Uint8Array.of(0),
      Uint8Array.of(1),
      valid.subarray(0, valid.length - 1),
      Uint8Array.from([...valid, 0]),
      // A count that the message's header does not require (one signature, two signers).
      signedTransaction([sign(two)], two),
      // Two signatures where the header requires one.
      signedTransaction([sign(one), sign(one)], one),
      // An aliased (non-canonical) signature count.
      Uint8Array.from([0x81, 0x00, ...valid.subarray(1)]),
      // Over the packet limit, never bytes we sent: refused before any signature is
      // checked (lesson 20), even well formed with a bad signature.
      signedTransaction(
        [new Uint8Array(64)],
        compileLegacy(KEY_ADDRESS, MINT, [
          { programId: MEMO_PROGRAM, accounts: [], data: new Uint8Array(1_300).fill(97) },
        ]),
      ),
      new Uint8Array(100_000).fill(1),
    ];
    for (const bytes of unreadable) {
      expect(classifyOwnBroadcast(bytes, code, text)).toEqual(CLAIMED);
    }
  });

  it('passes every other answer through as the node gave it', () => {
    const answers = [
      [-32002, `${pre}This transaction has already been processed`, undefined],
      [-32002, `${pre}Blockhash not found`, undefined],
      [-32002, 'reworded', data({ InstructionError: [2, { Custom: 1 }] })],
      [
        -32002,
        `${pre}Transaction did not pass signature verification`,
        data('BlockhashNotFound'),
      ],
      [-32003, `${pre}Transaction did not pass signature verification`, undefined],
      [-32005, 'Node is behind by 42 slots', undefined],
    ] as const;
    for (const [code, text, raw] of answers) {
      for (const bytes of [valid, flip(valid, 11), new Uint8Array()]) {
        expect(classifyOwnBroadcast(bytes, code, text, raw)).toEqual(
          classifyBroadcastError(code, text, raw),
        );
      }
    }
  });
});
