import { ed25519 } from '@noble/curves/ed25519';
import { Cell, beginCell, internal, loadMessage, storeMessageRelaxed } from '@ton/core';
import {
  CHAIN_TIME_TOLERANCE,
  MAX_NETWORK_FEE,
  REQUEST_ID,
  createTonBroadcaster,
  createTonBuilder,
} from '../../../src/adapters/ton/builder';
import * as messages from '../../../src/adapters/ton/messages';
import {
  addressArgument,
  decodeComment,
  decodeJettonTransfer,
  decodeWalletRequest,
  messageFacts,
} from '../../../src/adapters/ton/messages';
import { TON_CAPABILITIES } from '../../../src/adapters/ton/network';
import type { BuildContext } from '../../../src/core/driver/types';
import type { LogFields } from '../../../src/core/events/logger';
import { noopLogger } from '../../../src/core/events/logger';
import type { DriverIntent, DriverOutput } from '../../../src/core/model/intent';
import { hang, type FakeReply } from '../../../src/testing/fake-fetch';
import { tonHarness } from './support/context';
import { testWallet } from './support/harness';
import { NODE_FEES } from './support/node';
import { KEY, PUBLIC_KEY, TEST_WALLETS, WALLET_IDS } from './support/vectors';

const TESTNET = -3;
const GRAM = 1_000_000_000n;
const FRESH = `0:${'11'.repeat(32)}`;
const OTHER = `0:${'22'.repeat(32)}`;
const MASTER = `0:${'77'.repeat(32)}`;
const PK = Buffer.from(PUBLIC_KEY, 'hex');
/** The account part of a refusal text: the liteserver writes it in upper-case hex. */
const HEX = 'CD'.repeat(32);

function setup(version: 'v4r2' | 'v5r1' = 'v4r2', endpoints?: readonly string[]) {
  const h = tonHarness(endpoints ? { endpoints } : {});
  const from = testWallet(version, TESTNET);
  const builder = createTonBuilder(h.ctx);
  const broadcaster = createTonBroadcaster(h.ctx);
  const build = (
    seqno = 0n,
    wallet: Readonly<Record<string, unknown>> = { ton: { version } },
  ): BuildContext => ({
    from,
    keys: [{ scheme: 'ed25519', publicKey: PK }],
    wallet,
    ordering: { kind: 'seqno', seqno, validUntil: 0 },
  });
  const intent = (patch: Partial<DriverIntent> = {}): DriverIntent => ({
    asset: 'native',
    // The codec's variant holds the bounce flag only (P25-R13).
    outputs: [{ to: FRESH, amount: GRAM, variant: { bounceable: false } }],
    from,
    fee: 'normal',
    ...patch,
  });
  /** estimate → check → build → sign → assemble, as the engine does. */
  const prepare = async (i: DriverIntent, b = build()) => {
    const fee = await h.run(builder.estimateFee(i, b));
    const funds = await h.run(builder.checkFunds(i, fee, b));
    const unsigned = await h.run(builder.build(i, fee, b));
    const request = unsigned.signingRequests[0]!;
    const signature = ed25519.sign(request.payload, Buffer.from(KEY, 'hex'));
    const signed = await builder.assemble(unsigned, [
      { requestId: request.id, bytes: signature },
    ]);
    return { fee, funds, unsigned, signed };
  };
  return { h, from, builder, broadcaster, build, intent, prepare };
}

/** The external message in a payload, its wallet request and the one message it sends. */
function decoded(payload: string) {
  const external = loadMessage(
    Cell.fromBoc(Buffer.from(payload, 'base64'))[0]!.beginParse(),
  );
  if (external.info.type !== 'external-in') throw new Error('not an external message');
  const request = decodeWalletRequest(external.body)!;
  const message = request.messages[0]!;
  if (message.info.type !== 'internal') throw new Error('not an internal message');
  return {
    external,
    dest: external.info.dest.toRawString(),
    request,
    message,
    info: message.info,
  };
}

/** A v2 `estimateFee` answer with these source fees. */
const feesAnswer = (fees: { readonly gas: bigint; readonly fwd: bigint }) => ({
  json: {
    ok: true,
    result: {
      source_fees: {
        in_fwd_fee: Number(NODE_FEES.importFee),
        storage_fee: 0,
        gas_fee: Number(fees.gas),
        fwd_fee: Number(fees.fwd),
      },
      destination_fees: [],
    },
  },
});

/** A v2 error body with the node's own text. */
const nodeError = (status: number, error: string) => ({
  status,
  json: { ok: false, error, code: status },
});

/** An intercept that answers `/sendBocReturnHash` with `reply`. */
const onSend = (reply: () => FakeReply) => (_endpoint: string, route: string) =>
  route === '/sendBocReturnHash' ? reply() : undefined;

