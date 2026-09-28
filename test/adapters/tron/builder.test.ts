import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { encodeTransfer } from '../../../src/adapters/tron/abi';
import { toBase58Address } from '../../../src/adapters/tron/address';
import { bandwidthOf, createTronBuilder } from '../../../src/adapters/tron/builder';
import { tronwebCodec } from '../../../src/adapters/tron/codec';
import type { TronApi } from '../../../src/adapters/tron/http';
import { MAX_EXPIRATION_MS } from '../../../src/adapters/tron/network';
import type {
  TronCodec,
  TronExpiryOrdering,
  TronRawData,
} from '../../../src/adapters/tron/types';
import { ProviderError } from '../../../src/core/errors/error';
import type { FeeEstimateDraft } from '../../../src/core/model/fee';
import type { DriverIntent } from '../../../src/core/model/intent';
import type { OrderingData } from '../../../src/core/model/ordering';
import type { UnsignedTx } from '../../../src/core/model/transaction';
import * as bytes from '../../../src/core/util/bytes';
import { fromHex, toHex } from '../../../src/core/util/bytes';
import { hang, type FakeReply } from '../../../src/testing/fake-fetch';
import { tronHarness } from './support/context';
import { decodeRawData, decodeTransaction, encodeTransaction } from './support/protobuf';
import { signWithKey, signedTransaction } from './support/signing';
import {
  KEY_ADDRESS,
  KEY_HEX,
  RECIPIENT,
  RECIPIENT_HEX,
  USDT,
  USDT_HEX,
} from './support/vectors';

const TRX = 1_000_000n;
/** Every java-tron answer the classifier reads as a definitive `rejected` (Task 5). */
const CLAIMS = [
  ['SIGERROR', 'Validate signature error: Signature size is 64'],
  ['CONTRACT_VALIDATE_ERROR', 'Contract validate error : No contract!'],
  [
    'CONTRACT_VALIDATE_ERROR',
    'Contract validate error : Cannot transfer TRX to yourself.',
  ],
  ['CONTRACT_VALIDATE_ERROR', 'Contract validate error : Amount must be greater than 0.'],
  [
    'TOO_BIG_TRANSACTION_ERROR',
    `Too big transaction, TxId ${'ab'.repeat(32)}, the size is 600000 bytes, maxTxSize 512000`,
  ],
  [
    'TOO_BIG_TRANSACTION_ERROR',
    `Too big transaction with result, TxId ${'ab'.repeat(32)}, the size is 600000 bytes, maxTxSize 512000`,
  ],
] as const;
const TOKEN = { standard: 'trc20', contract: USDT } as const;
const OTHER_HEX = `41${'77'.repeat(20)}`;
const OTHER = toBase58Address(OTHER_HEX);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const trx = (amount: bigint, extra: Partial<DriverIntent> = {}): DriverIntent => ({
  asset: 'native',
  outputs: [{ to: RECIPIENT, amount }],
  from: KEY_ADDRESS,
  fee: 'normal',
  ...extra,
});
const token = (amount: bigint, extra: Partial<DriverIntent> = {}): DriverIntent =>
  trx(amount, { asset: TOKEN, ...extra });

function setup(options: Parameters<typeof tronHarness>[0] = {}) {
  const h = tronHarness(options);
  // Block 1: genesis serves no timestamp (proto3), so it is never a usable reference.
  h.node.mine();
  h.node.fund(KEY_ADDRESS, 100n * TRX);
  h.node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
  h.node.mintToken(USDT, KEY_ADDRESS, 1_000n);
  const { builder, broadcaster } = createTronBuilder(h.ctx);
  const build = { from: KEY_ADDRESS, keys: h.keys, wallet: {} };
  const prepared = async (intent: DriverIntent) => {
    const fee = await h.run(builder.estimateFee(intent, build));
    return h.run(builder.build(intent, fee, build));
  };
  const signed = async (intent: DriverIntent) => {
    const unsigned = await prepared(intent);
    return h.run(builder.assemble(unsigned, await signWithKey(unsigned)));
  };
  const head = () => h.node.block(h.node.head) as { id: string; timestamp: number };
  return { ...h, builder, broadcaster, build, prepared, signed, head };
}

const labels = (fee: { charges: readonly { label: string; amount: bigint }[] }) =>
  Object.fromEntries(fee.charges.map((c) => [c.label, c.amount]));
const callsTo = (h: { calls: readonly { path: string }[] }, path: string) =>
  h.calls.filter((c) => c.path === path).length;

