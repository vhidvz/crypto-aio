import {
  decodeTransaction,
  isVote,
  parseTransaction,
  tokenTransfersLanded,
  touches,
} from '../../../src/adapters/solana/decode';
import { DEVNET_TRANSFER_CHECKED } from './support/fixtures';

const SYSTEM = '11111111111111111111111111111111';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const PLACE = { height: 10n, hash: 'Hash1111111111111111111111111111111111111111' };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type Json = Record<string, unknown>;

/** A payer A sending 1,000 lamports to B, as `jsonParsed` shows it. */
function nativeTx(meta: Json = {}, instructions?: unknown[]): Json {
  return {
    slot: 7,
    blockTime: 1_700_000_000,
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [100_000, 0, 1],
      postBalances: [94_000, 1_000, 1],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
      ...meta,
    },
    transaction: {
      signatures: ['Sig1'],
      message: {
        accountKeys: [
          { pubkey: 'A', signer: true, writable: true },
          { pubkey: 'B', signer: false, writable: true },
          { pubkey: SYSTEM, signer: false, writable: false },
        ],
        instructions: instructions ?? [
          {
            program: 'system',
            programId: SYSTEM,
            parsed: {
              type: 'transfer',
              info: { source: 'A', destination: 'B', lamports: 1_000 },
            },
          },
        ],
      },
    },
    version: 'legacy',
  };
}

