import {
  classifyBroadcast,
  classifyOwnBroadcast,
  txBytesOf,
} from '../../../src/adapters/tron/errors';
import {
  feeOverrideOf,
  feeSun,
  tronFee,
  type TronFeeInput,
} from '../../../src/adapters/tron/fees';
import {
  BROADCAST,
  READ,
  type BroadcastAnswer,
  type ChainParameters,
} from '../../../src/adapters/tron/http';
import type { TronRawData } from '../../../src/adapters/tron/types';
import { toHex, utf8ToBytes } from '../../../src/core/util/bytes';
import { nodeTransport } from './support/harness';
import { encodeWireRaw, encodeWireTransaction } from './support/node';
import { decodeTransaction, encodeRawData, encodeTransaction } from './support/protobuf';
import { signTxId, signedTransaction } from './support/signing';
import {
  KEY_ADDRESS,
  KEY_HEX,
  RECIPIENT,
  RECIPIENT_HEX,
  USDT,
  USDT_HEX,
} from './support/vectors';

const PARAMS: ChainParameters = {
  transactionFee: 1_000n,
  energyFee: 100n,
  createAccountFee: 100_000n,
  createNewAccountFeeInSystemContract: 1_000_000n,
  createNewAccountBandwidthRate: 1n,
  memoFee: 1_000_000n,
  maxFeeLimit: 15_000_000_000n,
};
const NONE = { activated: true, freeBandwidth: 0n, stakedBandwidth: 0n, energy: 0n };
const input = (extra: Partial<TronFeeInput> = {}): TronFeeInput => ({
  fee: 'normal',
  params: PARAMS,
  resources: NONE,
  bandwidth: 270n,
  activation: false,
  memo: false,
  marginPercent: 20,
  ...extra,
});
const labels = (fee: ReturnType<typeof tronFee>) =>
  Object.fromEntries(fee.charges.map((c) => [c.label, c.amount]));
const invalidIntent = (message: RegExp) =>
  expect.objectContaining({
    code: 'INVALID_INTENT',
    message: expect.stringMatching(message),
  });