describe('Tron builder: fees and funds', () => {
  it('charges account creation to an unactivated recipient, and the memo fee', async () => {
    const h = setup();
    const fee = await h.run(
      h.builder.estimateFee(trx(TRX, { memo: 'invoice 42' }), h.build),
    );
    expect(labels(fee)).toEqual({
      bandwidth: 100_000n,
      activation: 1_000_000n,
      memo: 1_000_000n,
    });
    h.node.fund(RECIPIENT, 1n);
    const again = await h.run(h.builder.estimateFee(trx(TRX), h.build));
    expect(labels(again)).toEqual({ bandwidth: 0n });
    expect(again).toMatchObject({
      kind: 'tron',
      bound: 'upper',
      details: { activation: false },
    });
  });

  it('sets a TRC-20 fee limit from the simulated energy plus the margin', async () => {
    const h = setup();
    const fee = await h.run(h.builder.estimateFee(token(10n), h.build));
    // (14,650 + 15,000 new-holder) × 1.2 = 35,580 energy at 100 sun
    expect(fee.details).toMatchObject({
      energy: 35_580n,
      feeLimit: 3_558_000n,
      energyPrice: 100n,
    });
    expect(labels(fee)).toEqual({ bandwidth: 0n, energy: 3_558_000n });
    h.node.stake(KEY_ADDRESS, { energy: 40_000n });
    expect(labels(await h.run(h.builder.estimateFee(token(10n), h.build)))).toEqual({
      bandwidth: 0n,
      energy: 0n,
    });
  });

  it('turns shortfalls into pre-signing failures before any simulation reverts', async () => {
    const h = setup();
    const before = callsTo(h, '/wallet/triggerconstantcontract');
    await expect(
      h.run(h.builder.estimateFee(token(5_000n), h.build)),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      details: { required: '5000', available: '1000' },
    });
    // Only balanceOf ran: the transfer was never simulated.
    expect(callsTo(h, '/wallet/triggerconstantcontract') - before).toBe(1);
    const fee = await h.run(h.builder.estimateFee(trx(TRX), h.build));
    expect(await h.run(h.builder.checkFunds(trx(200n * TRX), fee, h.build))).toEqual({
      ok: false,
      asset: 'native',
      required: 200n * TRX + 1_100_000n,
      available: 100n * TRX,
    });
    expect(await h.run(h.builder.checkFunds(trx(TRX), fee, h.build))).toEqual({
      ok: true,
    });
    const tokenFee = await h.run(h.builder.estimateFee(token(10n), h.build));
    expect(await h.run(h.builder.checkFunds(token(5_000n), tokenFee, h.build))).toEqual({
      ok: false,
      asset: TOKEN,
      required: 5_000n,
      available: 1_000n,
    });
  });

  it('refuses an unactivated sender before signing (it has no account and no free bandwidth)', async () => {
    const h = tronHarness();
    h.node.mine();
    const { builder } = createTronBuilder(h.ctx);
    h.node.deployToken(USDT, { symbol: 'USDT', decimals: 6 });
    h.node.mintToken(USDT, KEY_ADDRESS, 50n);
    const build = { from: KEY_ADDRESS, keys: h.keys, wallet: {} };
    const fee = await h.run(builder.estimateFee(token(10n), build));
    expect(labels(fee).bandwidth).toBeGreaterThan(0n);
    expect(await h.run(builder.checkFunds(token(10n), fee, build))).toMatchObject({
      ok: false,
      asset: 'native',
      available: 0n,
    });
    // Even with nothing to pay: java-tron refuses a sender account that does not exist.
    expect(
      await h.run(builder.checkFunds(token(10n), { ...fee, charges: [] }, build)),
    ).toEqual({ ok: false, asset: 'native', required: 0n, available: 0n });
  });

  it('calls a token that refuses a transfer its balance allows an invalid intent', async () => {
    const h = setup();
    const transfer = encodeTransfer(RECIPIENT, 10n);
    h.node.intercept('main', '/wallet/triggerconstantcontract', (request) =>
      request.json<{ data: string }>().data === transfer
        ? {
            json: {
              constant_result: [''],
              result: { result: true },
              energy_used: 900,
              transaction: { ret: [{ ret: 'FAILED' }] },
            },
          }
        : undefined,
    );
    await expect(h.run(h.builder.estimateFee(token(10n), h.build))).rejects.toMatchObject(
      { code: 'INVALID_INTENT' },
    );
  });

  it('decides nothing when the transfer simulation finds no contract its balance read found', async () => {
    const h = setup();
    const transfer = encodeTransfer(RECIPIENT, 10n);
    h.node.intercept('main', '/wallet/triggerconstantcontract', (request) =>
      request.json<{ data: string }>().data === transfer
        ? {
            json: {
              result: {
                code: 'CONTRACT_VALIDATE_ERROR',
                message: toHex(bytes.utf8ToBytes('Smart contract is not exist.')),
              },
            },
          }
        : undefined,
    );
    await expect(h.run(h.builder.estimateFee(token(10n), h.build))).rejects.toMatchObject(
      { code: 'PROVIDER_INCONSISTENT', retryable: true },
    );
  });

  it('keeps an estimate buildable when the network maximum fee limit exceeds 2^53 − 1', async () => {
    const h = setup({
      node: { params: { getMaxFeeLimit: 2n ** 60n } },
      driverOptions: { maxFeeLimit: MAX_SAFE },
    });
    const fee = await h.run(h.builder.estimateFee(token(10n), h.build));
    expect(fee.details).toMatchObject({ feeLimit: 3_558_000n });
    const unsigned = await h.run(h.builder.build(token(10n), fee, h.build));
    expect(decodeRawData(unsigned.payload.data).feeLimit).toBe(3_558_000);
    // Lesson 19 boundaries: 2^53 − 1 is written exactly; 2^53 goes through the codec's
    // safe() and is refused, never rounded (a config beyond what tronNetworkConfig accepts,
    // so only the codec can refuse it).
    const limit = (feeLimit: bigint) => ({
      ...fee,
      details: { ...fee.details, feeLimit },
    });
    const max = await h.run(h.builder.build(token(10n), limit(MAX_SAFE), h.build));
    expect(decodeRawData(max.payload.data).feeLimit).toBe(Number.MAX_SAFE_INTEGER);
    const unbounded = createTronBuilder({
      ...h.ctx,
      config: { ...h.ctx.config, maxFeeLimit: 2n ** 60n },
    });
    await expect(
      h.run(unbounded.builder.build(token(10n), limit(MAX_SAFE + 1n), h.build)),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message:
        'cannot encode a Tron transaction: fee_limit must be a safe non-negative integer',
    });
  });

  it('bounds the fee limit by maxFeeLimit (100 TRX by default), whatever one endpoint reports (F4-R28)', async () => {
    // One endpoint forges its maximum fee limit and inflates the energy price: 29,650 energy
    // at 10,000 sun is about 296 TRX, which an assert-style failure on chain would burn.
    const lying = { getMaxFeeLimit: 2n ** 60n, getEnergyFee: 10_000n };
    const h = setup({ node: { params: lying } });
    await expect(h.run(h.builder.estimateFee(token(10n), h.build))).rejects.toMatchObject(
      {
        code: 'INVALID_INTENT',
        message:
          'the transfer needs more energy than maxFeeLimit allows (a Tron handle option, in sun)',
        details: { required: '296500000', maxFeeLimit: '100000000' },
      },
    );
    // It inflates the simulated energy instead: the same bound holds.
    const inflated = setup({ node: { params: { getMaxFeeLimit: 2n ** 60n } } });
    const transfer = encodeTransfer(RECIPIENT, 10n);
    inflated.node.intercept('main', '/wallet/triggerconstantcontract', (request) =>
      request.json<{ data: string }>().data === transfer
        ? {
            json: {
              constant_result: ['00'.repeat(31) + '01'],
              result: { result: true },
              energy_used: 5_000_000,
              transaction: { ret: [{}] },
            },
          }
        : undefined,
    );
    await expect(
      inflated.run(inflated.builder.estimateFee(token(10n), inflated.build)),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      details: { maxFeeLimit: '100000000' },
    });
    // The operator may lift the bound: the fee limit is then the estimate, up to that bound.
    const lifted = setup({
      node: { params: lying },
      driverOptions: { maxFeeLimit: 400_000_000n },
    });
    const fee = await lifted.run(lifted.builder.estimateFee(token(10n), lifted.build));
    // (14,650 + 15,000 new-holder) × 1.2 = 35,580 energy at 10,000 sun.
    expect(fee.details).toMatchObject({ energy: 35_580n, feeLimit: 355_800_000n });
    // A bound between the need (296.5 TRX) and the margin caps the margin.
    const capped = setup({
      node: { params: lying },
      driverOptions: { maxFeeLimit: 300_000_000n },
    });
    const at = await capped.run(capped.builder.estimateFee(token(10n), capped.build));
    expect(at.details).toMatchObject({ feeLimit: 300_000_000n });
    const unsigned = await capped.run(capped.builder.build(token(10n), at, capped.build));
    expect(decodeRawData(unsigned.payload.data).feeLimit).toBe(300_000_000);
  });

  it('refuses before signing a fee limit above maxFeeLimit, wherever the estimate came from (F4-R28)', async () => {
    const h = setup();
    const fee = await h.run(h.builder.estimateFee(token(10n), h.build));
    const limit = (feeLimit: bigint) => ({
      ...fee,
      details: { ...fee.details, feeLimit },
    });
    const at = await h.run(h.builder.build(token(10n), limit(100_000_000n), h.build));
    expect(decodeRawData(at.payload.data).feeLimit).toBe(100_000_000);
    await expect(
      h.run(h.builder.build(token(10n), limit(100_000_001n), h.build)),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message:
        'the fee limit is above maxFeeLimit, the Tron handle option that bounds it (in sun)',
    });
  });

  it('refuses a single TRX transfer above 2^53 - 1 sun before any I/O (D20, lesson 19)', async () => {
    const h = setup();
    const huge = trx(MAX_SAFE + 1n);
    const before = h.calls.length;
    await expect(h.run(h.builder.estimateFee(huge, h.build))).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
      message: expect.not.stringMatching(/\d/),
    });
    const fee = await h.run(h.builder.estimateFee(trx(TRX), h.build));
    const after = h.calls.length;
    await expect(h.run(h.builder.build(huge, fee, h.build))).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
    await expect(h.run(h.builder.checkFunds(huge, fee, h.build))).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
    expect(h.calls.length).toBe(after);
    expect(after - before).toBeGreaterThan(0);
    // The largest encodable amount builds, exactly.
    h.node.fund(KEY_ADDRESS, MAX_SAFE);
    h.node.fund(RECIPIENT, 1n);
    const max = await h.prepared(trx(MAX_SAFE));
    expect(decodeRawData(max.payload.data).contract).toMatchObject({ amount: MAX_SAFE });
    // TRC-20 amounts are uint256: 2^256 is refused before any I/O.
    const calls = h.calls.length;
    await expect(
      h.run(h.builder.estimateFee(token(2n ** 256n), h.build)),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(h.calls.length).toBe(calls);
    await expect(
      h.run(h.builder.estimateFee(token(2n ** 256n - 1n), h.build)),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  it('validates the intent', async () => {
    const h = setup();
    for (const [intent, code] of [
      [
        trx(1n, {
          outputs: [
            { to: RECIPIENT, amount: 1n },
            { to: RECIPIENT, amount: 1n },
          ],
        }),
        'INVALID_INTENT',
      ],
      [trx(1n, { outputs: [] }), 'INVALID_INTENT'],
      [trx(1n, { memo: 'x'.repeat(257) }), 'INVALID_INTENT'],
      // 129 two-byte characters: 258 UTF-8 bytes.
      [trx(1n, { memo: 'é'.repeat(129) }), 'INVALID_INTENT'],
      [trx(1n, { memo: 'x'.repeat(100_000) }), 'INVALID_INTENT'],
      // A lone surrogate would be written as U+FFFD: another memo than the one given.
      [trx(1n, { memo: 'a\uD800b' }), 'INVALID_INTENT'],
      [trx(1n, { outputs: [{ to: KEY_ADDRESS, amount: 1n }] }), 'INVALID_INTENT'],
      // Self-transfer in any address form: java-tron refuses it on every node.
      [trx(1n, { outputs: [{ to: KEY_HEX, amount: 1n }] }), 'INVALID_INTENT'],
      [trx(0n), 'INVALID_AMOUNT'],
      [trx(-1n), 'INVALID_AMOUNT'],
      [token(0n), 'INVALID_AMOUNT'],
      [
        trx(1n, { outputs: [{ to: 'T'.repeat(100_000), amount: 1n }] }),
        'INVALID_ADDRESS',
      ],
      [trx(1n, { from: 'T'.repeat(100_000) }), 'INVALID_ADDRESS'],
      [
        trx(1n, { asset: { standard: 'erc20', contract: USDT } }),
        'UNSUPPORTED_CAPABILITY',
      ],
    ] as const) {
      const before = h.calls.length;
      await expect(h.run(h.builder.estimateFee(intent, h.build))).rejects.toMatchObject({
        code,
      });
      expect(h.calls.length).toBe(before);
    }
    // 128 two-byte characters (256 bytes) is the largest memo.
    await expect(
      h.run(h.builder.estimateFee(trx(1n, { memo: 'é'.repeat(128) }), h.build)),
    ).resolves.toMatchObject({ kind: 'tron' });
  });

  it('permits a TRC-20 transfer to the sender itself (the chain allows it)', async () => {
    const h = setup();
    const unsigned = await h.prepared(
      token(10n, { outputs: [{ to: KEY_ADDRESS, amount: 10n }] }),
    );
    expect(decodeRawData(unsigned.payload.data).contract).toMatchObject({
      data: encodeTransfer(KEY_ADDRESS, 10n),
    });
  });
});