describe('Solana transaction decoding', () => {
  it('decodes a real devnet SPL transfer, with owners and the memo, as complete', () => {
    const parsed = parseTransaction(DEVNET_TRANSFER_CHECKED);
    const decoded = decodeTransaction(parsed, PLACE);
    expect(decoded).toEqual({
      id: '4DETGWWsC9zQ83YrU5EyYJmAgaug1dDas7cLWBVRBnvxxfo8Knfm4osJbmN4fXnrHZLFJmrPn8XbpcnTWWQsixv',
      observation: {
        seen: 'block',
        txHash:
          '4DETGWWsC9zQ83YrU5EyYJmAgaug1dDas7cLWBVRBnvxxfo8Knfm4osJbmN4fXnrHZLFJmrPn8XbpcnTWWQsixv',
        blockHeight: 10n,
        blockHash: PLACE.hash,
        success: true,
      },
      fee: [{ asset: 'native', amount: 10_001n }],
      transfers: [
        {
          locator: 'ix:2',
          from: ['8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT'],
          to: '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza',
          asset: {
            standard: 'spl',
            contract: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
          },
          amount: 1_000n,
          source: 'token-event',
          memo: '83c873a1f7d4c4bcfd6c095906248332',
        },
      ],
      decoding: 'complete',
      details: { slot: 504_092_431n, version: 0 },
    });
    expect(
      touches(decoded, parsed, new Set(['75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza'])),
    ).toBe(true);
    expect(
      touches(decoded, parsed, new Set(['DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3'])),
    ).toBe(false);
  });

  it('reports a failed transaction as the chain does: fee only, nothing moved (lesson 15)', () => {
    const failed = nativeTx({
      err: { InstructionError: [0, { Custom: 1 }] },
      postBalances: [95_000, 0, 1],
    });
    const decoded = decodeTransaction(parseTransaction(failed), PLACE);
    expect(decoded).toMatchObject({
      observation: { success: false, reason: 'transaction failed' },
      transfers: [],
      decoding: 'complete',
      details: { err: '{"InstructionError":[0,{"Custom":1}]}' },
    });
  });

  it('decodes inner system instructions and keeps them apart from outer ones', () => {
    const tx = nativeTx(
      {
        preBalances: [100_000, 0, 1, 1],
        postBalances: [93_000, 2_000, 1, 1],
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                program: 'system',
                programId: SYSTEM,
                parsed: {
                  type: 'createAccount',
                  info: {
                    source: 'A',
                    newAccount: 'B',
                    lamports: 2_000,
                    space: 0,
                    owner: SYSTEM,
                  },
                },
                stackHeight: 2,
              },
            ],
          },
        ],
      },
      [{ programId: 'Prog', accounts: ['A', 'B'], data: '3x' }],
    );
    (tx.transaction as { message: { accountKeys: unknown[] } }).message.accountKeys.push({
      pubkey: 'Prog',
    });
    const decoded = decodeTransaction(parseTransaction(tx), PLACE);
    expect(decoded.transfers).toEqual([
      {
        locator: 'ix:0.0',
        from: ['A'],
        to: 'B',
        asset: 'native',
        amount: 2_000n,
        source: 'internal',
      },
    ]);
    expect(decoded.decoding).toBe('complete');
  });

  it('marks value movement it cannot explain as partial', () => {
    // B gained 500 lamports more than any decoded instruction moved.
    expect(
      decodeTransaction(
        parseTransaction(nativeTx({ postBalances: [94_000, 1_500, 1] })),
        PLACE,
      ).decoding,
    ).toBe('partial');
    // A Token-2022 transfer is not decoded (spec §15), but its balances moved.
    const t22 = nativeTx(
      {
        preTokenBalances: [
          { accountIndex: 1, mint: 'M', owner: 'O', uiTokenAmount: { amount: '5' } },
        ],
        postTokenBalances: [
          { accountIndex: 1, mint: 'M', owner: 'O', uiTokenAmount: { amount: '4' } },
        ],
        postBalances: [95_000, 0, 1],
      },
      [
        {
          program: 'spl-token',
          programId: TOKEN_2022,
          parsed: {
            type: 'transferChecked',
            info: {
              source: 'B',
              destination: 'C',
              mint: 'M',
              authority: 'A',
              tokenAmount: { amount: '1' },
            },
          },
        },
      ],
    );
    const decoded = decodeTransaction(parseTransaction(t22), PLACE);
    expect([decoded.transfers, decoded.decoding]).toEqual([[], 'partial']);
  });

  it('falls back to token accounts when a node omits owners, as partial', () => {
    const tx = clone(DEVNET_TRANSFER_CHECKED) as unknown as {
      meta: { preTokenBalances: Json[]; postTokenBalances: Json[] };
    };
    for (const list of [tx.meta.preTokenBalances, tx.meta.postTokenBalances]) {
      for (const balance of list) delete balance.owner;
    }
    const decoded = decodeTransaction(parseTransaction(tx), PLACE);
    expect(decoded.transfers[0]).toMatchObject({
      from: ['8CvwyW7amb4MB547dqWh633vsKPTiQrmDsKxn3p2Jcn3'],
      to: 'DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3',
    });
    expect(decoded.decoding).toBe('partial');
  });

  it('attaches a memo only when the transaction has exactly one', () => {
    const memo = (text: string) => ({
      program: 'spl-memo',
      programId: MEMO,
      parsed: text,
    });
    const transfer = (nativeTx().transaction as { message: { instructions: unknown[] } })
      .message.instructions[0];
    const one = decodeTransaction(
      parseTransaction(nativeTx({}, [transfer, memo('deposit-1')])),
      PLACE,
    );
    expect(one.transfers[0]?.memo).toBe('deposit-1');
    const two = decodeTransaction(
      parseTransaction(nativeTx({}, [transfer, memo('a'), memo('b')])),
      PLACE,
    );
    expect(two.transfers[0]?.memo).toBeUndefined();
  });

  it('keeps lamports above 2^53 exact, as the transport revives them (P5-A)', () => {
    const big = 2n ** 60n;
    const tx = nativeTx(
      {
        preBalances: [big, 0, 1],
        postBalances: [big - 5_000n - 2n ** 54n - 1n, 2n ** 54n + 1n, 1],
      },
      [
        {
          program: 'system',
          programId: SYSTEM,
          parsed: {
            type: 'transfer',
            info: { source: 'A', destination: 'B', lamports: 2n ** 54n + 1n },
          },
        },
      ],
    );
    const decoded = decodeTransaction(parseTransaction(tx), PLACE);
    expect(decoded.transfers[0]?.amount).toBe(18_014_398_509_481_985n);
    expect(decoded.decoding).toBe('complete');
    // A rounded number means something ignored `exactIntegers`: refused, never guessed.
    expect(() => parseTransaction(nativeTx({ preBalances: [2 ** 60, 0, 1] }))).toThrow(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
    );
  });

  it('recognizes vote transactions and refuses malformed answers', () => {
    // A consensus vote moves nothing but its fee (a vote-program withdrawal is kept: below).
    const vote = nativeTx({ postBalances: [95_000, 0, 1] }, [
      {
        programId: 'Vote111111111111111111111111111111111111111',
        accounts: [],
        data: '1',
      },
    ]);
    expect(isVote(parseTransaction(vote))).toBe(true);
    expect(isVote(parseTransaction(nativeTx()))).toBe(false);
    for (const bad of [
      null,
      {},
      nativeTx({ preBalances: [1] }),
      nativeTx({ fee: -1 }),
      nativeTx({}, [{ parsed: {} }]),
    ]) {
      expect(() => parseTransaction(bad)).toThrow(
        expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
      );
    }
  });
});

