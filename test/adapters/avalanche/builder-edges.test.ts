import { secp256k1 } from '@noble/curves/secp256k1';
import {
  MAX_INPUTS,
  MAX_OUTPUTS,
  avalancheBroadcaster,
  avalancheBuilder,
} from '../../../src/adapters/avalanche/builder';
import { encodeChecked } from '../../../src/adapters/avalanche/api';
import type { BuildContext } from '../../../src/core/driver/types';
import type { FeeEstimateDraft } from '../../../src/core/model/fee';
import type { DriverIntent } from '../../../src/core/model/intent';
import type { SignedTx, UnsignedTx } from '../../../src/core/model/transaction';
import { fromHex, toHex } from '../../../src/core/util/bytes';
import { ProviderError } from '../../../src/core/errors/error';
import { avalancheHarness, type Harness } from './support/harness';
import { idOf, signWith } from './support/node';
import {
  OTHER_BYTES,
  OTHER_PUBKEY,
  TEST_BYTES,
  TEST_KEY,
  configOf,
  type Vm,
} from './support/vectors';

const intentOf = (
  h: Harness,
  extra: Partial<DriverIntent> = {},
  amount = 1_000n,
): DriverIntent => ({
  asset: 'native',
  outputs: [{ to: h.address(OTHER_BYTES), amount }],
  from: h.from,
  fee: 'normal',
  ...extra,
});

const buildOf = (h: Harness, extra: Partial<BuildContext> = {}): BuildContext => ({
  from: h.from,
  keys: h.keys,
  wallet: {},
  ...extra,
});

function sign(unsigned: UnsignedTx) {
  const request = unsigned.signingRequests[0]!;
  const sig = secp256k1.sign(request.payload, TEST_KEY, { lowS: true });
  return [
    { requestId: request.id, bytes: sig.toCompactRawBytes(), recovery: sig.recovery },
  ];
}

async function signedTx(
  h: Harness,
  extra: Partial<DriverIntent> = {},
): Promise<SignedTx> {
  const builder = avalancheBuilder(h.ctx);
  const intent = intentOf(h, extra);
  const fee = await h.run(builder.estimateFee(intent, buildOf(h)));
  const unsigned = await h.run(builder.build(intent, fee, buildOf(h)));
  return h.run(builder.assemble(unsigned, sign(unsigned)));
}