describe('tronFee', () => {
  it('burns bandwidth only when neither staked nor free bandwidth covers it', () => {
    expect(labels(tronFee(input()))).toEqual({ bandwidth: 270_000n });
    expect(
      labels(tronFee(input({ resources: { ...NONE, freeBandwidth: 600n } }))),
    ).toEqual({
      bandwidth: 0n,
    });
    expect(
      labels(tronFee(input({ resources: { ...NONE, stakedBandwidth: 270n } }))),
    ).toEqual({
      bandwidth: 0n,
    });
    expect(tronFee(input())).toMatchObject({
      kind: 'tron',
      speed: 'normal',
      bound: 'upper',
      details: { bandwidth: 270n, bandwidthPrice: 1_000n, activation: false },
    });
  });

  it('charges account creation to an unactivated recipient; free bandwidth does not apply', () => {
    const fee = tronFee(
      input({ activation: true, resources: { ...NONE, freeBandwidth: 600n } }),
    );
    expect(labels(fee)).toEqual({ bandwidth: 100_000n, activation: 1_000_000n });
    const staked = tronFee(
      input({ activation: true, resources: { ...NONE, stakedBandwidth: 300n } }),
    );
    expect(labels(staked)).toEqual({ bandwidth: 0n, activation: 1_000_000n });
  });

  it('charges the memo fee', () => {
    expect(
      labels(tronFee(input({ memo: true, resources: { ...NONE, freeBandwidth: 600n } }))),
    ).toEqual({
      bandwidth: 0n,
      memo: 1_000_000n,
    });
  });

  it('sets the fee limit from the whole simulated energy plus the margin; stake lowers only the burn', () => {
    const fee = tronFee(
      input({ energy: 30_000n, resources: { ...NONE, freeBandwidth: 600n } }),
    );
    expect(fee.details).toMatchObject({
      energy: 36_000n,
      energyPrice: 100n,
      feeLimit: 3_600_000n,
    });
    expect(labels(fee)).toEqual({ bandwidth: 0n, energy: 3_600_000n });
    const staked = tronFee(
      input({
        energy: 30_000n,
        resources: { ...NONE, freeBandwidth: 600n, energy: 40_000n },
      }),
    );
    expect(staked.details).toMatchObject({ feeLimit: 3_600_000n });
    expect(labels(staked)).toEqual({ bandwidth: 0n, energy: 0n });
    expect(feeSun(staked)).toBe(0n);
  });

  it('honours a { feeLimit } override on TRC-20 only, never below the estimate', () => {
    const fee = tronFee(input({ energy: 30_000n, fee: { feeLimit: 5_000_000n } }));
    expect(fee).toMatchObject({ speed: 'custom', details: { feeLimit: 5_000_000n } });
    for (const [extra, message] of [
      [
        { energy: 30_000n, fee: { feeLimit: 3_000_000n } },
        /below the estimated energy cost/,
      ],
      [{ energy: 30_000n, fee: { feeLimit: 16_000_000_000n } }, /maximum fee limit/],
      [{ fee: { feeLimit: 5_000_000n } }, /TRC-20 transfers only/],
      [{ energy: 30_000n, fee: { feeLimit: 5 } }, /feeLimit: bigint/],
      [{ energy: 30_000n, fee: { gasPrice: 5n } }, /feeLimit: bigint/],
      [{ energy: 200_000_000n }, /maximum fee limit/],
    ] as const) {
      expect(() => tronFee(input(extra as Partial<TronFeeInput>))).toThrow(
        expect.objectContaining({
          code: 'INVALID_INTENT',
          message: expect.stringMatching(message),
        }),
      );
    }
  });

  it('charges only the energy that staked energy does not cover, under a speed or an override', () => {
    const partly = tronFee(
      input({ energy: 30_000n, resources: { ...NONE, energy: 10_000n } }),
    );
    expect(partly.details).toMatchObject({ feeLimit: 3_600_000n });
    expect(labels(partly).energy).toBe(2_600_000n);
    const override = tronFee(
      input({
        energy: 30_000n,
        fee: { feeLimit: 5_000_000n },
        resources: { ...NONE, energy: 40_000n },
      }),
    );
    expect(labels(override).energy).toBe(1_000_000n);
  });

  it('applies the new-account bandwidth rate to staked bandwidth', () => {
    const params = { ...PARAMS, createNewAccountBandwidthRate: 2n };
    const covered = tronFee(
      input({ params, activation: true, resources: { ...NONE, stakedBandwidth: 540n } }),
    );
    expect(labels(covered)).toEqual({ bandwidth: 0n, activation: 1_000_000n });
    const short = tronFee(
      input({ params, activation: true, resources: { ...NONE, stakedBandwidth: 539n } }),
    );
    expect(labels(short)).toEqual({ bandwidth: 100_000n, activation: 1_000_000n });
  });

  it('lists the charges in a fixed order, all in TRX', () => {
    const trc20 = tronFee(input({ energy: 1_000n, memo: true }));
    expect(trc20.charges.map((c) => c.label)).toEqual(['bandwidth', 'energy', 'memo']);
    const trx = tronFee(input({ activation: true, memo: true }));
    expect(trx.charges.map((c) => c.label)).toEqual(['bandwidth', 'activation', 'memo']);
    expect([...trc20.charges, ...trx.charges].every((c) => c.asset === 'native')).toBe(
      true,
    );
    expect(feeSun(trx)).toBe(100_000n + 1_000_000n + 1_000_000n);
  });

  it('keeps every amount exact in bigint sun and rounds energy up, never down', () => {
    const big = 2n ** 60n + 1n;
    expect(labels(tronFee(input({ bandwidth: big }))).bandwidth).toBe(big * 1_000n);
    expect(tronFee(input({ energy: 1n })).details).toMatchObject({
      energy: 2n,
      feeLimit: 200n,
    });
    expect(tronFee(input({ energy: 30_000n, marginPercent: 0 })).details).toMatchObject({
      energy: 30_000n,
    });
    expect(
      tronFee(input({ energy: 30_000n, marginPercent: 1_000 })).details,
    ).toMatchObject({
      energy: 330_000n,
    });
  });

  it('range-checks the fee limit at its boundaries, and never names the value (lesson 19)', () => {
    // 125,000,000 energy + 20% is exactly the network's maximum fee limit.
    expect(tronFee(input({ energy: 125_000_000n })).details).toMatchObject({
      feeLimit: 15_000_000_000n,
    });
    expect(() => tronFee(input({ energy: 125_000_001n }))).toThrow(
      invalidIntent(/maximum fee limit/),
    );
    const at = (feeLimit: bigint, params = PARAMS) =>
      tronFee(input({ energy: 30_000n, params, fee: { feeLimit } }));
    expect(at(15_000_000_000n).details).toMatchObject({ feeLimit: 15_000_000_000n });
    expect(at(3_600_000n).details).toMatchObject({ feeLimit: 3_600_000n });
    expect(() => at(3_599_999n)).toThrow(invalidIntent(/below the estimated/));
    let error: unknown;
    try {
      at(15_000_000_001n);
    } catch (caught) {
      error = caught;
    }
    expect(error).toEqual(invalidIntent(/maximum fee limit/));
    expect(String((error as Error).message)).not.toContain('15000000001');
    // A network maximum above what a transaction can carry (2^53 − 1, the codec's bound).
    const huge = { ...PARAMS, maxFeeLimit: 2n ** 64n };
    expect(at(2n ** 53n - 1n, huge).details).toMatchObject({ feeLimit: 2n ** 53n - 1n });
    expect(() => at(2n ** 53n, huge)).toThrow(invalidIntent(/maximum fee limit/));
    expect(() =>
      tronFee(input({ energy: 2n ** 53n, params: { ...huge, energyFee: 1n } })),
    ).toThrow(invalidIntent(/maximum fee limit/));
  });

  it('accepts a fee speed or exactly { feeLimit: bigint > 0 }; anything else is INVALID_INTENT', () => {
    expect(feeOverrideOf('normal')).toBeUndefined();
    expect(feeOverrideOf({ feeLimit: 1n })).toEqual({ feeLimit: 1n });
    for (const fee of [
      'turbo',
      null,
      [5n],
      {},
      { feeLimit: 0n },
      { feeLimit: -1n },
      { feeLimit: '5' },
      { feeLimit: 5n, gasPrice: 1n },
      { feeLimit: 5n, extra: undefined },
    ]) {
      expect(() => feeOverrideOf(fee as never)).toThrow(invalidIntent(/feeLimit|speed/));
      expect(() => tronFee(input({ energy: 30_000n, fee: fee as never }))).toThrow(
        expect.objectContaining({ code: 'INVALID_INTENT' }),
      );
    }
  });

  it('refuses an energy margin that is not a non-negative integer (CONFIG_INVALID)', () => {
    for (const marginPercent of [20.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => tronFee(input({ energy: 30_000n, marginPercent }))).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
  });

  it('refuses a TRC-20 estimate without positive energy, and any without positive bandwidth (F4-R9)', () => {
    // M4 (F4-R10): the energy is the node's simulation, so a non-positive one is a malformed
    // answer (retryable), never the caller's intent.
    for (const energy of [0n, -1n]) {
      for (const fee of ['normal', { feeLimit: 1_000_000n }] as const) {
        expect(() => tronFee(input({ energy, fee }))).toThrow(
          expect.objectContaining({
            code: 'PROVIDER_UNAVAILABLE',
            retryable: true,
            message: 'malformed energy used in a Tron answer',
          }),
        );
      }
    }
    // The bandwidth is the driver's own measure of the bytes it built: a non-positive one is a
    // driver bug, never the caller's intent nor a node's answer.
    for (const bandwidth of [0n, -1n]) {
      for (const energy of [undefined, 30_000n]) {
        let caught: unknown;
        try {
          tronFee(input({ bandwidth, ...(energy ? { energy } : {}) }));
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(RangeError);
        expect(caught).not.toHaveProperty('code');
        expect((caught as Error).message).toBe(
          'cannot estimate a Tron fee: the bandwidth must be positive',
        );
      }
    }
    // The smallest real values still estimate.
    expect(labels(tronFee(input({ bandwidth: 1n, energy: 1n })))).toEqual({
      bandwidth: 1_000n,
      energy: 200n,
    });
  });
});

const refused = (code: string, reason: string) => ({ kind: 'refused', code, reason });
const rejected = (reason: string) => ({ kind: 'rejected', reason });
const TXID = 'ab'.repeat(32);
const answer = (code: string, message?: string): BroadcastAnswer => ({
  accepted: false,
  code,
  ...(message !== undefined ? { message } : {}),
});
const possiblySent = expect.objectContaining({
  code: 'PROVIDER_UNAVAILABLE',
  retryable: true,
  ambiguous: true,
});
/** The classification, or the error it threw. */
function outcome(a: BroadcastAnswer): unknown {
  try {
    return classifyBroadcast(a);
  } catch (error) {
    return error;
  }
}

describe('classifyBroadcast', () => {
  it.each([
    [{ accepted: true }, { kind: 'accepted' }],
    [answer('DUP_TRANSACTION_ERROR', 'Dup transaction.'), { kind: 'already-known' }],
    // Wallet.broadcastTransaction's trxCacheEnable answer, before any validation.
    [
      answer('DUP_TRANSACTION_ERROR', 'Transaction already exists.'),
      { kind: 'already-known' },
    ],
    [
      answer('SIGERROR', 'Validate signature error: Signature size is 64'),
      rejected('malformed signature'),
    ],
    [
      answer(
        'SIGERROR',
        `Validate signature error: ${TXID} is signed by ${RECIPIENT} but it is not contained of permission.`,
      ),
      refused('TX_REFUSED', 'signature not accepted for this account'),
    ],
    [
      answer('CONTRACT_VALIDATE_ERROR', 'Contract validate error : No contract!'),
      rejected('no contract'),
    ],
    [
      answer(
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : Cannot transfer TRX to yourself.',
      ),
      rejected('transfer to self'),
    ],
    [
      answer(
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : Amount must be greater than 0.',
      ),
      rejected('non-positive amount'),
    ],
    [
      answer(
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : Validate TransferContract error, balance is not sufficient.',
      ),
      refused('INSUFFICIENT_FUNDS', 'insufficient balance'),
    ],
    [
      answer(
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : Validate InternalTransfer error, balance is not sufficient.',
      ),
      refused('INSUFFICIENT_FUNDS', 'insufficient balance'),
    ],
    // Verified (BandwidthProcessor.consume): a missing owner is refused before the contract.
    [
      answer(
        'CONTRACT_VALIDATE_ERROR',
        `Contract validate error : account [${KEY_ADDRESS}] does not exist`,
      ),
      refused('INSUFFICIENT_FUNDS', 'sender account not activated'),
    ],
    [
      answer(
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : Validate TransferContract error, no OwnerAccount.',
      ),
      refused('INSUFFICIENT_FUNDS', 'sender account not activated'),
    ],
    [
      answer(
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : feeLimit must be >= 0 and <= 15000000000',
      ),
      refused('TX_REFUSED', 'contract validation failed'),
    ],
    [
      answer(
        'TOO_BIG_TRANSACTION_ERROR',
        `Too big transaction with result, TxId ${TXID}, the size is 600000 bytes, maxTxSize 512000`,
      ),
      rejected('transaction too large'),
    ],
    [
      answer(
        'TOO_BIG_TRANSACTION_ERROR',
        `Too big transaction, TxId ${TXID}, the size is 600000 bytes, maxTxSize 512000`,
      ),
      rejected('transaction too large'),
    ],
    [
      answer(
        'TOO_BIG_TRANSACTION_ERROR',
        `Too big new account transaction, TxId ${TXID}, the size is 1200 bytes, maxTxSize 1000`,
      ),
      refused('TX_REFUSED', 'transaction refused'),
    ],
    [
      answer('TRANSACTION_EXPIRATION_ERROR', 'Transaction expired'),
      refused('TX_EXPIRED', 'transaction expired'),
    ],
    [
      answer('TAPOS_ERROR', 'Tapos check error.'),
      refused('TX_REFUSED', 'reference block not on the canonical chain'),
    ],
    [
      answer('BANDWITH_ERROR', 'Account resource insufficient error.'),
      refused('INSUFFICIENT_FUNDS', 'insufficient bandwidth or balance for fees'),
    ],
    [
      answer('CONTRACT_EXE_ERROR', 'Contract execute error : x'),
      refused('TX_REFUSED', 'contract execution failed'),
    ],
  ])('%j', (a, expected) => {
    const result = classifyBroadcast(a as BroadcastAnswer);
    expect(result).toEqual(expected);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('refuses every other verified java-tron text: account state, permissions and node policy can change', () => {
    const signature = refused('TX_REFUSED', 'signature not accepted for this account');
    const contract = refused('TX_REFUSED', 'contract validation failed');
    for (const [code, message, expected] of [
      ['SIGERROR', 'Validate signature error: miss sig or contract', signature],
      ['SIGERROR', 'Validate signature error: too many signatures', signature],
      ['SIGERROR', "Validate signature error: permission isn't exit", signature],
      [
        'SIGERROR',
        'Validate signature error: Signature count is 2 more than key counts of permission : 1',
        signature,
      ],
      ['SIGERROR', 'Validate signature error: sig error', signature],
      [
        'CONTRACT_VALIDATE_ERROR',
        `Contract validate error : tx ${TXID} contract size should be exactly 1, this is extend feature ,actual :2`,
        contract,
      ],
      [
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : No contract or not a smart contract',
        contract,
      ],
      [
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : Cannot transfer TRX to a smartContract.',
        contract,
      ],
      [
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : Invalid toAddress!',
        contract,
      ],
      [
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : Invalid ownerAddress!',
        contract,
      ],
      [
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : callValue must be >= 0',
        contract,
      ],
      [
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : tokenValue must be >= 0',
        contract,
      ],
      [
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : tokenId must be > 1000000',
        contract,
      ],
      [
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : invalid arguments with tokenValue = 5, tokenId = 0',
        contract,
      ],
      ['CONTRACT_VALIDATE_ERROR', 'Contract validate error : No asset !', contract],
      [
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : ExchangeTransactionContract is rejected',
        contract,
      ],
      ['CONTRACT_VALIDATE_ERROR', undefined, contract],
    ] as const) {
      const result = outcome(answer(code, message));
      expect(result).toEqual(expected);
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it('rejects a size text only when consensus refuses those bytes too', () => {
    const sig = (n: number) =>
      outcome(answer('SIGERROR', `Validate signature error: Signature size is ${n}`));
    // TransactionCapsule.checkWeight (consensus) refuses a signature under 65 bytes.
    expect(sig(0)).toEqual(rejected('malformed signature'));
    expect(sig(64)).toEqual(rejected('malformed signature'));
    // 65–68 pass admission, so the text contradicts itself; above 68 is an admission-only
    // rule (SignUtils.isValidLength), which consensus does not apply.
    for (const n of [65, 66, 68, 69, 100]) {
      expect(sig(n)).toEqual(
        refused('TX_REFUSED', 'signature not accepted for this account'),
      );
    }
    const size = (text: string, n: number, max = 512_000) =>
      outcome(
        answer(
          'TOO_BIG_TRANSACTION_ERROR',
          `${text}, TxId ${TXID}, the size is ${n} bytes, maxTxSize ${max}`,
        ),
      );
    const tooLarge = rejected('transaction too large');
    const other = refused('TX_REFUSED', 'transaction refused');
    // The plain check compares the whole transaction with 512,000 bytes in blocks too.
    expect(size('Too big transaction', 512_001)).toEqual(tooLarge);
    expect(size('Too big transaction', 512_000)).toEqual(other);
    // "with result" adds 128 bytes and applies in blocks only under a chain parameter.
    expect(size('Too big transaction with result', 512_129)).toEqual(tooLarge);
    expect(size('Too big transaction with result', 512_128)).toEqual(other);
    expect(size('Too big transaction with result', 600_000, 1_000)).toEqual(other);
    expect(size('Too big transaction', 600_000, 5_120_000)).toEqual(other);
  });

  it('gates every rejection on the code and the whole, exact text', () => {
    const permanent: readonly (readonly [string, string])[] = [
      ['SIGERROR', 'Validate signature error: Signature size is 64'],
      ['CONTRACT_VALIDATE_ERROR', 'Contract validate error : No contract!'],
      [
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : Cannot transfer TRX to yourself.',
      ],
      [
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : Amount must be greater than 0.',
      ],
      [
        'TOO_BIG_TRANSACTION_ERROR',
        `Too big transaction, TxId ${TXID}, the size is 600000 bytes, maxTxSize 512000`,
      ],
      [
        'TOO_BIG_TRANSACTION_ERROR',
        `Too big transaction with result, TxId ${TXID}, the size is 600000 bytes, maxTxSize 512000`,
      ],
    ];
    for (const [code, message] of permanent) {
      expect(outcome(answer(code, message))).toMatchObject({ kind: 'rejected' });
      for (const variant of [
        ...(code === 'TOO_BIG_TRANSACTION_ERROR'
          ? [
              answer(code, message.replace(TXID, TXID.toUpperCase())),
              answer(code, message.replace('600000', '0600000')),
            ]
          : []),
        answer(code, `${message} `),
        answer(code, `x${message}`),
        answer(code, message.toLowerCase()),
        answer(code),
        answer('CONTRACT_EXE_ERROR', message),
        answer(code === 'SIGERROR' ? 'CONTRACT_VALIDATE_ERROR' : 'SIGERROR', message),
      ]) {
        expect(outcome(variant)).toMatchObject({ kind: 'refused' });
      }
      for (const variant of [answer('OTHER_ERROR', message), answer('', message)]) {
        expect(outcome(variant)).toEqual(possiblySent);
      }
    }
  });

  it('treats node-local answers, including "P2P broadcast failed.", as possibly sent', () => {
    for (const code of [
      'SERVER_BUSY',
      'NO_CONNECTION',
      'NOT_ENOUGH_EFFECTIVE_CONNECTION',
      'BLOCK_UNSOLIDIFIED',
    ]) {
      expect(() =>
        classifyBroadcast({ accepted: false, code, message: 'P2P broadcast failed.' }),
      ).toThrow(
        expect.objectContaining({
          code: 'PROVIDER_UNAVAILABLE',
          retryable: true,
          ambiguous: true,
        }),
      );
    }
  });

  it('treats OTHER_ERROR, an empty or unknown code as possibly sent, repeating no node text', () => {
    for (const code of [
      'OTHER_ERROR',
      '',
      'SUCCESS',
      'SOMETHING_NEW',
      'sigerror',
      'constructor',
      '__proto__',
      `T${'x'.repeat(100_000)}`,
    ]) {
      const error = outcome({
        accepted: false,
        code,
        message: `TXyz ${RECIPIENT} 123 TRX`,
      });
      expect(error).toEqual(possiblySent);
      const text = JSON.stringify(error);
      expect(text).not.toContain(RECIPIENT);
      expect(text).not.toContain('TXyz');
    }
  });

  it('never repeats node text (R24): no address, amount or id in any result', () => {
    for (const a of [
      answer(
        'CONTRACT_VALIDATE_ERROR',
        `Contract validate error : account [${KEY_ADDRESS}] does not exist`,
      ),
      answer(
        'SIGERROR',
        `Validate signature error: ${TXID} is signed by ${RECIPIENT} but it is not contained of permission.`,
      ),
      answer(
        'TOO_BIG_TRANSACTION_ERROR',
        `Too big transaction, TxId ${TXID}, the size is 600000 bytes, maxTxSize 512000`,
      ),
      answer('CONTRACT_EXE_ERROR', `Contract execute error : ${RECIPIENT} 123456789`),
    ]) {
      const text = JSON.stringify(outcome(a));
      for (const secret of [KEY_ADDRESS, RECIPIENT, TXID, '600000', '123456789']) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('reads long adversarial messages as refusals (lesson 20: anchored, linear patterns)', () => {
    const long = 100_000;
    for (const [code, message] of [
      [
        'CONTRACT_VALIDATE_ERROR',
        `Contract validate error : account [${'T'.repeat(long)}`,
      ],
      [
        'CONTRACT_VALIDATE_ERROR',
        `Contract validate error : account [${'T'.repeat(long)}] does not exist`,
      ],
      ['SIGERROR', `Validate signature error: Signature size is ${'9'.repeat(long)}`],
      ['TOO_BIG_TRANSACTION_ERROR', `Too big transaction, TxId ${'a'.repeat(long)}`],
      [
        'TOO_BIG_TRANSACTION_ERROR',
        `Too big transaction, TxId ${TXID}, the size is ${'1'.repeat(long)} bytes, maxTxSize 512000`,
      ],
      [
        'CONTRACT_VALIDATE_ERROR',
        `Contract validate error : ${'No contract!'.repeat(long / 10)}`,
      ],
    ] as const) {
      expect(outcome(answer(code, message))).toMatchObject({ kind: 'refused' });
    }
  });
});

const TRX = 1_000_000n;
const word = (value: bigint): string => value.toString(16).padStart(64, '0');
const TRANSFER_DATA = `a9059cbb${word(BigInt(`0x${RECIPIENT_HEX.slice(2)}`))}${word(10n)}`;

/** A scripted java-tron node (its texts verified against v4.8.2.2) behind `TronApi`. */
function onNode() {
  const h = nodeTransport();
  const head = () => h.node.block(h.node.head) as { id: string; timestamp: number };
  const raw = (
    contract: TronRawData['contract'],
    extra: Partial<TronRawData> = {},
  ): TronRawData => ({
    refBlockBytes: head().id.slice(12, 16),
    refBlockHash: head().id.slice(16, 32),
    expiration: head().timestamp + 60_000,
    timestamp: head().timestamp,
    contract,
    ...extra,
  });
  const transfer = (amount: bigint, extra: Partial<TronRawData> = {}) =>
    raw({ type: 'TransferContract', owner: KEY_HEX, to: RECIPIENT_HEX, amount }, extra);
  const send = async (hex: string): Promise<unknown> => {
    try {
      return classifyBroadcast(await h.run(h.api.broadcastHex(hex, BROADCAST)));
    } catch (error) {
      return error;
    }
  };
  return { ...h, head, raw, transfer, send };
}

describe('classifyBroadcast on java-tron answers (scripted node)', () => {
  it('classifies each refusal the node gives with java-tron’s codes and texts', async () => {
    const { node, head, raw, transfer, send } = onNode();
    const sign = (r: TronRawData) => signedTransaction(r).hex;
    expect(await send(sign(transfer(1n)))).toEqual(
      refused('INSUFFICIENT_FUNDS', 'sender account not activated'),
    );
    node.fund(KEY_ADDRESS, TRX);
    node.fund(RECIPIENT, 1n);
    expect(await send(sign(transfer(5n * TRX)))).toEqual(
      refused('INSUFFICIENT_FUNDS', 'insufficient balance'),
    );
    expect(
      await send(
        sign(raw({ type: 'TransferContract', owner: KEY_HEX, to: KEY_HEX, amount: 1n })),
      ),
    ).toEqual(rejected('transfer to self'));
    expect(await send(sign(transfer(0n)))).toEqual(rejected('non-positive amount'));
    const rawHex = encodeRawData(transfer(1n));
    const { id } = signedTransaction(transfer(1n));
    expect(await send(encodeTransaction(rawHex, [signTxId(id).slice(0, 128)]))).toEqual(
      rejected('malformed signature'),
    );
    expect(await send(sign(transfer(1n, { refBlockHash: '00'.repeat(8) })))).toEqual(
      refused('TX_REFUSED', 'reference block not on the canonical chain'),
    );
    expect(await send(sign(transfer(1n, { expiration: head().timestamp })))).toEqual(
      refused('TX_EXPIRED', 'transaction expired'),
    );
    expect(await send(signedTransaction(transfer(1n), '22'.repeat(32)).hex)).toEqual(
      refused('TX_REFUSED', 'signature not accepted for this account'),
    );
    expect(
      await send(
        sign(
          raw(
            {
              type: 'TriggerSmartContract',
              owner: KEY_HEX,
              contract: RECIPIENT_HEX,
              data: TRANSFER_DATA,
            },
            { feeLimit: 1_000_000 },
          ),
        ),
      ),
    ).toEqual(refused('TX_REFUSED', 'contract validation failed'));
    const ok = sign(transfer(1n));
    expect(await send(ok)).toEqual({ kind: 'accepted' });
    expect(await send(ok)).toEqual({ kind: 'already-known' });
  });

  it('estimates what the node charges: account creation with a memo exactly, a TRC-20 call as an upper bound', async () => {
    const { node, run, api, raw, transfer, send } = onNode();
    node.fund(KEY_ADDRESS, 10n * TRX);
    const params = await run(api.chainParameters(READ));
    const resources = await run(api.resources(KEY_HEX, READ));
    const created = signedTransaction(transfer(2n * TRX, { data: '6869' }));
    const creation = tronFee({
      fee: 'normal',
      params,
      resources,
      bandwidth: BigInt(created.hex.length / 2 + 64),
      activation: !(await run(api.account(RECIPIENT_HEX, READ))).exists,
      memo: true,
      marginPercent: 20,
    });
    expect(await send(created.hex)).toEqual({ kind: 'accepted' });
    node.mine();
    expect((await run(api.transactionInfo('full', created.id, READ)))?.fee).toBe(
      feeSun(creation),
    );

    node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
    node.mintToken(USDT, KEY_ADDRESS, 50n);
    const call = await run(api.constantCall(KEY_HEX, USDT_HEX, TRANSFER_DATA, READ));
    if (call.kind !== 'ok') throw new Error('the node refused the simulation');
    const contract = {
      type: 'TriggerSmartContract',
      owner: KEY_HEX,
      contract: USDT_HEX,
      data: TRANSFER_DATA,
    } as const;
    const provisional = signedTransaction(
      raw(contract, { feeLimit: Number(params.maxFeeLimit) }),
    );
    const fee = tronFee({
      fee: 'normal',
      params,
      resources: await run(api.resources(KEY_HEX, READ)),
      bandwidth: BigInt(provisional.hex.length / 2 + 64),
      activation: false,
      memo: false,
      energy: call.energy,
      marginPercent: 20,
    });
    const feeLimit = fee.details.feeLimit as bigint;
    const sent = signedTransaction(raw(contract, { feeLimit: Number(feeLimit) }));
    expect(await send(sent.hex)).toEqual({ kind: 'accepted' });
    node.mine();
    const info = await run(api.transactionInfo('full', sent.id, READ));
    expect(info).toMatchObject({ receiptResult: 'SUCCESS', failed: false });
    expect(info?.fee).toBeGreaterThan(0n);
    expect(info?.fee).toBeLessThanOrEqual(feeSun(fee));
  });
});

/** Every java-tron answer the classifier reads as a definitive `rejected` (Task 5). */
const CLAIMS = {
  signature: answer('SIGERROR', 'Validate signature error: Signature size is 64'),
  noContract: answer('CONTRACT_VALIDATE_ERROR', 'Contract validate error : No contract!'),
  toSelf: answer(
    'CONTRACT_VALIDATE_ERROR',
    'Contract validate error : Cannot transfer TRX to yourself.',
  ),
  amount: answer(
    'CONTRACT_VALIDATE_ERROR',
    'Contract validate error : Amount must be greater than 0.',
  ),
  tooBig: answer(
    'TOO_BIG_TRANSACTION_ERROR',
    `Too big transaction, TxId ${TXID}, the size is 600000 bytes, maxTxSize 512000`,
  ),
  tooBigWithResult: answer(
    'TOO_BIG_TRANSACTION_ERROR',
    `Too big transaction with result, TxId ${TXID}, the size is 600000 bytes, maxTxSize 512000`,
  ),
} as const;
const UNCONFIRMED = refused('TX_REFUSED', 'the node claimed the transaction is invalid');

/** Signed bytes of a plain raw transfer (the test key, a fixed reference block). */
const BASE: TronRawData = {
  refBlockBytes: '4a2c',
  refBlockHash: '8d1c0e6f2a3b4c5d',
  expiration: 1_790_000_060_000,
  timestamp: 1_790_000_000_000,
  contract: { type: 'TransferContract', owner: KEY_HEX, to: RECIPIENT_HEX, amount: 1n },
};
const signedHex = (raw: Partial<TronRawData> = {}) =>
  signedTransaction({ ...BASE, ...raw }).hex;
const withContract = (
  contract: TronRawData['contract'],
  raw: Partial<TronRawData> = {},
) => signedHex({ ...raw, contract });
/** Protobuf by hand, for shapes no encoder writes: a varint, a varint field, a bytes field. */
function pbVarint(value: bigint): string {
  let v = value;
  let out = '';
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out += byte.toString(16).padStart(2, '0');
  } while (v > 0n);
  return out;
}
const pbInt = (field: number, value: bigint) =>
  `${pbVarint(BigInt(field << 3))}${pbVarint(value)}`;
const pbBytes = (field: number, hex: string) =>
  `${pbVarint(BigInt((field << 3) | 2))}${pbVarint(BigInt(hex.length / 2))}${hex}`;
const TRANSFER_URL = 'type.googleapis.com/protocol.TransferContract';
/** `Transaction.raw` with its reference fields and no contract at all. */
const NO_CONTRACT_RAW = pbBytes(1, '4a2c') + pbBytes(4, '8d1c0e6f2a3b4c5d');
/** A signed transaction whose one contract is written by hand: its type, `Any` URL and value. */
const handContract = (value: string, url = TRANSFER_URL, type = 1n) =>
  encodeTransaction(
    NO_CONTRACT_RAW +
      pbBytes(
        11,
        pbInt(1, type) +
          pbBytes(2, pbBytes(1, toHex(utf8ToBytes(url))) + pbBytes(2, value)),
      ),
    ['ab'.repeat(65)],
  );
/** A TransferContract's value from the test key to the recipient, with `amount` as written. */
const transferValue = (amount: string) =>
  pbBytes(1, KEY_HEX) + pbBytes(2, RECIPIENT_HEX) + amount;
const OURS = signedHex();
const TRIGGER = withContract(
  {
    type: 'TriggerSmartContract',
    owner: KEY_HEX,
    contract: USDT_HEX,
    data: TRANSFER_DATA,
  },
  { feeLimit: 30_000_000 },
);

/** The classification of `a` for the bytes `hex`, or the error it threw. */
function ownOutcome(a: BroadcastAnswer, hex: string): unknown {
  try {
    return classifyOwnBroadcast(a, txBytesOf(hex));
  } catch (error) {
    return error;
  }
}

describe('txBytesOf (lesson 21)', () => {
  it('reads what the byte-only checks need from the signed bytes, SDK-free', () => {
    expect(txBytesOf(OURS)).toEqual({
      size: OURS.length / 2,
      signatures: [65],
      contracts: 1,
      transfer: { owner: KEY_HEX, to: RECIPIENT_HEX, amount: 1n },
    });
    expect(txBytesOf(TRIGGER)).toEqual({
      size: TRIGGER.length / 2,
      signatures: [65],
      contracts: 1,
    });
    const rawHex = encodeRawData(BASE);
    const [signature] = decodeTransaction(OURS).signatures as [string];
    expect(txBytesOf(encodeTransaction(rawHex, [signature, signature]))).toMatchObject({
      signatures: [65, 65],
    });
    expect(txBytesOf(encodeTransaction(rawHex, []))).toMatchObject({ signatures: [] });
    expect(txBytesOf(encodeTransaction(NO_CONTRACT_RAW, [signature]))).toEqual({
      size: NO_CONTRACT_RAW.length / 2 + 2 + 2 + 65,
      signatures: [65],
      contracts: 0,
    });
    // Two contracts: java-tron refuses the count before any contract rule.
    const two = encodeWireRaw(BASE, { moreContracts: [BASE.contract] });
    expect(txBytesOf(encodeTransaction(two, [signature]))).toMatchObject({
      contracts: 2,
    });
    expect(txBytesOf(encodeTransaction(two, [signature]))?.transfer).toBeUndefined();
  });

  it('reads an int64 amount signed, a missing one as 0, and leaves `ret` out of the size', () => {
    const [signature] = decodeTransaction(OURS).signatures as [string];
    const amountOf = (amount: bigint) =>
      txBytesOf(
        encodeTransaction(
          encodeWireRaw({
            ...BASE,
            contract: { ...BASE.contract, amount },
          } as TronRawData),
          [signature],
        ),
      )?.transfer?.amount;
    expect(amountOf(0n)).toBe(0n);
    expect(amountOf(-5n)).toBe(-5n);
    expect(amountOf(-(2n ** 63n))).toBe(-(2n ** 63n));
    expect(amountOf(2n ** 63n - 1n)).toBe(2n ** 63n - 1n);
    // java-tron clears `ret` before it measures a broadcast transaction.
    const rawHex = encodeRawData(BASE);
    const withRet = encodeWireTransaction(
      rawHex,
      [signature],
      [{ fee: 1_000n, ret: 0, contractRet: 1 }],
    );
    expect(withRet.length).toBeGreaterThan(OURS.length);
    expect(txBytesOf(withRet)).toEqual(txBytesOf(OURS));
  });

  it('reads nothing it cannot read strictly: an unknown field, a repeated singular field, truncation', () => {
    for (const hex of [
      '',
      'zz',
      OURS.slice(0, -2),
      `${OURS}18`,
      // A second raw_data (field 1): which one a node reads is not ours to guess.
      `${OURS}${OURS.slice(0, OURS.length - 2 * 67)}`,
      // An unknown field of the Transaction (field 3, a varint).
      `${OURS}1801`,
      // A repeated `amount` in the TransferContract, and one over 64 bits.
      handContract(transferValue(pbInt(3, 1n) + pbInt(3, 2n))),
      handContract(transferValue(`18${'ff'.repeat(9)}02`)),
    ]) {
      expect(txBytesOf(hex)).toBeUndefined();
    }
  });

  it('reads no input longer than twice java-tron’s transaction limit (lesson 20)', () => {
    const memo = (bytes: number) => signedHex({ data: '61'.repeat(bytes) });
    expect(txBytesOf(memo(520_000))?.size).toBeGreaterThan(512_000);
    expect(txBytesOf(memo(1_100_000))).toBeUndefined();
  });
});

describe('classifyOwnBroadcast (lesson 21: a rejection is a claim)', () => {
  it.each([
    ['signature', encodeTransaction(encodeRawData(BASE), ['ab'.repeat(64)])],
    ['noContract', encodeTransaction(NO_CONTRACT_RAW, ['ab'.repeat(65)])],
    [
      'toSelf',
      withContract({ type: 'TransferContract', owner: KEY_HEX, to: KEY_HEX, amount: 1n }),
    ],
    ['amount', withContract({ ...BASE.contract, amount: 0n } as TronRawData['contract'])],
    ['tooBig', signedHex({ data: '61'.repeat(520_000) })],
    ['tooBigWithResult', signedHex({ data: '61'.repeat(520_000) })],
  ] as const)('keeps %s rejected when the reason holds for our bytes', (claim, hex) => {
    const expected = classifyBroadcast(CLAIMS[claim]);
    expect(expected).toMatchObject({ kind: 'rejected' });
    expect(ownOutcome(CLAIMS[claim], hex)).toEqual(expected);
  });

  it('keeps a negative amount rejected, as java-tron reads the int64', () => {
    const [signature] = decodeTransaction(OURS).signatures as [string];
    const negative = encodeTransaction(
      encodeWireRaw({
        ...BASE,
        contract: { ...BASE.contract, amount: -1n },
      } as TronRawData),
      [signature],
    );
    expect(ownOutcome(CLAIMS.amount, negative)).toEqual(rejected('non-positive amount'));
  });

  it.each(Object.keys(CLAIMS) as (keyof typeof CLAIMS)[])(
    'refuses %s, never rejects, when the reason does not hold for our bytes',
    (claim) => {
      for (const hex of [OURS, TRIGGER]) {
        const result = ownOutcome(CLAIMS[claim], hex);
        expect(result).toEqual(UNCONFIRMED);
        expect(Object.isFrozen(result)).toBe(true);
      }
    },
  );

  it('refuses a claim it cannot check against bytes it cannot read', () => {
    for (const claim of Object.values(CLAIMS)) {
      expect(classifyOwnBroadcast(claim, undefined)).toEqual(UNCONFIRMED);
    }
  });

  it('refuses a claim about another contract type: TRX rules never hold for a contract call', () => {
    const trigger = (owner: string) =>
      withContract(
        { type: 'TriggerSmartContract', owner, contract: USDT_HEX, data: TRANSFER_DATA },
        { feeLimit: 30_000_000 },
      );
    expect(ownOutcome(CLAIMS.toSelf, trigger(KEY_HEX))).toEqual(UNCONFIRMED);
    expect(ownOutcome(CLAIMS.amount, trigger(KEY_HEX))).toEqual(UNCONFIRMED);
    // java-tron unpacks the parameter as its URL names: a TransferContract under another
    // URL fails there with another text. The same bytes under the right URL are rejected.
    const trigger0 = handContract(
      transferValue(''),
      'type.googleapis.com/protocol.TriggerSmartContract',
    );
    expect(txBytesOf(trigger0)).toEqual({
      size: trigger0.length / 2,
      signatures: [65],
      contracts: 1,
    });
    expect(ownOutcome(CLAIMS.amount, trigger0)).toEqual(UNCONFIRMED);
    expect(ownOutcome(CLAIMS.amount, handContract(transferValue('')))).toEqual(
      rejected('non-positive amount'),
    );
    // Two contracts: the TRX rules apply only to a single TransferContract.
    const [signature] = decodeTransaction(OURS).signatures as [string];
    const two = encodeTransaction(
      encodeWireRaw(
        { ...BASE, contract: { ...BASE.contract, amount: 0n } } as TronRawData,
        { moreContracts: [BASE.contract] },
      ),
      [signature],
    );
    expect(ownOutcome(CLAIMS.amount, two)).toEqual(UNCONFIRMED);
  });

  it('leaves every other answer as the node gave it: state-dependent refusals, acceptance, possibly sent', () => {
    for (const a of [
      { accepted: true } as BroadcastAnswer,
      answer('DUP_TRANSACTION_ERROR', 'Dup transaction.'),
      answer('TRANSACTION_EXPIRATION_ERROR', 'Transaction expired'),
      answer('TAPOS_ERROR', 'Tapos check error.'),
      answer('BANDWITH_ERROR', 'Account resource insufficient error.'),
      answer(
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : Validate TransferContract error, balance is not sufficient.',
      ),
      answer(
        'CONTRACT_VALIDATE_ERROR',
        `Contract validate error : account [${KEY_ADDRESS}] does not exist`,
      ),
      answer(
        'CONTRACT_VALIDATE_ERROR',
        'Contract validate error : feeLimit must be >= 0 and <= 15000000000',
      ),
      answer(
        'SIGERROR',
        'Validate signature error: Signature count is 2 more than key counts of permission : 1',
      ),
      answer('SIGERROR', 'Validate signature error: Signature size is 66'),
    ]) {
      for (const hex of [
        OURS,
        encodeTransaction(encodeRawData(BASE), ['ab'.repeat(64)]),
      ]) {
        expect(ownOutcome(a, hex)).toEqual(outcome(a));
      }
    }
    for (const a of [answer('OTHER_ERROR', 'x'), answer('SERVER_BUSY'), answer('')]) {
      expect(ownOutcome(a, OURS)).toEqual(possiblySent);
    }
  });

  it('never repeats node text: the refusal is one fixed literal', () => {
    const long = answer(
      'CONTRACT_VALIDATE_ERROR',
      'Contract validate error : No contract!',
    );
    const result = ownOutcome(long, OURS) as { reason: string };
    expect(result.reason).toBe('the node claimed the transaction is invalid');
    expect(JSON.stringify(result)).not.toMatch(/contract|TxId|[0-9a-f]{64}/i);
  });
});