describe('the scan filter is a superset (I4)', () => {
  it('keeps a deposit it cannot attribute, and drops an unrelated transaction', () => {
    // B gained lamports no decoded instruction explains (e.g. a closed token account).
    const unexplained = nativeTx({ postBalances: [94_000, 1_500, 1] });
    const parsed = parseTransaction(unexplained);
    const decoded = decodeTransaction(parsed, PLACE);
    expect(decoded.decoding).toBe('partial');
    expect(touches(decoded, parsed, new Set(['B']))).toBe(true);
    expect(touches(decoded, parsed, new Set(['Z']))).toBe(false);
    // A token balance with no owner reported changed: it cannot be attributed, so it stays.
    const ownerless = clone(DEVNET_TRANSFER_CHECKED) as unknown as {
      meta: { preTokenBalances: Json[]; postTokenBalances: Json[] };
    };
    for (const list of [
      ownerless.meta.preTokenBalances,
      ownerless.meta.postTokenBalances,
    ]) {
      for (const balance of list) delete balance.owner;
    }
    const noOwner = parseTransaction(ownerless);
    expect(touches(decodeTransaction(noOwner, PLACE), noOwner, new Set(['Z']))).toBe(
      true,
    );
  });

  it('keeps an SPL deposit when the node reports no token balances (R4)', () => {
    // The recipient's owner is not an account key: only the balances would name it.
    const recipient = '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza';
    const bare = clone(DEVNET_TRANSFER_CHECKED) as unknown as { meta: Json };
    delete bare.meta.preTokenBalances;
    delete bare.meta.postTokenBalances;
    const parsed = parseTransaction(bare);
    const decoded = decodeTransaction(parsed, PLACE);
    expect(parsed.keys).not.toContain(recipient);
    expect(decoded.decoding).toBe('partial');
    expect(touches(decoded, parsed, new Set([recipient]))).toBe(true);
    // With the balances reported, an unrelated watcher still sees nothing.
    const full = parseTransaction(DEVNET_TRANSFER_CHECKED);
    expect(touches(decodeTransaction(full, PLACE), full, new Set(['Z']))).toBe(false);
  });
});