describe('Tron builder: build and assemble', () => {
  it('builds raw data whose txID is the ref and the digest, with expiry ordering', async () => {
    const h = setup();
    const unsigned = await h.prepared(trx(TRX, { memo: 'hi' }));
    const txId = toHex(sha256(fromHex(unsigned.payload.data)));
    expect(unsigned.expectedRef).toEqual({
      id: txId,
      idKind: 'tx-hash',
      canonical: true,
    });
    expect(toHex(unsigned.signingRequests[0]?.payload ?? new Uint8Array())).toBe(txId);
    expect(unsigned.signingRequests[0]).toMatchObject({
      id: 'r0',
      scheme: 'secp256k1-ecdsa',
      payloadKind: 'digest',
    });
    const raw = decodeRawData(unsigned.payload.data);
    const head = h.head();
    expect(raw).toMatchObject({
      refBlockBytes: head.id.slice(12, 16),
      refBlockHash: head.id.slice(16, 32),
      data: '6869',
      contract: {
        type: 'TransferContract',
        owner: KEY_HEX,
        to: RECIPIENT_HEX,
        amount: TRX,
      },
    });
    expect(raw.expiration).toBeLessThanOrEqual(head.timestamp + 60_000);
    expect(raw.expiration).toBeGreaterThan(head.timestamp + 59_000);
    // F4-R12, F4-R14: the TaPoS bound of the reference block, whose height its id carries,
    // and the signed hash bytes of that block (`TronExpiryOrdering`).
    expect(unsigned.ordering).toEqual({
      kind: 'expiry',
      expiresAtMs: raw.expiration,
      lastValidHeight: BigInt(h.node.head) + 65_536n,
      refBlockHash: head.id.slice(16, 32),
    });
    expect(unsigned.summary).toEqual({
      asset: 'tron:nile/native',
      outputs: [{ to: RECIPIENT, amount: '1000000' }],
      memo: 'hi',
    });
    expect(bandwidthOf(unsigned.payload.data.length / 2)).toBeGreaterThan(200n);
  });

  it('gives two identical transfers different txIDs (D5)', async () => {
    const h = setup();
    const a = await h.prepared(trx(TRX));
    const b = await h.prepared(trx(TRX));
    expect(a.expectedRef?.id).not.toBe(b.expectedRef?.id);
    // Without any randomness, the per-driver timestamp still moves strictly up.
    const spy = jest.spyOn(bytes, 'randomBytes').mockReturnValue(new Uint8Array(2));
    try {
      const c = await h.prepared(trx(TRX));
      const d = await h.prepared(trx(TRX));
      expect(c.expectedRef?.id).not.toBe(d.expectedRef?.id);
      const [rc, rd] = [c, d].map((u) => decodeRawData(u.payload.data));
      expect(rd?.expiration).toBe(rc?.expiration);
      expect(rd?.timestamp).toBeGreaterThan(rc?.timestamp ?? Infinity);
    } finally {
      spy.mockRestore();
    }
  });

  it('puts the fee limit into TRC-20 raw data', async () => {
    const h = setup();
    const unsigned = await h.prepared(token(10n));
    expect(decodeRawData(unsigned.payload.data)).toMatchObject({
      feeLimit: 3_558_000,
      contract: { type: 'TriggerSmartContract', owner: KEY_HEX, contract: USDT_HEX },
    });
  });

  it('refuses a head block older than half the expiration window', async () => {
    const h = setup();
    const fee = await h.run(h.builder.estimateFee(trx(TRX), h.build));
    await h.clock.advance(31_000);
    await expect(h.run(h.builder.build(trx(TRX), fee, h.build))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('anchors the expiration at the local clock when the head is dated in the future (D3)', async () => {
    const h = setup();
    h.node.fund(RECIPIENT, 1n);
    const real = h.head();
    h.node.intercept('main', '/wallet/getblock', (request) =>
      request.json<{ id_or_num?: string }>().id_or_num === undefined
        ? {
            json: {
              blockID: real.id,
              block_header: {
                raw_data: {
                  number: h.node.head,
                  parentHash: '00'.repeat(32),
                  timestamp: real.timestamp + 3_600_000,
                },
              },
            },
          }
        : undefined,
    );
    const unsigned = await h.prepared(trx(TRX));
    const { expiration } = decodeRawData(unsigned.payload.data);
    const now = h.clock.now();
    // The negative proof scans back MAX_EXPIRATION_MS from the expiration: a future head must
    // not push the expiration past what that scan covers from the moment of the build.
    expect(expiration).toBeLessThanOrEqual(now + 60_000);
    expect(expiration).toBeGreaterThan(now + 59_000);
    const signed = await h.run(h.builder.assemble(unsigned, await signWithKey(unsigned)));
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({ kind: 'accepted' });
  });

  it('refuses an expiration window outside the driver bounds (D3, java-tron’s window)', async () => {
    const h = setup();
    const fee = await h.run(h.builder.estimateFee(trx(TRX), h.build));
    const wide = createTronBuilder({
      ...h.ctx,
      config: { ...h.ctx.config, expirationMs: MAX_EXPIRATION_MS + 2_000 },
    });
    await expect(h.run(wide.builder.build(trx(TRX), fee, h.build))).rejects.toMatchObject(
      { code: 'CONFIG_INVALID' },
    );
    // A fresh head, so only the window can refuse.
    await h.clock.advance(1_000);
    h.node.mine();
    const narrow = createTronBuilder({
      ...h.ctx,
      config: { ...h.ctx.config, expirationMs: 2_000 },
    });
    await expect(
      h.run(narrow.builder.build(trx(TRX), fee, h.build)),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('estimates exactly the bandwidth java-tron counts: the signed size without ret plus 64', async () => {
    const h = setup();
    h.node.fund(RECIPIENT, 1n);
    const fee = await h.run(h.builder.estimateFee(trx(TRX, { memo: 'hi' }), h.build));
    const unsigned = await h.run(h.builder.build(trx(TRX, { memo: 'hi' }), fee, h.build));
    const signed = await h.run(h.builder.assemble(unsigned, await signWithKey(unsigned)));
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({ kind: 'accepted' });
    h.node.mine();
    const counted = h.node.transaction(signed.ref.id)?.bytes;
    expect(bandwidthOf(unsigned.payload.data.length / 2)).toBe(counted);
    expect(fee.details.bandwidth).toBe(counted);
    // TRC-20: the estimate encodes the largest fee limit, so it bounds the real size.
    const tokenFee = await h.run(h.builder.estimateFee(token(10n), h.build));
    const call = await h.run(h.builder.build(token(10n), tokenFee, h.build));
    expect(bandwidthOf(call.payload.data.length / 2)).toBeLessThanOrEqual(
      tokenFee.details.bandwidth as bigint,
    );
  });

  it('refuses a fee that is not this transfer’s Tron estimate, before signing', async () => {
    const h = setup();
    const trxFee = await h.run(h.builder.estimateFee(trx(TRX), h.build));
    const tokenFee = await h.run(h.builder.estimateFee(token(10n), h.build));
    const withDetails = (fee: FeeEstimateDraft, details: Record<string, unknown>) => ({
      ...fee,
      details: { ...fee.details, ...details },
    });
    const notTron = /not a Tron estimate for this transfer/;
    for (const [intent, fee, message] of [
      [trx(TRX), { ...trxFee, kind: 'evm-1559' }, notTron],
      [token(10n), trxFee, notTron],
      [trx(TRX), tokenFee, notTron],
      [token(10n), withDetails(tokenFee, { feeLimit: 0n }), notTron],
      [token(10n), withDetails(tokenFee, { feeLimit: -1n }), notTron],
      [token(10n), withDetails(tokenFee, { feeLimit: 3_558_000 }), notTron],
      [trx(TRX), withDetails(trxFee, { bandwidth: undefined }), notTron],
      // Above the handle's bound (F4-R28), before the codec's safe() (pinned above).
      [
        token(10n),
        withDetails(tokenFee, { feeLimit: MAX_SAFE + 1n }),
        /above maxFeeLimit/,
      ],
      // Smaller than the transaction it would pay for.
      [trx(TRX), withDetails(trxFee, { bandwidth: 100n }), /does not cover/],
    ] as const) {
      await expect(
        h.run(h.builder.build(intent, fee as FeeEstimateDraft, h.build)),
      ).rejects.toMatchObject({
        code: 'INVALID_INTENT',
        message: expect.stringMatching(message),
      });
    }
  });

  it('signs only for the sender: the request carries the sending address’s key', async () => {
    const h = setup();
    const fee = await h.run(h.builder.estimateFee(trx(TRX), h.build));
    const foreign = {
      scheme: 'secp256k1-ecdsa',
      publicKey: secp256k1.getPublicKey('11'.repeat(32), true),
    };
    const both = { ...h.build, keys: [foreign, ...h.keys] };
    const unsigned = await h.run(h.builder.build(trx(TRX), fee, both));
    expect(unsigned.signingRequests[0]?.publicKey).toEqual(h.keys[0]?.publicKey);
    for (const keys of [
      [foreign],
      [],
      [{ scheme: 'ed25519', publicKey: new Uint8Array(32) }],
    ]) {
      await expect(
        h.run(h.builder.build(trx(TRX), fee, { ...h.build, keys })),
      ).rejects.toMatchObject({ code: 'SIGNER_UNAVAILABLE' });
    }
  });

  it('verifies before signing that the bytes carry the intent: owner, recipient, amount, token, memo, expiry, fee limit', async () => {
    const h = setup();
    const trxFee = await h.run(h.builder.estimateFee(trx(TRX, { memo: 'hi' }), h.build));
    const tokenFee = await h.run(h.builder.estimateFee(token(10n), h.build));
    const tampered = (change: (raw: TronRawData) => TronRawData): TronCodec => ({
      ...tronwebCodec,
      encodeRaw: (raw) => tronwebCodec.encodeRaw(change(raw)),
    });
    const withContract = (raw: TronRawData, c: Record<string, unknown>): TronRawData =>
      ({ ...raw, contract: { ...raw.contract, ...c } }) as TronRawData;
    const cases: readonly [DriverIntent, FeeEstimateDraft, TronCodec][] = [
      [
        trx(TRX, { memo: 'hi' }),
        trxFee,
        tampered((r) => withContract(r, { to: OTHER_HEX })),
      ],
      [
        trx(TRX, { memo: 'hi' }),
        trxFee,
        tampered((r) => withContract(r, { amount: 2n * TRX })),
      ],
      [
        trx(TRX, { memo: 'hi' }),
        trxFee,
        tampered((r) => withContract(r, { owner: OTHER_HEX })),
      ],
      [trx(TRX, { memo: 'hi' }), trxFee, tampered(({ data: _d, ...r }) => r)],
      [
        trx(TRX, { memo: 'hi' }),
        trxFee,
        tampered((r) => ({ ...r, expiration: r.expiration + 1 })),
      ],
      [
        token(10n),
        tokenFee,
        tampered((r) => withContract(r, { data: encodeTransfer(OTHER, 10n) })),
      ],
      [
        token(10n),
        tokenFee,
        tampered((r) => withContract(r, { data: encodeTransfer(RECIPIENT, 11n) })),
      ],
      [token(10n), tokenFee, tampered((r) => withContract(r, { contract: OTHER_HEX }))],
      // Only canonical transfer(to, amount) call data (Task 6's verdict relies on it).
      [
        token(10n),
        tokenFee,
        tampered((r) =>
          withContract(r, {
            data: `${encodeTransfer(RECIPIENT, 10n)}${'00'.repeat(32)}`,
          }),
        ),
      ],
      [
        token(10n),
        tokenFee,
        tampered((r) =>
          withContract(r, { data: `deadbeef${encodeTransfer(RECIPIENT, 10n).slice(8)}` }),
        ),
      ],
      [
        token(10n),
        tokenFee,
        tampered((r) =>
          withContract(r, {
            data: `a9059cbb${'ff'.repeat(12)}${RECIPIENT_HEX.slice(2)}${encodeTransfer(RECIPIENT, 10n).slice(72)}`,
          }),
        ),
      ],
      // A dropped fee limit would fail on chain (out of energy) and still pay.
      [token(10n), tokenFee, tampered(({ feeLimit: _f, ...r }) => r)],
    ];
    // A codec that reports a TRX value on the call (as `readRaw` does for chain calls).
    const valued: TronCodec = {
      ...tronwebCodec,
      decodeRaw: (hex) => {
        const raw = tronwebCodec.decodeRaw(hex);
        return { ...raw, contract: { ...raw.contract, callValue: 1n } } as TronRawData;
      },
    };
    const all: readonly [DriverIntent, FeeEstimateDraft, TronCodec][] = [
      ...cases,
      [token(10n), tokenFee, valued],
    ];
    for (const [intent, fee, codec] of all) {
      const { builder } = createTronBuilder({ ...h.ctx, codec });
      await expect(h.run(builder.build(intent, fee, h.build))).rejects.toMatchObject({
        code: 'INVALID_INTENT',
        message: expect.stringMatching(/does not carry this transfer/),
      });
    }
  });

  it('assembles the signed transaction the node accepts', async () => {
    const h = setup();
    const signed = await h.signed(trx(TRX));
    const decoded = decodeTransaction(signed.raw.data);
    expect(decoded.signatures).toHaveLength(1);
    expect(decoded.signatures[0]).toMatch(/^[0-9a-f]{128}1[bc]$/);
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({ kind: 'accepted' });
    expect(h.node.inPool(signed.ref.id)).toBe(true);
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({
      kind: 'already-known',
    });
    const call = await h.signed(token(10n, { memo: 'order 7' }));
    expect(await h.run(h.broadcaster.broadcast(call))).toEqual({ kind: 'accepted' });
    h.node.mine();
    expect(h.node.tokenBalance(USDT, RECIPIENT)).toBe(10n);
  });

  it('refuses missing signatures and a payload that does not match its txID', async () => {
    const h = setup();
    const unsigned = await h.prepared(trx(TRX));
    const signatures = await signWithKey(unsigned);
    await expect(h.run(h.builder.assemble(unsigned, []))).rejects.toMatchObject({
      code: 'SIGNING_FAILED',
    });
    const tampered: UnsignedTx = {
      ...unsigned,
      payload: { encoding: 'hex', data: `${unsigned.payload.data.slice(0, -2)}00` },
    };
    await expect(h.run(h.builder.assemble(tampered, signatures))).rejects.toMatchObject({
      code: 'SIGNING_FAILED',
    });
    // Lesson 4: the payload's owner must be the signing key's account.
    const other = secp256k1.getPublicKey('11'.repeat(32), true);
    const foreign: UnsignedTx = {
      ...unsigned,
      signingRequests: unsigned.signingRequests.map((r) => ({ ...r, publicKey: other })),
    };
    await expect(h.run(h.builder.assemble(foreign, signatures))).rejects.toMatchObject({
      code: 'SIGNING_FAILED',
      message: expect.stringMatching(/owner is not the signing key/),
    });
    for (const broken of [
      { ...unsigned, payload: { encoding: 'base64', data: unsigned.payload.data } },
      { ...unsigned, payload: { encoding: 'hex', data: 'zz' } },
      { ...unsigned, expectedRef: undefined },
      {
        ...unsigned,
        signingRequests: unsigned.signingRequests.map((r) => ({
          ...r,
          publicKey: new Uint8Array(33),
        })),
      },
    ] as UnsignedTx[]) {
      await expect(h.run(h.builder.assemble(broken, signatures))).rejects.toMatchObject({
        code: 'SIGNING_FAILED',
      });
    }
  });

  it('references the head by the height its id carries, and refuses a head whose id disagrees (F4-R12)', async () => {
    const h = setup();
    const intent = trx(TRX);
    const fee = await h.run(h.builder.estimateFee(intent, h.build));
    const head = h.head();
    h.node.intercept('main', '/wallet/getblock', (request) =>
      request.json().id_or_num === undefined
        ? {
            json: {
              blockID: head.id,
              block_header: {
                raw_data: {
                  number: h.node.head + 1,
                  parentHash: h.node.block(h.node.head - 1)?.id,
                  timestamp: head.timestamp,
                },
              },
            },
          }
        : undefined,
    );
    await expect(h.run(h.builder.build(intent, fee, h.build))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      message: expect.stringMatching(/head block id/),
    });
  });

  it('binds the signed bytes to the stored summary, expiry and fee limit before broadcast', async () => {
    const h = setup();
    const plain = await h.prepared(trx(TRX, { memo: 'hi' }));
    const call = await h.prepared(token(10n));
    const variants: readonly UnsignedTx[] = [
      {
        ...plain,
        summary: { ...plain.summary, outputs: [{ to: OTHER, amount: '1000000' }] },
      },
      {
        ...plain,
        summary: { ...plain.summary, outputs: [{ to: RECIPIENT, amount: '1000001' }] },
      },
      { ...plain, summary: { ...plain.summary, memo: 'ho' } },
      {
        ...plain,
        summary: { asset: plain.summary.asset, outputs: plain.summary.outputs },
      },
      { ...plain, summary: { ...plain.summary, asset: 'tron:nile/trc20:' + USDT } },
      { ...plain, summary: { ...plain.summary, asset: 'tron:shasta/native' } },
      {
        ...plain,
        ordering: {
          ...(plain.ordering as Extract<OrderingData, { kind: 'expiry' }>),
          expiresAtMs: (plain.ordering as { expiresAtMs: number }).expiresAtMs + 1,
        },
      },
      // F4-R12: no reference bound, or another reference's.
      {
        ...plain,
        ordering: {
          kind: 'expiry',
          expiresAtMs: (plain.ordering as { expiresAtMs: number }).expiresAtMs,
        },
      },
      {
        ...plain,
        ordering: {
          ...(plain.ordering as Extract<OrderingData, { kind: 'expiry' }>),
          lastValidHeight:
            (plain.ordering as { lastValidHeight: bigint }).lastValidHeight + 1n,
        },
      },
      // F4-R14: another block's hash bytes, or none.
      {
        ...plain,
        ordering: {
          ...(plain.ordering as TronExpiryOrdering),
          refBlockHash: 'f0'.repeat(8),
        } satisfies TronExpiryOrdering as OrderingData,
      },
      {
        ...plain,
        ordering: {
          kind: 'expiry',
          expiresAtMs: (plain.ordering as TronExpiryOrdering).expiresAtMs,
          lastValidHeight: (plain.ordering as TronExpiryOrdering).lastValidHeight,
        },
      },
      { ...call, summary: { ...call.summary, asset: 'tron:nile/native' } },
      { ...call, summary: { ...call.summary, asset: 'tron:nile/trc20:' + OTHER } },
      { ...call, summary: { ...call.summary, outputs: [{ to: OTHER, amount: '10' }] } },
      { ...call, fee: { ...call.fee, details: { ...call.fee.details, feeLimit: 1n } } },
    ];
    for (const unsigned of variants) {
      const signatures = await signWithKey(unsigned);
      await expect(h.run(h.builder.assemble(unsigned, signatures))).rejects.toMatchObject(
        {
          code: 'SIGNING_FAILED',
          message: expect.stringMatching(/does not match its summary/),
        },
      );
    }
    // Plan 2 note: only the named fee field is read; the core may add others.
    const extra: UnsignedTx = {
      ...call,
      fee: { ...call.fee, details: { ...call.fee.details, requestedFee: 'x' } },
    };
    await expect(
      h.run(h.builder.assemble(extra, await signWithKey(extra))),
    ).resolves.toMatchObject({ ref: call.expectedRef });
  });
});

describe('Tron broadcaster', () => {
  it('classifies node refusals with fixed reasons, and never re-sends on an expiry answer', async () => {
    const h = setup();
    const signed = await h.signed(trx(TRX));
    await h.clock.advance(70_000);
    h.node.mine();
    const before = callsTo(h, '/wallet/broadcasthex');
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({
      kind: 'refused',
      code: 'TX_EXPIRED',
      reason: 'transaction expired',
    });
    expect(callsTo(h, '/wallet/broadcasthex') - before).toBe(1);
  });

  it('broadcasts under the broadcast tags and lets an ambiguous failure through', async () => {
    const h = setup({ endpoints: ['a', 'b'] });
    const signed = await h.signed(trx(TRX));
    h.node.intercept('a', '/wallet/broadcasthex', () => undefined);
    await h.run(h.broadcaster.broadcast(signed, { fanout: 2 }));
    expect(h.calls.at(-1)).toEqual({
      path: '/wallet/broadcasthex',
      tags: {
        purpose: 'broadcast',
        retry: 'ambiguous-on-failure',
        exactIntegers: true,
        fanout: 2,
      },
    });
    await h.run(
      h.broadcaster.broadcast(signed, { signal: new AbortController().signal }),
    );
    expect(h.calls.at(-1)?.tags).toEqual({
      purpose: 'broadcast',
      retry: 'ambiguous-on-failure',
      exactIntegers: true,
      signal: true,
    });
    const next = await h.signed(trx(2n * TRX));
    h.node.fetch.route('https://a.tron.test/wallet/broadcasthex', (_request, signal) =>
      hang(signal),
    );
    h.node.fetch.route('https://b.tron.test/wallet/broadcasthex', (_request, signal) =>
      hang(signal),
    );
    await expect(h.run(h.broadcaster.broadcast(next))).rejects.toMatchObject({
      ambiguous: true,
    });
  });

  it('leaves the transaction possibly sent on node-local codes, unknown codes, 5xx and unreadable replies', async () => {
    for (const next of [
      { json: { result: false, code: 'SERVER_BUSY', message: 'Server busy.' } },
      { json: { result: false, code: 'OTHER_ERROR', message: 'Error: x' } },
      { json: { result: false, code: 'SOMETHING_NEW' } },
      { json: { result: false } },
      { json: [] },
      { json: { Error: 'class java.lang.NullPointerException : null' } },
      { status: 503, text: 'unavailable' },
      { text: 'not json' },
    ]) {
      // A fresh endpoint each time: a 5xx or an unreadable reply opens its breaker.
      const h = setup();
      const signed = await h.signed(trx(TRX));
      let reply: FakeReply | undefined = next;
      h.node.intercept('main', '/wallet/broadcasthex', () => reply);
      await expect(h.run(h.broadcaster.broadcast(signed))).rejects.toMatchObject({
        ambiguous: true,
      });
      expect(callsTo(h, '/wallet/broadcasthex')).toBeGreaterThan(0);
      if (next.json && 'code' in next.json && next.json.code === 'SERVER_BUSY') {
        // The same bytes, answered by the node itself: nothing was decided above.
        reply = undefined;
        expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({
          kind: 'accepted',
        });
      }
    }
  });

  it('refuses a raw transaction that is not hex without sending it, in linear time', async () => {
    const h = setup();
    const signed = await h.signed(trx(TRX));
    const before = callsTo(h, '/wallet/broadcasthex');
    for (const raw of [
      { encoding: 'base64', data: signed.raw.data },
      { encoding: 'hex', data: `${signed.raw.data}0` },
      { encoding: 'hex', data: '' },
      // Lesson 20: a huge input is checked in linear time and never sent.
      { encoding: 'hex', data: `${'ab'.repeat(2_000_000)}zz` },
    ] as const) {
      await expect(
        h.run(h.broadcaster.broadcast({ raw, ref: signed.ref })),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    }
    expect(callsTo(h, '/wallet/broadcasthex')).toBe(before);
  });

  it('rejects hand-built bytes that java-tron refuses for a reason they carry (lesson 21)', async () => {
    const h = setup();
    h.node.fund(RECIPIENT, 1n); // an existing recipient: no account creation
    const head = h.head();
    const raw = (extra: Partial<TronRawData> = {}): TronRawData => ({
      refBlockBytes: head.id.slice(12, 16),
      refBlockHash: head.id.slice(16, 32),
      expiration: head.timestamp + 60_000,
      timestamp: head.timestamp,
      contract: {
        type: 'TransferContract',
        owner: KEY_HEX,
        to: RECIPIENT_HEX,
        amount: 1n,
      },
      ...extra,
    });
    const send = (hex: string) =>
      h.run(
        h.broadcaster.broadcast({
          raw: { encoding: 'hex', data: hex },
          ref: {
            id: toHex(sha256(fromHex(decodeTransaction(hex).rawHex))),
            idKind: 'tx-hash',
            canonical: true,
          },
        }),
      );
    const valid = signedTransaction(raw());
    const [signature] = decodeTransaction(valid.hex).signatures as [string];
    // `Transaction.raw` with its reference fields and no contract.
    const noContract = `0a02${head.id.slice(12, 16)}2208${head.id.slice(16, 32)}`;
    for (const [hex, reason] of [
      [
        signedTransaction(
          raw({
            contract: {
              type: 'TransferContract',
              owner: KEY_HEX,
              to: RECIPIENT_HEX,
              amount: 0n,
            },
          }),
        ).hex,
        'non-positive amount',
      ],
      [
        signedTransaction(
          raw({
            contract: {
              type: 'TransferContract',
              owner: KEY_HEX,
              to: KEY_HEX,
              amount: 1n,
            },
          }),
        ).hex,
        'transfer to self',
      ],
      [
        encodeTransaction(decodeTransaction(valid.hex).rawHex, [signature.slice(0, 128)]),
        'malformed signature',
      ],
      [encodeTransaction(noContract, [signature]), 'no contract'],
      [
        signedTransaction(raw({ data: '61'.repeat(520_000) })).hex,
        'transaction too large',
      ],
    ] as const) {
      expect(await send(hex)).toEqual({ kind: 'rejected', reason });
    }
    expect(await send(valid.hex)).toEqual({ kind: 'accepted' });
  });

  it.each(CLAIMS)(
    'refuses, never rejects, a relaying node claiming %s of our valid bytes (lesson 21)',
    async (code, message) => {
      const h = setup();
      const signed = await h.signed(trx(TRX));
      const relay = h.node.endpoint('relay');
      h.node.intercept('main', '/wallet/broadcasthex', async (request) => {
        await h.node.fetch.fetch(`${relay}/wallet/broadcasthex`, {
          method: 'POST',
          body: request.body ?? '',
        });
        return { json: { result: false, code, message } };
      });
      expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({
        kind: 'refused',
        code: 'TX_REFUSED',
        reason: 'the node claimed the transaction is invalid',
      });
      // The node pooled them, and they land.
      expect(h.node.inPool(signed.ref.id)).toBe(true);
      await h.clock.advance(3_000);
      h.node.mine();
      expect(h.node.transaction(signed.ref.id)?.blockNumber).toBe(h.node.head);
    },
  );

  it('rethrows every broadcast failure as the same object, unclassified', async () => {
    const h = setup();
    const signed = await h.signed(trx(TRX));
    for (const error of [
      new ProviderError('RPC_ERROR', 'maybe delivered', { ambiguous: true }),
      new ProviderError('PROVIDER_UNAVAILABLE', 'down'),
      new Error('x'),
    ]) {
      const api = { broadcastHex: () => Promise.reject(error) } as unknown as TronApi;
      const { broadcaster } = createTronBuilder({ ...h.ctx, api });
      await expect(h.run(broadcaster.broadcast(signed))).rejects.toBe(error);
    }
  });
});
