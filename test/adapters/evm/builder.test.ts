import { Wallet } from 'ethers';
import {
  createEvmBroadcaster,
  createEvmBuilder,
  createEvmReplacement,
} from '../../../src/adapters/evm/builder';
import type { EvmCallTags, EvmClient } from '../../../src/adapters/evm/types';
import { ProviderError } from '../../../src/core/errors/error';
import type { DriverIntent } from '../../../src/core/model/intent';
import type { SignedTx, UnsignedTx } from '../../../src/core/model/transaction';
import { LIBRARIES } from './support/harness';
import { evmHarness } from './support/context';
import { signWithKey } from './support/signing';
import { REVERTER } from './support/node';
import { KEY, KEY_ADDRESS, RECIPIENT } from './support/vectors';

const GWEI = 1_000_000_000n;
const TOKEN = '0x00000000000000000000000000000000000070Ce';
const intent = (extra: Partial<DriverIntent> = {}): DriverIntent => ({
  asset: 'native',
  outputs: [{ to: RECIPIENT, amount: 1_000n }],
  from: KEY_ADDRESS,
  fee: 'normal',
  ...extra,
});

describe.each(LIBRARIES)('EVM builder (%s)', (library) => {
  function setup(chain = 'ethereum', network = 'sepolia', node = {}) {
    const h = evmHarness(library, chain, network, { node });
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    const builder = createEvmBuilder(h.ctx);
    const build = (nonce: bigint | null = 0n) => ({
      from: KEY_ADDRESS,
      keys: h.keys,
      wallet: {},
      ...(nonce !== null ? { ordering: { kind: 'nonce' as const, nonce } } : {}),
    });
    const prepare = async (i = intent(), nonce = 0n) => {
      const fee = await h.run(builder.estimateFee(i, build(nonce)));
      return h.run(builder.build(i, fee, build(nonce)));
    };
    const assemble = async (unsigned: UnsignedTx) =>
      h.run(builder.assemble(unsigned, await signWithKey(unsigned)));
    return {
      ...h,
      builder,
      build,
      prepare,
      assemble,
      broadcaster: createEvmBroadcaster(h.client),
    };
  }

  it('estimates EIP-1559 fees from the fee history, with read tags', async () => {
    const t = setup();
    const fee = await t.run(t.builder.estimateFee(intent(), t.build()));
    expect(fee).toEqual({
      kind: 'evm-1559',
      speed: 'normal',
      charges: [{ asset: 'native', amount: 21_000n * 4n * GWEI, label: 'network' }],
      bound: 'upper',
      details: {
        gasLimit: 21_000n,
        maxFeePerGas: 4n * GWEI,
        maxPriorityFeePerGas: 2n * GWEI,
        baseFeePerGas: GWEI,
        expected: 21_000n * 3n * GWEI,
      },
    });
    expect(t.calls.map((c) => [c.method, c.tags.purpose])).toEqual([
      ['feeHistory', 'read'],
      ['estimateGas', 'read'],
    ]);
    const polygon = setup('polygon', 'mainnet');
    expect(
      (await polygon.run(polygon.builder.estimateFee(intent(), polygon.build()))).details,
    ).toMatchObject({ maxPriorityFeePerGas: 25n * GWEI });
  });

  it('prices legacy networks from eth_gasPrice and takes explicit overrides', async () => {
    const t = setup('bsc', 'testnet');
    expect(
      (await t.run(t.builder.estimateFee(intent({ fee: 'fast' }), t.build()))).details,
    ).toEqual({
      gasLimit: 21_000n,
      gasPrice: 6_250_000_000n,
      expected: 21_000n * 6_250_000_000n,
    });
    t.calls.length = 0;
    const custom = await t.run(
      t.builder.estimateFee(
        intent({ fee: { gasPrice: 7n, gasLimit: 30_000n } }),
        t.build(),
      ),
    );
    expect(custom).toMatchObject({
      kind: 'evm-legacy',
      speed: 'custom',
      details: { gasLimit: 30_000n, gasPrice: 7n },
    });
    expect(t.calls).toEqual([]);
    await expect(
      t.run(
        t.builder.estimateFee(
          intent({ fee: { maxFeePerGas: 9n, maxPriorityFeePerGas: 1n } }),
          t.build(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
  });

  it('adds the OP Stack L1 data fee as its own charge, for the exact unsigned bytes', async () => {
    const t = setup('base', 'sepolia', { l1Fee: 777n });
    const fee = await t.run(t.builder.estimateFee(intent(), t.build(5n)));
    expect(fee.charges).toEqual([
      { asset: 'native', amount: 21_000n * 4n * GWEI, label: 'network' },
      { asset: 'native', amount: 777n, label: 'l1-data' },
    ]);
    expect(fee).toMatchObject({
      bound: 'expected',
      details: { l1Fee: 777n, expected: 21_000n * 3n * GWEI + 777n },
    });
  });

  it('turns shortfalls and reverts into pre-signing failures', async () => {
    const t = setup();
    t.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    t.node.mintToken(TOKEN, KEY_ADDRESS, 10n);
    const token = (amount: bigint) =>
      intent({
        asset: { standard: 'erc20', contract: TOKEN },
        outputs: [{ to: RECIPIENT, amount }],
      });
    expect(
      (await t.run(t.builder.estimateFee(token(10n), t.build()))).details,
    ).toMatchObject({ gasLimit: 61_200n });
    await expect(
      t.run(t.builder.estimateFee(token(11n), t.build())),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      details: { required: '11', available: '10' },
    });
    await expect(
      t.run(
        t.builder.estimateFee(
          intent({ outputs: [{ to: RECIPIENT, amount: 10n ** 19n }] }),
          t.build(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    await expect(
      t.run(
        t.builder.estimateFee(
          intent({ outputs: [{ to: REVERTER, amount: 1n }] }),
          t.build(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    const fee = await t.run(t.builder.estimateFee(token(10n), t.build()));
    expect(await t.run(t.builder.checkFunds(token(10n), fee, t.build()))).toEqual({
      ok: true,
    });
    expect(await t.run(t.builder.checkFunds(token(11n), fee, t.build()))).toEqual({
      ok: false,
      asset: { standard: 'erc20', contract: TOKEN },
      required: 11n,
      available: 10n,
    });
    const poor = intent({ outputs: [{ to: RECIPIENT, amount: 10n ** 18n }] });
    expect(await t.run(t.builder.checkFunds(poor, fee, t.build()))).toEqual({
      ok: false,
      asset: 'native',
      required: 10n ** 18n + 61_200n * 4n * GWEI,
      available: 10n ** 18n,
    });
  });

  it('refuses intents an EVM transfer cannot express', async () => {
    const t = setup();
    const fee = await t.run(t.builder.estimateFee(intent(), t.build()));
    await expect(
      t.run(t.builder.build(intent({ memo: 'hi' }), fee, t.build())),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(
      t.run(
        t.builder.build(
          intent({
            outputs: [
              { to: RECIPIENT, amount: 1n },
              { to: RECIPIENT, amount: 2n },
            ],
          }),
          fee,
          t.build(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    await expect(
      t.run(t.builder.build(intent(), fee, t.build(null))),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(
      t.run(t.builder.build(intent(), fee, { ...t.build(), keys: [] })),
    ).rejects.toMatchObject({ code: 'SIGNER_UNAVAILABLE' });
    await expect(
      t.run(
        t.builder.build(
          intent(),
          { ...fee, details: { gasLimit: 21_000n, gasPrice: 1n } },
          t.build(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
  });

  it('builds, assembles and broadcasts bytes identical to the SDK wallet', async () => {
    const t = setup();
    const unsigned = await t.prepare(intent(), 3n);
    expect(unsigned).toMatchObject({
      payload: { encoding: 'hex' },
      ordering: { kind: 'nonce', nonce: 3n },
      summary: {
        asset: 'ethereum:sepolia/native',
        outputs: [{ to: RECIPIENT, amount: '1000' }],
      },
    });
    expect(unsigned.signingRequests).toEqual([
      expect.objectContaining({
        id: 'r0',
        scheme: 'secp256k1-ecdsa',
        payloadKind: 'digest',
      }),
    ]);
    const signed = await t.assemble(unsigned);
    const wallet = await new Wallet(`0x${KEY}`).signTransaction({
      type: 2,
      chainId: 11155111n,
      nonce: 3,
      to: RECIPIENT,
      value: 1_000n,
      gasLimit: 21_000n,
      maxFeePerGas: 4n * GWEI,
      maxPriorityFeePerGas: 2n * GWEI,
    });
    expect(signed.raw).toEqual({ encoding: 'hex', data: wallet });
    const first = await t.assemble(await t.prepare(intent(), 0n));
    expect(await t.run(t.broadcaster.broadcast(first))).toEqual({ kind: 'accepted' });
    expect(t.node.inMempool(first.ref.id)).toBe(true);
    await expect(
      t.run(
        t.builder.assemble(
          {
            ...unsigned,
            payload: { encoding: 'hex', data: `${unsigned.payload.data}00` },
          },
          await signWithKey(unsigned),
        ),
      ),
    ).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
    await expect(t.run(t.builder.assemble(unsigned, []))).rejects.toMatchObject({
      code: 'SIGNING_FAILED',
    });
  });

  it('classifies node answers, with fixed reasons that name no address', async () => {
    const t = setup();
    const first = await t.assemble(await t.prepare());
    await t.run(t.broadcaster.broadcast(first));
    expect(await t.run(t.broadcaster.broadcast(first))).toEqual({
      kind: 'already-known',
    });
    t.node.mine();
    const again = await t.assemble(
      await t.prepare(intent({ outputs: [{ to: RECIPIENT, amount: 5n }] }), 0n),
    );
    expect(await t.run(t.broadcaster.broadcast(again))).toEqual({
      kind: 'refused',
      code: 'NONCE_CONFLICT',
      reason: 'nonce too low',
    });
    const rich = await t.assemble(
      await t.prepare(
        intent({ outputs: [{ to: RECIPIENT, amount: 5n * 10n ** 17n }] }),
        1n,
      ),
    );
    t.node.fund(KEY_ADDRESS, -(t.node.balance(KEY_ADDRESS) - 1n));
    expect(await t.run(t.broadcaster.broadcast(rich))).toEqual({
      kind: 'refused',
      code: 'INSUFFICIENT_FUNDS',
      reason: 'insufficient funds',
    });
    const other = setup('ethereum', 'hoodi');
    expect(await other.run(other.broadcaster.broadcast(first))).toEqual({
      kind: 'rejected',
      reason: 'wrong chain id',
    });
    other.node.fetch.route('https://main.evm.test/rpc', () => ({
      status: 503,
      text: 'down',
    }));
    await expect(other.run(other.broadcaster.broadcast(first))).rejects.toMatchObject({
      ambiguous: true,
    });
  });

  it('replaces and cancels on the same nonce under the network bump, and ignores requestedFee (R30)', async () => {
    const t = setup();
    const policy = createEvmReplacement(t.ctx)!;
    expect([policy.replace, policy.cancel]).toEqual([true, true]);
    const original = await t.prepare();
    await t.run(t.broadcaster.broadcast(await t.assemble(original)));
    const previous = {
      ...original,
      fee: {
        ...original.fee,
        details: { ...original.fee.details, requestedFee: 'normal' },
      },
    };
    await expect(
      t.run(policy.buildReplacement!(previous, 'normal', t.build())),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const replacement = await t.run(
      policy.buildReplacement!(previous, 'fast', t.build()),
    );
    expect(replacement.ordering).toEqual({ kind: 'nonce', nonce: 0n });
    expect(replacement.summary).toEqual(original.summary);
    expect(replacement.fee.details).not.toHaveProperty('requestedFee');
    expect(await t.run(t.broadcaster.broadcast(await t.assemble(replacement)))).toEqual({
      kind: 'accepted',
    });
    const cancel = await t.run(policy.buildCancel!(replacement, t.build()));
    expect(cancel.summary).toEqual({
      asset: 'ethereum:sepolia/native',
      outputs: [{ to: KEY_ADDRESS, amount: '0' }],
    });
    expect(cancel.fee.details).toMatchObject({
      gasLimit: 21_000n,
      maxFeePerGas: 5_500_000_000n,
      maxPriorityFeePerGas: 3_300_000_000n,
    });
    const cancelled = await t.assemble(cancel);
    expect(await t.run(t.broadcaster.broadcast(cancelled))).toEqual({ kind: 'accepted' });
    await expect(
      t.run(
        policy.buildCancel!(cancel, t.build(), {
          maxFeePerGas: 5_500_000_001n,
          maxPriorityFeePerGas: 3_630_000_000n,
        }),
      ),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    await expect(
      t.run(policy.buildCancel!(cancel, t.build(), 'fast')),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    t.node.mine();
    expect(t.node.receipt(cancelled.ref.id)?.status).toBe(1);
    expect(t.node.balance(RECIPIENT)).toBe(0n);
    expect(
      createEvmReplacement(evmHarness(library, 'arbitrum', 'sepolia').ctx),
    ).toBeUndefined();
  });
});

describe('EVM broadcaster', () => {
  const signed: SignedTx = {
    raw: { encoding: 'hex', data: '0x01' },
    ref: { id: '', idKind: 'tx-hash', canonical: true },
  };
  const stub = (send: (tags: EvmCallTags) => Promise<string>) =>
    createEvmBroadcaster({
      sendRawTransaction: (_raw: string, tags: EvmCallTags) => send(tags),
    } as unknown as EvmClient);

  it('sends with broadcast tags, passing fanout and signal through (R41)', async () => {
    const seen: EvmCallTags[] = [];
    const broadcaster = stub(async (tags) => {
      seen.push(tags);
      return '0x';
    });
    const signal = new AbortController().signal;
    await broadcaster.broadcast(signed);
    await broadcaster.broadcast(signed, { fanout: 3, signal });
    expect(seen).toEqual([
      { purpose: 'broadcast', retry: 'ambiguous-on-failure' },
      { purpose: 'broadcast', retry: 'ambiguous-on-failure', fanout: 3, signal },
    ]);
    expect(seen[1]?.signal).toBe(signal);
  });

  it('classifies only a definitive RPC_ERROR and rethrows every other failure (R17)', async () => {
    const rpc = (ambiguous: boolean) =>
      new ProviderError('RPC_ERROR', 'eth_sendRawTransaction failed', {
        details: { rpcCode: -32000, rpcMessage: 'nonce too low' },
        ambiguous,
      });
    const failures: unknown[] = [
      rpc(true),
      new ProviderError('PROVIDER_MISCONFIGURED', 'unauthorized'),
      new Error('foreign'),
    ];
    expect(await stub(() => Promise.reject(rpc(false))).broadcast(signed)).toEqual({
      kind: 'refused',
      code: 'NONCE_CONFLICT',
      reason: 'nonce too low',
    });
    for (const failure of failures) {
      await expect(stub(() => Promise.reject(failure)).broadcast(signed)).rejects.toBe(
        failure,
      );
    }
  });
});