describe('tokenTransfersLanded (lessons 7 and 15, the final wording; verdict paths only)', () => {
  const owner = '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT';
  type Fixture = {
    meta: {
      err: unknown;
      preTokenBalances?: unknown;
      postTokenBalances: { uiTokenAmount: { amount: string } }[];
    };
    transaction: { message: { instructions: Record<string, unknown>[] } };
  };
  const fixture = () => clone(DEVNET_TRANSFER_CHECKED) as unknown as Fixture;
  const landed = (tx: unknown, from = owner) =>
    tokenTransfersLanded(parseTransaction(tx), from);

  it('needs a transfer from the sender to the recipient of a positive amount, not the exact one', () => {
    expect(landed(DEVNET_TRANSFER_CHECKED)).toBe(true);
    // The recipient got less than the instruction said (a fee-on-transfer token): it moved.
    const less = fixture();
    less.meta.postTokenBalances[1]!.uiTokenAmount.amount = '372685001';
    expect(landed(less)).toBe(true);
    // The recipient got nothing: failed.
    const nothing = fixture();
    nothing.meta.postTokenBalances[1]!.uiTokenAmount.amount = '372685000';
    expect(landed(nothing)).toBe(false);
    // A failed transaction moved nothing.
    const failed = fixture();
    failed.meta.err = { InstructionError: [2, { Custom: 1 }] };
    expect(landed(failed)).toBe(false);
    // A native transfer: the chain's status is the verdict.
    expect(landed(nativeTx(), 'A')).toBe(true);
  });

  it('decides nothing on missing or contradictory evidence (lesson 18, widened)', () => {
    // Token instructions, none by the sender: the answer contradicts the signed message.
    expect(() => landed(DEVNET_TRANSFER_CHECKED, 'Someone')).toThrow(
      expect.objectContaining({ code: 'PROVIDER_INCONSISTENT', retryable: true }),
    );
    const noBalances = fixture();
    delete noBalances.meta.preTokenBalances;
    expect(() => landed(noBalances)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
    );
    const unparsed = fixture();
    const instruction = unparsed.transaction.message.instructions[2]!;
    delete instruction.parsed;
    instruction.data = '3ck7szVs';
    instruction.accounts = [];
    expect(() => landed(unparsed)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
    );
  });
});

// ---- Beyond the brief: verdict fields, lookups, lesson 20 caps, mint-aware balances ----

const VOTE = 'Vote111111111111111111111111111111111111111';
const OWNER = '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT';
const RECIPIENT = '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza';
const OTHER_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SIGNATURE = DEVNET_TRANSFER_CHECKED.transaction.signatures[0] as string;
const UNAVAILABLE = expect.objectContaining({
  code: 'PROVIDER_UNAVAILABLE',
  retryable: true,
});
const INCONSISTENT = expect.objectContaining({
  code: 'PROVIDER_INCONSISTENT',
  retryable: true,
});

type Balance = Json & { uiTokenAmount: Json };
type Devnet = {
  meta: Json & { preTokenBalances?: Balance[]; postTokenBalances?: Balance[] };
  transaction: {
    signatures: unknown[];
    message: Json & { accountKeys?: unknown[]; instructions?: Json[] };
  };
};

/** The devnet fixture, changed by `change`. */
function devnet(change: (tx: Devnet) => void = () => undefined): Devnet {
  const tx = clone(DEVNET_TRANSFER_CHECKED) as unknown as Devnet;
  change(tx);
  return tx;
}

/** Pads the transaction to `count` account keys (unfunded), keeping every key's place. */
function widen(tx: Devnet, count: number): void {
  const keys = tx.transaction.message.accountKeys!;
  const extra = count - keys.length;
  keys.push(...Array.from({ length: extra }, (_, i) => ({ pubkey: `Key${i}` })));
  for (const field of ['preBalances', 'postBalances']) {
    (tx.meta[field] as unknown[]).push(...Array<number>(extra).fill(0));
  }
}

const nested = (depth: number): unknown => {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
};