describe('the TON builder', () => {
  it.each(['v4r2', 'v5r1'] as const)(
    'deploys a %s wallet with its first transfer and pays a non-bounceable recipient',
    async (version) => {
      const s = setup(version);
      s.h.node.fund(s.from, 3n * GRAM);
      const { fee, funds, unsigned, signed } = await s.prepare(
        s.intent({ memo: 'invoice 7' }),
      );
      const gas =
        (version === 'v4r2' ? NODE_FEES.gasV4 : NODE_FEES.gasV5) + NODE_FEES.deployGas;
      expect(fee).toMatchObject({
        kind: 'ton',
        bound: 'expected',
        payer: s.from,
        details: {
          importFee: NODE_FEES.importFee,
          gasFee: gas,
          deploy: true,
          forwardFeeSource: 'emulated',
        },
      });
      expect(fee.charges[0]?.amount).toBeGreaterThan(NODE_FEES.importFee + gas);
      expect(funds).toEqual({ ok: true });
      const now = Math.floor(s.h.clock.now() / 1000);
      expect(unsigned).toMatchObject({
        payload: { encoding: 'base64' },
        ordering: { kind: 'seqno', seqno: 0n, validUntil: now + 60 },
        signingRequests: [
          { id: REQUEST_ID, scheme: 'ed25519', payloadKind: 'message', publicKey: PK },
        ],
        summary: {
          asset: 'ton:testnet/native',
          outputs: [{ to: FRESH, amount: String(GRAM) }],
          memo: 'invoice 7',
        },
      });
      expect(signed.ref).toMatchObject({ idKind: 'message-hash', canonical: false });
      expect(await s.h.run(s.broadcaster.broadcast(signed))).toEqual({
        kind: 'accepted',
      });
      expect(s.h.node.sendCount(signed.ref.id)).toBe(1);
      s.h.node.mine(2);
      expect(s.h.node.balance(FRESH)).toBe(GRAM);
      expect(s.h.node.seqno(s.from)).toBe(1);
    },
  );

  it('sends a raw recipient bounceable, and the next transfer without a StateInit', async () => {
    const s = setup();
    s.h.node.fund(s.from, 5n * GRAM);
    const first = await s.prepare(s.intent({ outputs: [{ to: FRESH, amount: GRAM }] }));
    expect(decoded(first.signed.raw.data).external.init).toBeTruthy();
    await s.h.run(s.broadcaster.broadcast(first.signed));
    s.h.node.mine(3);
    expect(s.h.node.balance(FRESH)).toBe(0n);
    const second = await s.prepare(s.intent(), s.build(1n));
    expect(second.fee.details).toMatchObject({ deploy: false });
    expect(decoded(second.signed.raw.data).external.init).toBeFalsy();
    await s.h.run(s.broadcaster.broadcast(second.signed));
    s.h.node.mine(2);
    expect(s.h.node.balance(FRESH)).toBe(GRAM);
  });

  it('refuses a wallet identity that does not derive the sender, before any I/O (lesson 5)', async () => {
    const s = setup();
    const before = s.h.node.served.length;
    await expect(
      s.h.run(
        s.builder.estimateFee(s.intent(), s.build(0n, { ton: { version: 'v5r1' } })),
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(
      s.h.run(s.builder.build(s.intent(), {} as never, s.build(0n, {}))),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(
      s.h.run(s.builder.checkFunds(s.intent({ from: OTHER }), {} as never, s.build())),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(
      s.h.run(s.builder.estimateFee(s.intent(), { ...s.build(), keys: [] })),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(s.h.node.served.length).toBe(before);
  });

  it('builds one output per transfer: a batch, a long memo or a native attached value is refused before any I/O', async () => {
    const s = setup();
    const before = s.h.node.served.length;
    // A batch whose verdict is `failed` could be re-sent whole, paying twice the outputs
    // that moved: TON transfers carry exactly one output, and no network offers batches.
    expect(TON_CAPABILITIES).not.toContain('batch-transfer');
    for (const count of [2, 5]) {
      const batch = s.intent({
        outputs: Array.from({ length: count }, () => ({ to: FRESH, amount: 1n })),
      });
      for (const call of <(() => Promise<unknown>)[]>[
        () => s.builder.estimateFee(batch, s.build()),
        () => s.builder.checkFunds(batch, {} as never, s.build()),
        () => s.builder.build(batch, {} as never, s.build()),
      ]) {
        await expect(s.h.run(call())).rejects.toMatchObject({
          code: 'UNSUPPORTED_CAPABILITY',
          message: expect.stringContaining('one output'),
        });
      }
    }
    await expect(
      s.h.run(s.builder.estimateFee(s.intent({ outputs: [] }), s.build())),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    for (const memo of ['x'.repeat(1025), 'é'.repeat(513)]) {
      await expect(
        s.h.run(s.builder.estimateFee(s.intent({ memo }), s.build())),
      ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    }
    await expect(
      s.h.run(s.builder.estimateFee(s.intent({ fee: { attached: 1n } }), s.build())),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    expect(s.h.node.served.length).toBe(before);
  });

  it('refuses a recipient variant other than { bounceable } before any I/O (P25-R13)', async () => {
    const s = setup();
    const before = s.h.node.served.length;
    for (const variant of [
      { bounceable: 'no' },
      { bounceable: false, testOnly: true },
      { urlSafe: true },
      {},
    ]) {
      await expect(
        s.h.run(
          s.builder.estimateFee(
            s.intent({ outputs: [{ to: FRESH, amount: 1n, variant }] }),
            s.build(),
          ),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    }
    expect(s.h.node.served.length).toBe(before);
  });

  it('reports a shortfall with required and available amounts', async () => {
    const s = setup();
    s.h.node.fund(s.from, GRAM);
    const i = s.intent();
    const fee = await s.h.run(s.builder.estimateFee(i, s.build()));
    const funds = await s.h.run(s.builder.checkFunds(i, fee, s.build()));
    expect(funds).toMatchObject({ ok: false, asset: 'native', available: GRAM });
    expect(funds.ok === false && funds.required > GRAM).toBe(true);
  });

  it('refuses a frozen wallet from its state, in every method, before anything else', async () => {
    const s = setup();
    s.h.node.fund(s.from, GRAM);
    const fee = await s.h.run(s.builder.estimateFee(s.intent(), s.build()));
    s.h.node.freeze(s.from);
    const before = s.h.node.served.length;
    for (const call of <(() => Promise<unknown>)[]>[
      () => s.builder.estimateFee(s.intent(), s.build()),
      () => s.builder.checkFunds(s.intent(), fee, s.build()),
      () => s.builder.build(s.intent(), fee, s.build()),
    ]) {
      await expect(s.h.run(call())).rejects.toMatchObject({ code: 'TX_REFUSED' });
    }
    expect(s.h.node.served.slice(before).map((r) => r.route)).toEqual([
      '/getAddressInformation',
      '/getAddressInformation',
      '/getAddressInformation',
    ]);
  });

  it('refuses an undeployed wallet at an allocated seqno past 0, retryably (I6)', async () => {
    const s = setup();
    s.h.node.fund(s.from, 2n * GRAM);
    const fee = await s.h.run(s.builder.estimateFee(s.intent(), s.build()));
    const before = s.h.node.served.length;
    // A lagging state, or a deleted wallet: its `StateInit` would restart at seqno 0.
    for (const call of <(() => Promise<unknown>)[]>[
      () => s.builder.estimateFee(s.intent(), s.build(3n)),
      () => s.builder.build(s.intent(), fee, s.build(3n)),
    ]) {
      await expect(s.h.run(call())).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
    }
    expect(s.h.node.served.slice(before).map((r) => r.route)).toEqual([
      '/getAddressInformation',
      '/getAddressInformation',
    ]);
  });

  it('moves jettons with the attached value as an upper bound, refunding the excess', async () => {
    const s = setup();
    s.h.node.fund(s.from, 2n * GRAM);
    s.h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    s.h.node.mintJetton(MASTER, s.from, 1_000n);
    const jetton = { standard: 'jetton', contract: MASTER };
    const short = s.intent({ asset: jetton, outputs: [{ to: FRESH, amount: 5_000n }] });
    const shortFee = await s.h.run(s.builder.estimateFee(short, s.build()));
    expect(await s.h.run(s.builder.checkFunds(short, shortFee, s.build()))).toEqual({
      ok: false,
      asset: jetton,
      required: 5_000n,
      available: 1_000n,
    });
    const i = s.intent({
      asset: jetton,
      outputs: [{ to: FRESH, amount: 400n }],
      memo: 'order 9',
      fee: { attached: 60_000_000n },
    });
    const { fee, unsigned, signed } = await s.prepare(i);
    expect(fee).toMatchObject({
      bound: 'upper',
      charges: [{ label: 'network' }, { label: 'attached', amount: 60_000_000n }],
      details: { attached: 60_000_000n, forwardAmount: 1n },
    });
    expect(unsigned.summary.asset).toBe(`ton:testnet/jetton:${MASTER}`);
    await s.h.run(s.broadcaster.broadcast(signed));
    s.h.node.mine(5);
    expect(s.h.node.jettonBalance(MASTER, FRESH)).toBe(400n);
    expect(s.h.node.balance(FRESH)).toBe(1n);
  });

  it('refuses an attached value at or below the forward amount, before any I/O', async () => {
    const s = setup();
    s.h.node.fund(s.from, 2n * GRAM);
    s.h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    const jetton = { standard: 'jetton', contract: MASTER };
    const before = s.h.node.served.length;
    // `jettonForwardAmount` is 1 nanogram: the attached value must pay for more than that.
    for (const attached of [0n, 1n]) {
      await expect(
        s.h.run(
          s.builder.estimateFee(
            s.intent({ asset: jetton, fee: { attached } }),
            s.build(),
          ),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    }
    expect(s.h.node.served.length).toBe(before);
    const fee = await s.h.run(
      s.builder.estimateFee(
        s.intent({ asset: jetton, fee: { attached: 2n } }),
        s.build(),
      ),
    );
    expect(fee.details).toMatchObject({ attached: 2n, forwardAmount: 1n });
  });

  it('assembles only with the right signature, into the only position it fits', async () => {
    const s = setup();
    s.h.node.fund(s.from, GRAM);
    const { unsigned } = await s.prepare(s.intent());
    await expect(s.builder.assemble(unsigned, [])).rejects.toMatchObject({
      code: 'SIGNING_FAILED',
    });
    await expect(
      s.builder.assemble(unsigned, [
        { requestId: REQUEST_ID, bytes: new Uint8Array(63) },
      ]),
    ).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
    const tampered = {
      ...unsigned,
      signingRequests: [{ ...unsigned.signingRequests[0]!, payload: new Uint8Array(32) }],
    };
    await expect(
      s.builder.assemble(tampered, [
        { requestId: REQUEST_ID, bytes: new Uint8Array(64) },
      ]),
    ).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
    for (const payload of [
      { encoding: 'base64' as const, data: 'bm90IGEgYm9j' },
      { encoding: 'hex' as const, data: unsigned.payload.data },
    ]) {
      await expect(
        s.builder.assemble({ ...unsigned, payload }, [
          { requestId: REQUEST_ID, bytes: new Uint8Array(64) },
        ]),
      ).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
    }
  });
});

describe('the TON builder: the signed message is exactly the intent', () => {
  it('sends the one native message to the recipient, with its value, bounce flag and memo', async () => {
    const s = setup();
    s.h.node.fund(s.from, 5n * GRAM);
    const cases: readonly (readonly [DriverOutput['variant'], boolean])[] = [
      [undefined, true],
      [{ bounceable: true }, true],
      [{ bounceable: false }, false],
    ];
    for (const [variant, bounce] of cases) {
      const i = s.intent({
        outputs: [{ to: FRESH, amount: 7n, ...(variant ? { variant } : {}) }],
        memo: 'order 1',
      });
      const fee = await s.h.run(s.builder.estimateFee(i, s.build()));
      const unsigned = await s.h.run(s.builder.build(i, fee, s.build()));
      const { dest, request, message, info } = decoded(unsigned.payload.data);
      expect(dest).toBe(s.from);
      expect(request).toMatchObject({
        auth: 'external',
        seqno: 0,
        validUntil: unsigned.ordering.kind === 'seqno' && unsigned.ordering.validUntil,
      });
      expect(request.messages).toHaveLength(1);
      expect(messageFacts(message)).toMatchObject({ to: FRESH, value: 7n });
      expect(info.bounce).toBe(bounce);
      expect(decodeComment(message.body)).toBe('order 1');
    }
  });

  it('sends the one jetton transfer to the attested jetton wallet, naming the recipient and amount', async () => {
    const s = setup('v5r1');
    s.h.node.fund(s.from, 2n * GRAM);
    s.h.node.deployWallet(s.from, {
      version: 'v5r1',
      publicKey: PK,
      walletId: WALLET_IDS.v5r1.testnet,
      seqno: 2,
    });
    s.h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    s.h.node.mintJetton(MASTER, s.from, 1_000n);
    const i = s.intent({
      asset: { standard: 'jetton', contract: MASTER },
      outputs: [{ to: FRESH, amount: 400n, variant: { bounceable: false } }],
      memo: 'order 9',
    });
    const fee = await s.h.run(s.builder.estimateFee(i, s.build(2n)));
    expect(fee.details).toMatchObject({ deploy: false });
    const unsigned = await s.h.run(s.builder.build(i, fee, s.build(2n)));
    const { request, message, info } = decoded(unsigned.payload.data);
    expect(request).toMatchObject({ auth: 'external', seqno: 2 });
    expect(messageFacts(message)).toMatchObject({
      to: s.h.node.jettonWalletOf(MASTER, s.from),
      value: 50_000_000n,
    });
    expect(info.bounce).toBe(true);
    expect(decodeJettonTransfer(message.body)).toEqual({
      queryId: 2n,
      amount: 400n,
      destination: FRESH,
      forwardAmount: 1n,
      comment: 'order 9',
    });
  });

  it('never returns a message the encoder got wrong for signing (native)', async () => {
    const s = setup();
    s.h.node.fund(s.from, 5n * GRAM);
    const i = s.intent({ memo: 'order 1' });
    const fee = await s.h.run(s.builder.estimateFee(i, s.build()));
    const original = messages.nativeMessage;
    type Encode = (args: Parameters<typeof original>[0]) => ReturnType<typeof original>;
    const tampers: readonly Encode[] = [
      (args) => original({ ...args, to: OTHER }),
      (args) => original({ ...args, value: args.value + 1n }),
      (args) => original({ ...args, bounce: !args.bounce }),
      (args) => original({ ...args, memo: 'order 2' }),
      ({ memo: _memo, ...args }) => original(args),
    ];
    const spy = jest.spyOn(messages, 'nativeMessage');
    try {
      for (const tamper of tampers) {
        spy.mockImplementation(tamper);
        await expect(s.h.run(s.builder.build(i, fee, s.build()))).rejects.toMatchObject({
          code: 'INVALID_INTENT',
          message: expect.stringContaining('does not match the intent'),
        });
      }
    } finally {
      spy.mockRestore();
    }
    await expect(s.h.run(s.builder.build(i, fee, s.build()))).resolves.toBeDefined();
  });

  it('never returns a message the encoder got wrong for signing (jetton)', async () => {
    const s = setup();
    s.h.node.fund(s.from, 2n * GRAM);
    s.h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    s.h.node.mintJetton(MASTER, s.from, 1_000n);
    const i = s.intent({
      asset: { standard: 'jetton', contract: MASTER },
      outputs: [{ to: FRESH, amount: 400n }],
      memo: 'order 9',
    });
    const fee = await s.h.run(s.builder.estimateFee(i, s.build()));
    const original = messages.jettonMessage;
    const spy = jest.spyOn(messages, 'jettonMessage');
    try {
      for (const tamper of [
        { jettonWallet: OTHER },
        { attached: 50_000_001n },
        { amount: 401n },
        { destination: OTHER },
        { responseDestination: OTHER },
        { forwardAmount: 2n },
        { queryId: 7n },
        { memo: 'order 8' },
      ]) {
        spy.mockImplementation((args) => original({ ...args, ...tamper }));
        await expect(s.h.run(s.builder.build(i, fee, s.build()))).rejects.toMatchObject({
          code: 'INVALID_INTENT',
          message: expect.stringContaining('does not match the intent'),
        });
      }
    } finally {
      spy.mockRestore();
    }
    await expect(s.h.run(s.builder.build(i, fee, s.build()))).resolves.toBeDefined();
  });

  it('refuses a fee estimate made for another transfer', async () => {
    const s = setup();
    s.h.node.fund(s.from, 2n * GRAM);
    s.h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    const jetton = s.intent({ asset: { standard: 'jetton', contract: MASTER } });
    const native = await s.h.run(s.builder.estimateFee(s.intent(), s.build()));
    const attached = await s.h.run(s.builder.estimateFee(jetton, s.build()));
    const before = s.h.node.served.length;
    for (const [i, fee] of [
      [jetton, native],
      [s.intent(), attached],
      [s.intent({ ...jetton, fee: { attached: 70_000_000n } }), attached],
      [s.intent(), { ...native, kind: 'evm' }],
    ] as const) {
      await expect(s.h.run(s.builder.build(i, fee, s.build()))).rejects.toMatchObject({
        code: 'INVALID_INTENT',
      });
    }
    expect(s.h.node.served.length).toBe(before);
  });
});

describe('the TON broadcaster', () => {
  it('rejects bytes that are no external message without sending them', async () => {
    const s = setup();
    const before = s.h.node.served.length;
    const notExternal = beginCell()
      .store(storeMessageRelaxed(internal({ to: FRESH, value: 1n })))
      .endCell()
      .toBoc()
      .toString('base64');
    for (const raw of [
      { encoding: 'base64' as const, data: 'bm90IGEgYm9j' },
      { encoding: 'hex' as const, data: 'ab' },
      { encoding: 'base64' as const, data: notExternal },
      // Lesson 20: refused from the header, never decoded.
      { encoding: 'base64' as const, data: `te6cc${'A'.repeat(100_000)}` },
    ]) {
      expect(
        await s.h.run(
          s.broadcaster.broadcast({
            raw,
            ref: { id: '', idKind: 'message-hash', canonical: false },
          }),
        ),
      ).toEqual({
        kind: 'rejected',
        reason: 'malformed message',
      });
    }
    expect(s.h.node.served.length).toBe(before);
  });

  it("rethrows toncenter's HTTP 500 refusal unclassified and ambiguous (D16)", async () => {
    const s = setup();
    s.h.node.fund(s.from, GRAM);
    // Deployed at seqno 0: a message at seqno 5 is refused when sent (33), as HTTP 500.
    s.h.node.deployWallet(s.from, {
      version: 'v4r2',
      publicKey: PK,
      walletId: WALLET_IDS.v4r2.basechain,
    });
    const { signed } = await s.prepare(s.intent(), s.build(5n));
    await expect(s.h.run(s.broadcaster.broadcast(signed))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      ambiguous: true,
    });
  });

  it("classifies a definitive 4xx answer from the chain's own text, passing fanout and signal through", async () => {
    const s = setup();
    s.h.node.fund(s.from, GRAM);
    const { signed } = await s.prepare(s.intent());
    const seen: unknown[] = [];
    const http = s.h.rpc.http.bind(s.h.rpc);
    s.h.rpc.http = ((request, options) => {
      seen.push({
        route: request.route,
        purpose: options?.purpose,
        retry: options?.retry,
        fanout: options?.fanout,
        signal: options?.signal !== undefined,
      });
      return http(request, options);
    }) as typeof s.h.rpc.http;
    // external-message.cpp's refusal, as a v2-compatible endpoint answers it with a 4xx.
    const refusal = `External message was not accepted: cannot run message on account: inbound external message rejected by transaction ${HEX}:\nexitcode=33, steps=13, gas_used=0`;
    s.h.node.intercept = onSend(() => nodeError(400, refusal));
    const signal = new AbortController().signal;
    expect(await s.h.run(s.broadcaster.broadcast(signed, { fanout: 2, signal }))).toEqual(
      {
        kind: 'refused',
        code: 'NONCE_CONFLICT',
        reason: 'seqno mismatch',
      },
    );
    expect(seen).toEqual([
      {
        route: '/sendBocReturnHash',
        purpose: 'broadcast',
        retry: 'ambiguous-on-failure',
        fanout: 2,
        signal: true,
      },
    ]);
    // The liteserver's prefixed text: the transport keeps 300 characters of the body.
    s.h.node.intercept = onSend(() =>
      nodeError(
        400,
        `LITE_SERVER_UNKNOWN: cannot apply external message to current state : ${refusal}`,
      ),
    );
    expect(await s.h.run(s.broadcaster.broadcast(signed))).toEqual({
      kind: 'refused',
      code: 'NONCE_CONFLICT',
      reason: 'seqno mismatch',
    });
    s.h.node.intercept = onSend(() =>
      nodeError(
        400,
        'LITE_SERVER_UNKNOWN: cannot send external message : duplicate message',
      ),
    );
    expect(await s.h.run(s.broadcaster.broadcast(signed))).toEqual({
      kind: 'already-known',
    });
    // The brief's invented texts are no answer the chain gives: a plain refusal.
    for (const text of [
      'External message was not accepted: exitcode=33',
      'duplicate external message',
    ]) {
      s.h.node.intercept = onSend(() => nodeError(400, text));
      expect(await s.h.run(s.broadcaster.broadcast(signed))).toEqual({
        kind: 'refused',
        code: 'TX_REFUSED',
        reason: 'refused by the node',
      });
    }
  });

  it('rethrows a "not now" node answer as retryable and ambiguous, never a refusal (F6-R10)', async () => {
    const s = setup();
    s.h.node.fund(s.from, GRAM);
    const { signed } = await s.prepare(s.intent());
    for (const text of [
      'LITE_SERVER_NOTREADY: not ready',
      'LITE_SERVER_UNKNOWN: cannot apply external message to current state : too many pending external message checks',
    ]) {
      s.h.node.intercept = onSend(() => nodeError(400, text));
      await expect(s.h.run(s.broadcaster.broadcast(signed))).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
        ambiguous: true,
      });
    }
  });

  it('rethrows 429, 408, 5xx and timeouts unclassified: the ambiguous path', async () => {
    type Reply = (signal: AbortSignal | undefined) => FakeReply | Promise<FakeReply>;
    const replies: readonly (readonly [Reply, Record<string, unknown>])[] = [
      // Never processed (R16): the transport says so, and nothing is classified.
      [() => nodeError(429, 'Ratelimit exceed'), { code: 'RATE_LIMITED' }],
      [
        () => nodeError(408, 'timeout'),
        { code: 'PROVIDER_UNAVAILABLE', ambiguous: true },
      ],
      [
        () => nodeError(503, 'LITE_SERVER_NOTREADY: not ready'),
        { code: 'PROVIDER_UNAVAILABLE', ambiguous: true },
      ],
      [(signal) => hang(signal), { code: 'TIMEOUT', ambiguous: true }],
    ];
    for (const [reply, expected] of replies) {
      // A fresh transport for each: a breaker opened by one case must not answer the next.
      const s = setup();
      s.h.node.fund(s.from, GRAM);
      const { signed } = await s.prepare(s.intent());
      s.h.node.intercept = (_e, route, _request, signal) =>
        route === '/sendBocReturnHash' ? reply(signal) : undefined;
      await expect(s.h.run(s.broadcaster.broadcast(signed))).rejects.toMatchObject(
        expected,
      );
      expect(s.h.node.served.some((r) => r.route === '/sendBocReturnHash')).toBe(true);
    }
  });

  it('never classifies a 4xx after an attempt that may have been delivered (D16)', async () => {
    const s = setup();
    s.h.node.fund(s.from, GRAM);
    const { signed } = await s.prepare(s.intent());
    // The first attempt may have reached the network (503); the retry's "duplicate" or
    // refusal then says nothing about the bytes the first one carried.
    for (const text of [
      'LITE_SERVER_UNKNOWN: cannot send external message : duplicate message',
      `External message was not accepted: cannot run message on account: inbound external message rejected by transaction ${HEX}:\nexitcode=33, steps=13, gas_used=0`,
    ]) {
      let sends = 0;
      s.h.node.intercept = onSend(() =>
        (sends += 1) === 1 ? nodeError(503, 'busy') : nodeError(400, text),
      );
      await expect(s.h.run(s.broadcaster.broadcast(signed))).rejects.toMatchObject({
        code: 'RPC_ERROR',
        ambiguous: true,
      });
      expect(sends).toBe(2);
    }
  });

  it('logs a node that reports another message hash by code only (D12)', async () => {
    const s = setup();
    s.h.node.fund(s.from, GRAM);
    const { signed } = await s.prepare(s.intent());
    const logged: [string, LogFields | undefined][] = [];
    const log = {
      ...noopLogger,
      warn: (m: string, f?: LogFields) => logged.push([m, f]),
    };
    const broadcaster = createTonBroadcaster({ ...s.h.ctx, log });
    const other = Buffer.alloc(32, 9).toString('base64');
    s.h.node.intercept = onSend(() => ({
      json: { ok: true, result: { hash: other, hash_norm: other } },
    }));
    expect(await s.h.run(broadcaster.broadcast(signed))).toEqual({ kind: 'accepted' });
    expect(logged).toEqual([
      [expect.not.stringMatching(/[0-9a-f]{64}/), { code: 'MESSAGE_HASH_MISMATCH' }],
    ]);
  });
});

describe('the TON builder: fees, chain time and jetton wallets', () => {
  it("counts each forward fee once: the emulation's, or the config's when it reports less (I3)", async () => {
    const s = setup();
    s.h.node.fund(s.from, 3n * GRAM);
    const params: (string | undefined)[] = [];
    const http = s.h.rpc.http.bind(s.h.rpc);
    s.h.rpc.http = ((request, options) => {
      if (request.route === '/getConfigParam') params.push(request.query?.param);
      return http(request, options);
    }) as typeof s.h.rpc.http;
    const i = s.intent({ memo: 'invoice 7' });
    const fee = await s.h.run(s.builder.estimateFee(i, s.build()));
    const details = fee.details as unknown as {
      importFee: bigint;
      gasFee: bigint;
      storageFee: bigint;
      forwardFee: bigint;
      forwardFeeSource: string;
    };
    expect(details.forwardFeeSource).toBe('emulated');
    expect(details.forwardFee).toBeGreaterThan(0n);
    expect(fee.charges).toEqual([
      {
        asset: 'native',
        label: 'network',
        amount:
          details.importFee + details.gasFee + details.storageFee + details.forwardFee,
      },
    ]);
    // An endpoint that reports less than the config's formula: the config's, still once.
    s.h.node.intercept = (_e, route) =>
      route === '/estimateFee'
        ? feesAnswer({ gas: NODE_FEES.gasV4, fwd: 1n })
        : undefined;
    const computed = await s.h.run(s.builder.estimateFee(i, s.build()));
    expect(computed.details).toMatchObject({
      forwardFee: details.forwardFee,
      forwardFeeSource: 'computed',
    });
    expect(computed.charges).toEqual([
      {
        asset: 'native',
        label: 'network',
        amount: NODE_FEES.importFee + NODE_FEES.gasV4 + details.forwardFee,
      },
    ]);
    // Basechain to basechain: config param 25.
    expect(params).toEqual(['25', '25']);
  });

  it('prices forward fees by config param 24 when the masterchain is involved (D13)', async () => {
    const s = setup();
    const params: (string | undefined)[] = [];
    const http = s.h.rpc.http.bind(s.h.rpc);
    s.h.rpc.http = ((request, options) => {
      if (request.route === '/getConfigParam') params.push(request.query?.param);
      return http(request, options);
    }) as typeof s.h.rpc.http;
    s.h.node.fund(s.from, 3n * GRAM);
    const toMaster = s.intent({ outputs: [{ to: `-1:${'33'.repeat(32)}`, amount: 1n }] });
    await s.h.run(s.builder.estimateFee(toMaster, s.build()));
    const mc = TEST_WALLETS.v4r2.masterchain;
    s.h.node.fund(mc, 3n * GRAM);
    const fromMaster = { ...s.intent(), from: mc };
    const fee = await s.h.run(
      s.builder.estimateFee(fromMaster, {
        ...s.build(0n, { ton: { version: 'v4r2', workchain: -1 } }),
        from: mc,
      }),
    );
    expect(fee.details).toMatchObject({ deploy: true, forwardFeeSource: 'emulated' });
    expect(params).toEqual(['24', '24']);
  });

  it('reads config params through the capped decoder; one that does not parse is retryable', async () => {
    const s = setup();
    s.h.node.fund(s.from, 3n * GRAM);
    const intercepts = [
      // A valid cell that holds no message prices (config param 19's).
      beginCell().storeInt(-3, 32).endCell().toBoc().toString('base64'),
      // A header that declares more cells than a message may hold (lesson 20).
      Buffer.from([0xb5, 0xee, 0x9c, 0x72, 0x02, 0x02, 0x40, 0x00]).toString('base64'),
    ];
    for (const bytes of intercepts) {
      s.h.node.intercept = (_e, route) =>
        route === '/getConfigParam'
          ? { json: { ok: true, result: { config: { bytes } } } }
          : undefined;
      await expect(
        s.h.run(s.builder.estimateFee(s.intent(), s.build())),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    }
  });

  it('refuses an emulation that did not run the transfer, never an expected draft (Task 6 review)', async () => {
    const s = setup();
    s.h.node.fund(s.from, 5n * GRAM);
    // Deploying with its `StateInit`: every emulation must run the wallet and its message.
    for (const answer of [
      { gas: 0n, fwd: 70_000n },
      { gas: NODE_FEES.gasV4, fwd: 0n },
      { gas: NODE_FEES.flatGas, fwd: 0n },
    ]) {
      s.h.node.intercept = (_e, route) =>
        route === '/estimateFee' ? feesAnswer(answer) : undefined;
      await expect(
        s.h.run(s.builder.estimateFee(s.intent(), s.build())),
      ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    }
    s.h.node.intercept = undefined;
    // Deployed: an endpoint that lags behind the deploy emulates no code (live: flat gas).
    const first = await s.prepare(s.intent());
    await s.h.run(s.broadcaster.broadcast(first.signed));
    s.h.node.mine(2);
    const lag = s.h.node.endpoint('lag', 'v2');
    s.h.node.lagEndpoint('lag', 2);
    s.h.node.intercept = (endpoint, route, request) =>
      endpoint === 'main' && route === '/estimateFee'
        ? s.h.node.fetch.fetch(`${lag}/estimateFee`, {
            method: 'POST',
            body: request.body ?? '',
          })
        : undefined;
    await expect(
      s.h.run(s.builder.estimateFee(s.intent(), s.build(1n))),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    s.h.node.intercept = undefined;
    expect(await s.h.run(s.builder.estimateFee(s.intent(), s.build(1n)))).toMatchObject({
      details: { deploy: false, gasFee: NODE_FEES.gasV4 },
    });
  });

  it('bounds the network fee an endpoint suggests by the policy maximum (economic ceiling)', async () => {
    const s = setup();
    s.h.node.fund(s.from, 3n * GRAM);
    const normal = await s.h.run(s.builder.estimateFee(s.intent(), s.build()));
    const fwd = (normal.details as { forwardFee: bigint }).forwardFee;
    const gasAt = (network: bigint) => network - NODE_FEES.importFee - fwd;
    s.h.node.intercept = (_e, route) =>
      route === '/estimateFee'
        ? feesAnswer({ gas: gasAt(MAX_NETWORK_FEE.basechain), fwd })
        : undefined;
    expect(
      (await s.h.run(s.builder.estimateFee(s.intent(), s.build()))).charges[0]?.amount,
    ).toBe(MAX_NETWORK_FEE.basechain);
    s.h.node.intercept = (_e, route) =>
      route === '/estimateFee'
        ? feesAnswer({ gas: gasAt(MAX_NETWORK_FEE.basechain + 1n), fwd })
        : undefined;
    await expect(
      s.h.run(s.builder.estimateFee(s.intent(), s.build())),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    // A masterchain wallet pays more for gas and storage: its own, higher ceiling.
    expect(MAX_NETWORK_FEE.masterchain).toBeGreaterThan(MAX_NETWORK_FEE.basechain);
  });

  it('refuses a chain time far from the local clock (M3)', async () => {
    const s = setup();
    s.h.node.fund(s.from, GRAM);
    const fee = await s.h.run(s.builder.estimateFee(s.intent(), s.build()));
    const skewed = (seconds: number) => {
      s.h.node.intercept = (_e, route, request) => {
        if (route !== '/getAddressInformation') return undefined;
        s.h.node.intercept = undefined;
        return s.h.node.fetch.fetch(request.url.href).then(async (response) => {
          const body = (await response.json()) as { result: { sync_utime: number } };
          body.result.sync_utime += seconds;
          return { json: body };
        }) as never;
      };
    };
    for (const seconds of [3_600, -(CHAIN_TIME_TOLERANCE + 1)]) {
      skewed(seconds);
      await expect(
        s.h.run(s.builder.build(s.intent(), fee, s.build())),
      ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
      skewed(seconds);
      await expect(
        s.h.run(s.builder.estimateFee(s.intent(), s.build())),
      ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    }
    // Within the tolerance, the lifetime runs from the endpoint's chain time.
    skewed(CHAIN_TIME_TOLERANCE - 1);
    const unsigned = await s.h.run(s.builder.build(s.intent(), fee, s.build()));
    expect(unsigned.ordering).toMatchObject({
      validUntil: Math.floor(s.h.clock.now() / 1000) + CHAIN_TIME_TOLERANCE - 1 + 60,
    });
  });

  it('estimates at the live seqno when none is allocated, and never builds without one', async () => {
    const s = setup();
    s.h.node.fund(s.from, 5n * GRAM);
    const first = await s.prepare(s.intent());
    await s.h.run(s.broadcaster.broadcast(first.signed));
    s.h.node.mine(2);
    const bodies: string[] = [];
    s.h.node.intercept = (_e, route, request) => {
      if (route === '/estimateFee') bodies.push(request.json<{ body: string }>().body);
      return undefined;
    };
    const { ordering: _ordering, ...unallocated } = s.build();
    await s.h.run(s.builder.estimateFee(s.intent(), unallocated));
    const body = Cell.fromBoc(Buffer.from(bodies[0]!, 'base64'))[0]!;
    expect(decodeWalletRequest(body)).toMatchObject({ seqno: 1 });
    await expect(
      s.h.run(s.builder.build(s.intent(), first.fee, unallocated)),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
  });

  it('sends jettons to the wallet the proof quorum named (I5)', async () => {
    const s = setup();
    s.h.node.fund(s.from, 2n * GRAM);
    s.h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    s.h.node.mintJetton(MASTER, s.from, 1_000n);
    const purposes: string[] = [];
    const http = s.h.rpc.http.bind(s.h.rpc);
    s.h.rpc.http = ((request, options) => {
      if (request.route === '/runGetMethod') purposes.push(String(options?.purpose));
      return http(request, options);
    }) as typeof s.h.rpc.http;
    const i = s.intent({
      asset: { standard: 'jetton', contract: MASTER },
      outputs: [{ to: FRESH, amount: 1n }],
    });
    await s.h.run(s.builder.estimateFee(i, s.build()));
    // The first `get_wallet_address` goes to the quorum; afterwards it is cached.
    expect(purposes[0]).toBe('proof');
    expect(s.h.ctx.jettonWallets.get(`${MASTER}|${s.from}`)).toBe(
      s.h.node.jettonWalletOf(MASTER, s.from),
    );
  });

  it('decides nothing while the proof quorum disagrees on the jetton wallet (I5)', async () => {
    const s = setup('v4r2', ['a', 'b']);
    s.h.node.fund(s.from, 2n * GRAM);
    s.h.node.deployJetton(MASTER, { symbol: 'TST', decimals: 6, content: 'onchain' });
    s.h.node.mintJetton(MASTER, s.from, 1_000n);
    s.h.node.intercept = (endpoint, route, request) =>
      endpoint === 'b' &&
      route === '/runGetMethod' &&
      request.json<{ method: string }>().method === 'get_wallet_address'
        ? {
            json: {
              ok: true,
              result: {
                exit_code: 0,
                stack: [['cell', { bytes: addressArgument(OTHER) }]],
              },
            },
          }
        : undefined;
    const i = s.intent({
      asset: { standard: 'jetton', contract: MASTER },
      outputs: [{ to: FRESH, amount: 1n }],
    });
    await expect(s.h.run(s.builder.estimateFee(i, s.build()))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    expect(s.h.ctx.jettonWallets.size).toBe(0);
    expect(s.h.node.served.some((r) => r.route === '/estimateFee')).toBe(false);
  });
});