describe('what the Avalanche builder refuses before anything is signed', () => {
  it.each([
    [{ outputs: [] }, 'INVALID_INTENT', 'at least one output is required'],
    [
      {
        outputs: Array.from({ length: MAX_OUTPUTS + 1 }, () => ({ to: '', amount: 1n })),
      },
      'INVALID_INTENT',
      `a transfer pays at most ${MAX_OUTPUTS} outputs`,
    ],
    [{ outputs: [{ to: 'x', amount: 0n }] }, 'INVALID_AMOUNT', 'at least 1 nAVAX'],
    [
      { outputs: [{ to: 'X-fuji1nope', amount: 1n }] },
      'INVALID_ADDRESS',
      'not an address',
    ],
    [{ memo: 'x'.repeat(257) }, 'INVALID_INTENT', 'at most 256 bytes'],
    [
      { asset: { standard: 'erc20', contract: 'x' } },
      'UNSUPPORTED_CAPABILITY',
      'native tokens',
    ],
    [{ fee: { gasPrice: 5n } }, 'INVALID_INTENT', 'the X-Chain fee is fixed'],
  ] as const)('%j', async (extra, code, message) => {
    const h = avalancheHarness();
    h.node.fund(TEST_BYTES, 10_000_000n);
    await expect(
      h.run(avalancheBuilder(h.ctx).estimateFee(intentOf(h, extra as never), buildOf(h))),
    ).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
  });

  it.each([
    [{ fee: { gasPrice: 0n } }, 'below'],
    [{ fee: { gasPrice: 'abc' } }, 'gasPrice must be a positive integer'],
    [{ fee: { gasPrice: 1n, tip: 2n } }, 'a P-Chain fee is a speed or { gasPrice }'],
    [{ fee: { gasPrice: 20_000n } }, 'options.maxGasPrice'],
    [{ fee: 7 }, 'fee must be a speed or { gasPrice }'],
    [{ memo: 'hi' }, 'P-Chain transactions carry no memo'],
  ] as const)('P-Chain: %j', async (extra, message) => {
    const h = avalancheHarness({ vm: 'pvm' });
    h.node.fund(TEST_BYTES, 10_000_000n);
    await expect(
      h.run(avalancheBuilder(h.ctx).estimateFee(intentOf(h, extra as never), buildOf(h))),
    ).rejects.toThrow(message);
  });

  it('refuses an endpoint gas price outside 1..maxGasPrice (decides nothing)', async () => {
    const h = avalancheHarness({ vm: 'pvm', driverOptions: { maxGasPrice: 50n } });
    h.node.fund(TEST_BYTES, 10_000_000n);
    h.node.setGasPrice(51n);
    await expect(
      h.run(avalancheBuilder(h.ctx).estimateFee(intentOf(h), buildOf(h))),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('never pays more than options.maxFee', async () => {
    const h = avalancheHarness({ driverOptions: { maxFee: 999_999n } });
    h.node.fund(TEST_BYTES, 10_000_000n);
    await expect(
      h.run(avalancheBuilder(h.ctx).estimateFee(intentOf(h), buildOf(h))),
    ).rejects.toThrow('the fee exceeds the configured maximum (options.maxFee)');
  });

  it("builds only for the wallet's own key", async () => {
    const h = avalancheHarness();
    h.node.fund(TEST_BYTES, 10_000_000n);
    const builder = avalancheBuilder(h.ctx);
    const fee = await h.run(builder.estimateFee(intentOf(h), buildOf(h)));
    await expect(
      h.run(builder.build(intentOf(h), fee, buildOf(h, { keys: [] }))),
    ).rejects.toThrow('needs the wallet public key');
    await expect(
      h.run(
        builder.build(
          intentOf(h),
          fee,
          buildOf(h, { keys: [{ scheme: 'secp256k1-ecdsa', publicKey: OTHER_PUBKEY }] }),
        ),
      ),
    ).rejects.toThrow("the wallet's key does not own the sending address");
  });

  it('refuses a fee estimate of another chain', async () => {
    const h = avalancheHarness();
    h.node.fund(TEST_BYTES, 10_000_000n);
    const builder = avalancheBuilder(h.ctx);
    const fee = await h.run(builder.estimateFee(intentOf(h), buildOf(h)));
    const wrong: FeeEstimateDraft[] = [
      { ...fee, kind: 'utxo' },
      { ...fee, details: { ...fee.details, model: 'dynamic' } },
      { ...fee, details: { ...fee.details, txFee: '1' } },
    ];
    for (const stored of wrong) {
      await expect(
        h.run(builder.build(intentOf(h), stored, buildOf(h))),
      ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    }
  });

  it('refuses a stored P-Chain gas price above options.maxGasPrice', async () => {
    const h = avalancheHarness({ vm: 'pvm' });
    h.node.fund(TEST_BYTES, 10_000_000n);
    const builder = avalancheBuilder(h.ctx);
    const fee = await h.run(builder.estimateFee(intentOf(h), buildOf(h)));
    const stored = { ...fee, details: { ...fee.details, gasPrice: 20_000n } };
    await expect(h.run(builder.build(intentOf(h), stored, buildOf(h)))).rejects.toThrow(
      'options.maxGasPrice',
    );
  });
});

describe.each(['avm', 'pvm'] as Vm[])('%s fee estimates and funds', (vm) => {
  it('names the fee of a one-input transfer when the wallet cannot pay', async () => {
    const h = avalancheHarness({ vm });
    const builder = avalancheBuilder(h.ctx);
    const empty = await h.run(builder.estimateFee(intentOf(h), buildOf(h)));
    expect(empty.charges[0]?.amount).toBeGreaterThan(0n);
    expect(empty.details).toMatchObject({ inputs: 1 });
    h.node.fund(TEST_BYTES, 1_500n); // more than the output, less than the output and fee
    const short = await h.run(builder.estimateFee(intentOf(h), buildOf(h)));
    expect(short.charges[0]?.amount).toBe(empty.charges[0]?.amount);
    const funds = await h.run(builder.checkFunds(intentOf(h), short, buildOf(h)));
    expect(funds).toMatchObject({ ok: false, asset: 'native', available: 1_500n });
    await expect(
      h.run(builder.build(intentOf(h), short, buildOf(h))),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
  });

  it('leaves out the inputs other Operations hold', async () => {
    const h = avalancheHarness({ vm });
    h.node.fund(TEST_BYTES, 9_000_000n);
    h.node.fund(TEST_BYTES, 8_000_000n);
    const [big, small] = h.node
      .utxoKeysOf(TEST_BYTES)
      .map((key) => key)
      .sort();
    const builder = avalancheBuilder(h.ctx);
    const build = buildOf(h, { excludeInputs: [big as string] });
    const fee = await h.run(builder.estimateFee(intentOf(h), build));
    expect(await h.run(builder.checkFunds(intentOf(h), fee, build))).toEqual({
      ok: true,
    });
    const unsigned = await h.run(builder.build(intentOf(h), fee, build));
    expect(unsigned.ordering).toEqual({ kind: 'inputs', inputs: [small] });
  });

  it(`spends at most ${MAX_INPUTS} inputs, and says when the wallet needs consolidating`, async () => {
    const h = avalancheHarness({ vm });
    for (let i = 0; i < MAX_INPUTS + 2; i++) h.node.mint(TEST_BYTES, 1_000_000n);
    const builder = avalancheBuilder(h.ctx);
    // 128 inputs (128,000,000) cannot pay 128,000,000 and a fee; all 130 could.
    const intent = intentOf(h, {}, 1_000_000n * BigInt(MAX_INPUTS));
    const fee = await h.run(builder.estimateFee(intent, buildOf(h)));
    expect(await h.run(builder.checkFunds(intent, fee, buildOf(h)))).toEqual({
      ok: true,
    });
    await expect(h.run(builder.build(intent, fee, buildOf(h)))).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: expect.stringContaining('consolidate'),
    });
    // More than every output: plainly insufficient.
    const more = intentOf(h, {}, 1_000_000n * BigInt(MAX_INPUTS + 2));
    await expect(h.run(builder.build(more, fee, buildOf(h)))).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
  }, 30_000);
});

describe('assembling and taking signatures', () => {
  it('needs the signature and its recovery id', async () => {
    const h = avalancheHarness();
    h.node.fund(TEST_BYTES, 10_000_000n);
    const builder = avalancheBuilder(h.ctx);
    const fee = await h.run(builder.estimateFee(intentOf(h), buildOf(h)));
    const unsigned = await h.run(builder.build(intentOf(h), fee, buildOf(h)));
    await expect(h.run(builder.assemble(unsigned, []))).rejects.toMatchObject({
      code: 'SIGNING_FAILED',
    });
    const [bundle] = sign(unsigned);
    await expect(
      h.run(builder.assemble(unsigned, [{ ...bundle!, recovery: undefined }])),
    ).rejects.toThrow('recovery id');
  });

  it('takes the signature of a transaction signed elsewhere, and only of that one', async () => {
    const h = avalancheHarness();
    h.node.fund(TEST_BYTES, 10_000_000n);
    const builder = avalancheBuilder(h.ctx);
    const fee = await h.run(builder.estimateFee(intentOf(h), buildOf(h)));
    const unsigned = await h.run(builder.build(intentOf(h), fee, buildOf(h)));
    const signed = signWith(fromHex(unsigned.payload.data), TEST_KEY, 'avm');
    const [bundle] = builder.signaturesFrom(unsigned, {
      encoding: 'hex',
      data: toHex(signed),
    });
    expect(bundle).toMatchObject({ requestId: 'tx' });
    expect(bundle?.bytes).toHaveLength(64);
    expect(() =>
      builder.signaturesFrom(unsigned, { encoding: 'base64', data: 'AA==' }),
    ).toThrow('as hex');
    expect(() =>
      builder.signaturesFrom(unsigned, { encoding: 'hex', data: '00' }),
    ).toThrow('not a signed transaction of this chain');
    const other = await h.run(builder.build(intentOf(h, {}, 7n), fee, buildOf(h)));
    const elsewhere = signWith(fromHex(other.payload.data), TEST_KEY, 'avm');
    expect(() =>
      builder.signaturesFrom(unsigned, { encoding: 'hex', data: toHex(elsewhere) }),
    ).toThrow('the signed transaction is not the prepared one');
  });
});

describe('the Avalanche broadcaster', () => {
  it('refuses bytes that are not a signed transaction of this chain', async () => {
    const h = avalancheHarness();
    const broadcaster = avalancheBroadcaster(h.ctx);
    const send = (raw: SignedTx['raw'], id = '') =>
      h.run(broadcaster.broadcast({ raw, ref: { id, idKind: 'txid', canonical: true } }));
    await expect(send({ encoding: 'base64', data: 'AA==' })).rejects.toThrow('is hex');
    await expect(send({ encoding: 'hex', data: 'abc' })).rejects.toThrow('is hex');
    await expect(send({ encoding: 'hex', data: '00'.repeat(10) })).rejects.toThrow(
      'not a signed transaction of this chain',
    );
    // A Fuji transaction refused by a mainnet handle, before any request.
    const fuji = await signedTx(avalancheHarnessFunded());
    const mainnet = avalancheHarness({ node: { network: 'mainnet' } });
    const mainnetCtx = { ...mainnet.ctx, config: configOf('avm', {}, 'mainnet') };
    await expect(
      mainnet.run(avalancheBroadcaster(mainnetCtx).broadcast(fuji)),
    ).rejects.toThrow('for another network or chain');
    // Bytes that are not the Attempt's.
    await expect(send(fuji.raw, 'wrong')).rejects.toThrow('do not have the Attempt id');
    expect(h.node.issued).toEqual([]);
  });

  it('takes a duplicate as accepted and a spent input as a refusal', async () => {
    const h = avalancheHarnessFunded();
    const signed = await signedTx(h);
    const broadcaster = avalancheBroadcaster(h.ctx);
    expect(await h.run(broadcaster.broadcast(signed))).toEqual({ kind: 'accepted' });
    expect(await h.run(broadcaster.broadcast(signed))).toEqual({ kind: 'accepted' });
    h.node.mine();
    expect(await h.run(broadcaster.broadcast(signed))).toMatchObject({
      kind: 'refused',
      code: 'TX_REFUSED',
    });
    // A bare broadcast (no ref) is checked against the bytes' own id.
    expect(
      await h.run(
        broadcaster.broadcast({
          raw: signed.raw,
          ref: { id: '', idKind: 'txid', canonical: true },
        }),
      ),
    ).toMatchObject({ kind: 'refused' });
  });

  it('refuses a P-Chain transaction that burns less than the price now asks', async () => {
    const h = avalancheHarness({ vm: 'pvm' });
    h.node.fund(TEST_BYTES, 10_000_000n);
    const signed = await signedTx(h);
    h.node.setGasPrice(100n);
    expect(await h.run(avalancheBroadcaster(h.ctx).broadcast(signed))).toMatchObject({
      kind: 'refused',
      code: 'FEE_TOO_LOW',
    });
  });

  it('calls an answer under another id ambiguous', async () => {
    const h = avalancheHarnessFunded();
    const signed = await signedTx(h);
    h.node.intercept('main', (method) =>
      method === 'avm.issueTx'
        ? { result: { txID: idOf(new Uint8Array(3)) } }
        : undefined,
    );
    await expect(
      h.run(avalancheBroadcaster(h.ctx).broadcast(signed)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', ambiguous: true });
  });

  it('rethrows a transport failure unclassified (R16)', async () => {
    const h = avalancheHarnessFunded();
    const signed = await signedTx(h);
    jest
      .spyOn(h.ctx.node, 'issueTx')
      .mockRejectedValue(
        new ProviderError('PROVIDER_UNAVAILABLE', 'down', { ambiguous: true }),
      );
    await expect(
      h.run(avalancheBroadcaster(h.ctx).broadcast(signed)),
    ).rejects.toMatchObject({ ambiguous: true });
    expect(encodeChecked(new Uint8Array(1))).toMatch(/^0x00/);
  });
});

function avalancheHarnessFunded() {
  const h = avalancheHarness();
  h.node.fund(TEST_BYTES, 10_000_000n);
  return h;
}