describe('a missing or ill-typed field is malformed, never a default (lesson 6, 20)', () => {
  const refused: [string, (tx: Devnet) => void][] = [
    ['no execution error (never read as success)', (tx) => delete tx.meta.err],
    ['an ill-typed execution error', (tx) => (tx.meta.err = 1)],
    [
      'an execution error nested past any real one',
      (tx) => (tx.meta.err = { InstructionError: nested(64) }),
    ],
    ['no signature', (tx) => (tx.transaction.signatures = [])],
    [
      'a signature longer than base58 of 64 bytes',
      (tx) => (tx.transaction.signatures[0] = '1'.repeat(89)),
    ],
    [
      'a 100,000-character signature',
      (tx) => (tx.transaction.signatures[0] = '1'.repeat(100_000)),
    ],
    [
      'no account keys (with no balances either)',
      (tx) => {
        delete tx.transaction.message.accountKeys;
        tx.meta.preBalances = [];
        tx.meta.postBalances = [];
      },
    ],
    ['more account keys than u8 indexes reach', (tx) => widen(tx, 257)],
    [
      'an account key listed twice',
      (tx) => (tx.transaction.message.accountKeys![7] = { pubkey: OWNER }),
    ],
    [
      'an account key longer than base58 of 32 bytes',
      (tx) => (tx.transaction.message.accountKeys![0] = { pubkey: '1'.repeat(45) }),
    ],
    [
      'no instruction list (never read as a native transfer)',
      (tx) => delete tx.transaction.message.instructions,
    ],
    ['ill-typed inner instructions', (tx) => (tx.meta.innerInstructions = 'none')],
    [
      'inner instructions of an outer instruction that does not exist',
      (tx) => (tx.meta.innerInstructions = [{ index: 4, instructions: [] }]),
    ],
    [
      'two inner instruction lists for one outer instruction',
      (tx) =>
        (tx.meta.innerInstructions = [
          { index: 0, instructions: [] },
          { index: 0, instructions: [] },
        ]),
    ],
    [
      'one token balance list without the other',
      (tx) => delete tx.meta.postTokenBalances,
    ],
    [
      'an ill-typed token balance list',
      (tx) => (tx.meta.preTokenBalances = 'none' as never),
    ],
    [
      'two token balances for one account',
      (tx) => tx.meta.postTokenBalances!.push(clone(tx.meta.postTokenBalances![0]!)),
    ],
    [
      'a token balance of an account that does not exist',
      (tx) => (tx.meta.postTokenBalances![0]!.accountIndex = 8),
    ],
    ['an ill-typed token owner', (tx) => (tx.meta.postTokenBalances![0]!.owner = 5)],
    [
      'a memo longer than a transaction',
      (tx) => (tx.transaction.message.instructions![3]!.parsed = 'm'.repeat(1_233)),
    ],
  ];
  it.each(refused)('refuses %s', (_, change) => {
    expect(() => parseTransaction(devnet(change))).toThrow(UNAVAILABLE);
  });

  it('accepts every answer at the format limits (lesson 19 boundaries)', () => {
    const widest = devnet((tx) => {
      widen(tx, 256);
      tx.transaction.message.accountKeys![255] = { pubkey: '1'.repeat(44) };
      tx.transaction.signatures[0] = '1'.repeat(88);
      tx.transaction.message.instructions![3]!.parsed = 'm'.repeat(1_232);
    });
    const parsed = parseTransaction(widest);
    expect([parsed.keys.length, parsed.signature.length]).toEqual([256, 88]);
    expect(decodeTransaction(parsed, PLACE).transfers[0]?.memo).toHaveLength(1_232);
    for (const err of [
      'AccountInUse',
      { InstructionError: [2, { Custom: 1 }] },
      { InstructionError: [0, { BorshIoError: 'Unknown' }] },
      { InsufficientFundsForRent: { account_index: 1 } },
    ]) {
      expect(parseTransaction(devnet((tx) => (tx.meta.err = err))).err).toEqual(err);
    }
  });

  it('binds a lookup to the signature asked for: another transaction decides nothing', () => {
    expect(parseTransaction(DEVNET_TRANSFER_CHECKED, SIGNATURE).signature).toBe(
      SIGNATURE,
    );
    // The second signer's signature is not the transaction's id.
    const second = DEVNET_TRANSFER_CHECKED.transaction.signatures[1] as string;
    expect(() => parseTransaction(DEVNET_TRANSFER_CHECKED, second)).toThrow(UNAVAILABLE);
  });
});

describe('reconciliation reads every account by index and mint (spec §15)', () => {
  it('is partial when a token account holds another mint afterwards', () => {
    const moved = devnet((tx) => (tx.meta.postTokenBalances![1]!.mint = OTHER_MINT));
    expect(decodeTransaction(parseTransaction(moved), PLACE).decoding).toBe('partial');
  });

  it('is partial when the node recorded no inner instructions', () => {
    for (const innerInstructions of [undefined, null]) {
      const tx = nativeTx({ innerInstructions });
      expect(decodeTransaction(parseTransaction(tx), PLACE).decoding).toBe('partial');
    }
  });

  it('is partial when the node reported no token balances and a token program ran', () => {
    const t22 = nativeTx(
      {
        preTokenBalances: undefined,
        postTokenBalances: undefined,
        postBalances: [95_000, 0, 1],
      },
      [{ programId: TOKEN_2022, accounts: [], data: '1' }],
    );
    expect(decodeTransaction(parseTransaction(t22), PLACE).decoding).toBe('partial');
  });
});

describe('scans skip only what cannot move value to a watched address (I4)', () => {
  it('keeps a vote-program transaction that moves lamports', () => {
    // A vote-account withdrawal paying B (the default balances move 1,000 lamports to B).
    const withdraw = parseTransaction(
      nativeTx({}, [{ programId: VOTE, accounts: [], data: '1' }]),
    );
    expect(isVote(withdraw)).toBe(false);
    expect(touches(decodeTransaction(withdraw, PLACE), withdraw, new Set(['B']))).toBe(
      true,
    );
  });

  it('keeps a token deposit made through another program the node did not record (R4)', () => {
    // Neither inner instructions nor token balances: only the keyed token program tells.
    const hidden = parseTransaction(
      devnet((tx) => {
        delete tx.meta.preTokenBalances;
        delete tx.meta.postTokenBalances;
        delete tx.meta.innerInstructions;
        tx.transaction.message.instructions![2] = {
          programId: 'Prog',
          accounts: [],
          data: '1',
        };
      }),
    );
    expect(touches(decodeTransaction(hidden, PLACE), hidden, new Set([RECIPIENT]))).toBe(
      true,
    );
  });
});

describe('the landing guard reads balances by account, mint and program (phantom success)', () => {
  const landed = (tx: unknown) => tokenTransfersLanded(parseTransaction(tx), OWNER);

  it('never reads a truncated answer as landed or failed', () => {
    expect(() => landed(devnet((tx) => delete tx.meta.err))).toThrow(UNAVAILABLE);
    expect(() =>
      landed(devnet((tx) => delete tx.transaction.message.instructions)),
    ).toThrow(UNAVAILABLE);
    // No owning program reported on the balances.
    const unowned = devnet((tx) => {
      for (const balance of [
        ...tx.meta.preTokenBalances!,
        ...tx.meta.postTokenBalances!,
      ]) {
        delete balance.programId;
      }
    });
    expect(() => landed(unowned)).toThrow(UNAVAILABLE);
    // The recipient's account shows no balance after the transfer.
    expect(() => landed(devnet((tx) => tx.meta.postTokenBalances!.splice(1, 1)))).toThrow(
      UNAVAILABLE,
    );
    // The sender's account showed no balance before it.
    expect(() => landed(devnet((tx) => tx.meta.preTokenBalances!.splice(0, 1)))).toThrow(
      UNAVAILABLE,
    );
  });

  it('decides nothing when the balances contradict the signed transfer', () => {
    // The recipient's account holds another mint.
    expect(() =>
      landed(devnet((tx) => (tx.meta.postTokenBalances![1]!.mint = OTHER_MINT))),
    ).toThrow(INCONSISTENT);
    // A Token-2022 account under the classic program's instruction.
    expect(() =>
      landed(devnet((tx) => (tx.meta.postTokenBalances![1]!.programId = TOKEN_2022))),
    ).toThrow(INCONSISTENT);
  });

  it('lands into an account the transaction created; a zero amount moved nothing', () => {
    const created = devnet((tx) => {
      tx.meta.preTokenBalances!.splice(1, 1);
      tx.meta.postTokenBalances![1]!.uiTokenAmount.amount = '1000';
    });
    expect(landed(created)).toBe(true);
    const zero = (balancesMoved: boolean) =>
      devnet((tx) => {
        const info = (tx.transaction.message.instructions![2]!.parsed as Json)
          .info as Json;
        (info.tokenAmount as Json).amount = '0';
        if (!balancesMoved) tx.meta.postTokenBalances = clone(tx.meta.preTokenBalances);
      });
    expect(landed(zero(false))).toBe(false);
    // Whatever the balances say, the signed record moved nothing.
    expect(landed(zero(true))).toBe(false);
  });
});
