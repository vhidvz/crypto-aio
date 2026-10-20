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
import { GAS_PRICE_ORACLE, REVERTER } from './support/node';
import { KEY, KEY_ADDRESS, RECIPIENT } from './support/vectors';

const GWEI = 1_000_000_000n;
const TOKEN = '0x00000000000000000000000000000000000070Ce';
const tokenAsset = { standard: 'erc20', contract: TOKEN } as const;
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
      broadcaster: createEvmBroadcaster(h.client, h.ctx.config.chainId),
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

  it('adds the OP Stack operator fee for the whole gas limit as its own charge, which the funds check counts', async () => {
    const t = setup('base', 'sepolia', {
      l1Fee: 777n,
      operatorFee: { scalar: 3n, constant: 1_000n },
    });
    const asked: string[] = [];
    t.node.intercept = (_endpoint, method, params) => {
      if (method === 'eth_call') asked.push((params[0] as { data: string }).data);
      return undefined;
    };
    const operatorFee = (gas: bigint) => gas * 300n + 1_000n;
    const fee = await t.run(t.builder.estimateFee(intent(), t.build(5n)));
    expect(fee.charges).toEqual([
      { asset: 'native', amount: 21_000n * 4n * GWEI, label: 'network' },
      { asset: 'native', amount: 777n, label: 'l1-data' },
      { asset: 'native', amount: operatorFee(21_000n), label: 'operator' },
    ]);
    expect(fee).toMatchObject({
      bound: 'expected',
      details: {
        l1Fee: 777n,
        operatorFee: operatorFee(21_000n),
        expected: 21_000n * 3n * GWEI + 777n + operatorFee(21_000n),
      },
    });
    expect(asked).toContain(t.client.abi.encodeGetOperatorFee(21_000n));
    // A token transfer's is for its gas limit, the estimate with its headroom.
    t.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    t.node.mintToken(TOKEN, KEY_ADDRESS, 10n);
    const token = intent({
      asset: tokenAsset,
      outputs: [{ to: RECIPIENT, amount: 10n }],
    });
    expect((await t.run(t.builder.estimateFee(token, t.build()))).details).toMatchObject({
      gasLimit: 61_200n,
      operatorFee: operatorFee(61_200n),
    });
    // A wallet that covers the amount, the network and L1 fees, but not the operator fee.
    const costs = 21_000n * 4n * GWEI + 777n + operatorFee(21_000n);
    const short = intent({
      outputs: [{ to: RECIPIENT, amount: 10n ** 18n - costs + 1n }],
    });
    expect(await t.run(t.builder.checkFunds(short, fee, t.build()))).toEqual({
      ok: false,
      asset: 'native',
      required: 10n ** 18n + 1n,
      available: 10n ** 18n,
    });
    const exact = intent({ outputs: [{ to: RECIPIENT, amount: 10n ** 18n - costs }] });
    expect(await t.run(t.builder.checkFunds(exact, fee, t.build()))).toEqual({
      ok: true,
    });
  });

  it('charges no operator fee before Isthmus, at zero, or on an empty answer', async () => {
    // Before Isthmus the predeploy has no getOperatorFee: the call reverts.
    const before = setup('optimism', 'sepolia', { l1Fee: 777n });
    const fee = await before.run(before.builder.estimateFee(intent(), before.build()));
    expect(fee.charges.map((c) => c.label)).toEqual(['network', 'l1-data']);
    expect(fee.details).not.toHaveProperty('operatorFee');
    const zero = setup('base', 'sepolia', {
      l1Fee: 777n,
      operatorFee: { scalar: 0n, constant: 0n },
    });
    expect(
      (await zero.run(zero.builder.estimateFee(intent(), zero.build()))).charges.map(
        (c) => c.label,
      ),
    ).toEqual(['network', 'l1-data']);
    const getOperatorFee = zero.client.abi.encodeGetOperatorFee(0n).slice(0, 10);
    for (const answer of [
      { result: '0x' },
      { error: { code: 3, message: 'execution reverted' } },
      { error: { code: -32000, message: 'invalid opcode: INVALID' } },
    ]) {
      zero.node.intercept = (_endpoint, method, params) =>
        method === 'eth_call' &&
        (params[0] as { data: string }).data.startsWith(getOperatorFee)
          ? answer
          : undefined;
      const quiet = await zero.run(zero.builder.estimateFee(intent(), zero.build()));
      expect(quiet.charges.map((c) => c.label)).toEqual(['network', 'l1-data']);
    }
  });

  it('decides nothing on a failed operator fee read: the error stays retryable', async () => {
    const t = setup('base', 'sepolia', {
      l1Fee: 777n,
      operatorFee: { scalar: 3n, constant: 1_000n },
    });
    const getOperatorFee = t.client.abi.encodeGetOperatorFee(0n).slice(0, 10);
    const failing = (
      answer: { result: unknown } | { error: { code: number; message: string } },
    ) => {
      t.node.intercept = (_endpoint, method, params) =>
        method === 'eth_call' &&
        (params[0] as { data: string }).data.startsWith(getOperatorFee)
          ? answer
          : undefined;
      return t.run(t.builder.estimateFee(intent(), t.build()));
    };
    await expect(
      failing({ error: { code: -32000, message: 'header not found' } }),
    ).rejects.toMatchObject({ code: 'RPC_ERROR', retryable: true });
    await expect(failing({ result: '0x1234' })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      message: 'the operator fee oracle gave no fee',
    });
    await expect(failing({ result: 42 })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('recomputes the operator fee for the gas limit of a replacement and a cancel', async () => {
    const t = setup('base', 'sepolia', {
      l1Fee: 777n,
      operatorFee: { scalar: 3n, constant: 1_000n },
    });
    const policy = createEvmReplacement(t.ctx)!;
    const original = await t.prepare();
    await t.run(t.broadcaster.broadcast(await t.assemble(original)));
    const replacement = await t.run(
      policy.buildReplacement!(
        original,
        { maxFeePerGas: 7n * GWEI, maxPriorityFeePerGas: 3n * GWEI, gasLimit: 30_000n },
        t.build(),
      ),
    );
    expect(replacement.fee.charges).toContainEqual({
      asset: 'native',
      amount: 30_000n * 300n + 1_000n,
      label: 'operator',
    });
    const cancel = await t.run(policy.buildCancel!(replacement, t.build()));
    expect(cancel.fee).toMatchObject({
      bound: 'expected',
      details: { gasLimit: 21_000n, operatorFee: 21_000n * 300n + 1_000n },
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

  // The core adds `fee.details.requestedFee` after `build`; a driver reads only its named
  // fee fields and never writes that one.
  it('replaces and cancels on the same nonce under the network bump, and ignores requestedFee', async () => {
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
    // Ranked by price, not by the charges a larger gas limit inflates.
    expect(policy.comparePrice!(replacement, original)).toBe(1);
    expect(policy.comparePrice!(original, replacement)).toBe(-1);
    expect(policy.comparePrice!(replacement, replacement)).toBe(0);
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

  it('classifies estimate failures before signing, and rethrows transient ones', async () => {
    const t = setup();
    t.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    t.node.mintToken(TOKEN, KEY_ADDRESS, 10n);
    const token = (amount: bigint) =>
      intent({ asset: tokenAsset, outputs: [{ to: RECIPIENT, amount }] });
    const estimateAnswers = (error: { code: number; message: string }) => {
      t.node.intercept = (_endpoint, method) =>
        method === 'eth_estimateGas' ? { error } : undefined;
    };
    // VM execution failures and an exhausted gas allowance fail like a revert.
    for (const message of [
      'invalid opcode: INVALID',
      'out of gas',
      'gas required exceeds allowance (30000000)',
    ]) {
      estimateAnswers({ code: -32000, message });
      await expect(
        t.run(t.builder.estimateFee(intent(), t.build())),
      ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
      // An old token's `assert` shortfall is an invalid opcode: the balance still decides.
      await expect(
        t.run(t.builder.estimateFee(token(11n), t.build())),
      ).rejects.toMatchObject({
        code: 'INSUFFICIENT_FUNDS',
        details: { required: '11', available: '10' },
      });
    }
    // A token revert that says "insufficient funds" is a revert first.
    estimateAnswers({ code: 3, message: 'execution reverted: insufficient funds' });
    await expect(
      t.run(t.builder.estimateFee(token(11n), t.build())),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      details: { required: '11', available: '10' },
    });
    await expect(
      t.run(t.builder.estimateFee(token(10n), t.build())),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    // Anything else is the provider's, rethrown unchanged.
    estimateAnswers({ code: -32000, message: 'header not found' });
    await expect(t.run(t.builder.estimateFee(intent(), t.build()))).rejects.toMatchObject(
      {
        code: 'RPC_ERROR',
        details: { rpcMessage: 'header not found' },
      },
    );
    estimateAnswers({ code: -32005, message: 'rate limit exceeded' });
    await expect(t.run(t.builder.estimateFee(intent(), t.build()))).rejects.toMatchObject(
      { code: 'RATE_LIMITED', retryable: true },
    );
  });

  it('refuses a token whose contract answers deprecated() true, with a fixed text, before the gas estimate', async () => {
    const t = setup();
    // Tether's TetherToken once deprecated: its transfer would forward and estimate fine.
    t.node.deployToken(TOKEN, { symbol: 'USDT', decimals: 6, deprecated: true });
    t.node.mintToken(TOKEN, KEY_ADDRESS, 10n);
    const deprecated = {
      code: 'ASSET_RESOLUTION',
      retryable: false,
      message:
        'the token contract is deprecated in favour of an upgraded contract; the asset must be re-registered at the upgraded contract',
    };
    const transfer = (fee: DriverIntent['fee'] = 'normal') =>
      intent({ asset: tokenAsset, outputs: [{ to: RECIPIENT, amount: 10n }], fee });
    await expect(
      t.run(t.builder.estimateFee(transfer(), t.build())),
    ).rejects.toMatchObject(deprecated);
    // One `deprecated()` read at `latest`, one endpoint's, as the other token reads.
    expect(t.calls.map((c) => [c.method, c.tags])).toEqual([
      ['feeHistory', { purpose: 'read', retry: 'safe' }],
      ['call', { purpose: 'read', retry: 'safe' }],
    ]);
    expect(t.node.served.map((s) => s.method)).not.toContain('eth_estimateGas');
    // An explicit gas limit skips the estimate, never the guard.
    const explicit = {
      maxFeePerGas: 4n * GWEI,
      maxPriorityFeePerGas: GWEI,
      gasLimit: 70_000n,
    };
    await expect(
      t.run(t.builder.estimateFee(transfer(explicit), t.build())),
    ).rejects.toMatchObject(deprecated);
    // The same contract while live answers false and builds as any token.
    const live = setup();
    live.node.deployToken(TOKEN, { symbol: 'USDT', decimals: 6, deprecated: false });
    live.node.mintToken(TOKEN, KEY_ADDRESS, 10n);
    const unsigned = await live.prepare(transfer());
    expect(unsigned.fee.details).toMatchObject({ gasLimit: 61_200n });
  });

  it('reads every deprecated() answer but an ABI true as not deprecated', async () => {
    const t = setup();
    t.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    t.node.mintToken(TOKEN, KEY_ADDRESS, 10n);
    const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
    const answers = [
      { result: word(0n) },
      { error: { code: 3, message: 'execution reverted' } },
      { error: { code: -32000, message: 'execution reverted' } },
      { error: { code: -32000, message: 'invalid opcode: INVALID' } },
      // No code at the address, or a fallback that returns nothing.
      { result: '0x' },
      { result: word(2n) },
      { result: `${word(1n)}${'00'.repeat(32)}` },
      { result: '0x01' },
    ];
    for (const answer of answers) {
      t.node.intercept = (_endpoint, method, params) =>
        method === 'eth_call' &&
        (params[0] as { data?: string }).data === t.client.abi.encodeDeprecated()
          ? answer
          : undefined;
      const fee = await t.run(
        t.builder.estimateFee(
          intent({ asset: tokenAsset, outputs: [{ to: RECIPIENT, amount: 10n }] }),
          t.build(),
        ),
      );
      expect(fee.details).toMatchObject({ gasLimit: 61_200n });
    }
  });

  it('decides nothing on a failed deprecated() read: the error stays retryable', async () => {
    const t = setup();
    t.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    t.node.mintToken(TOKEN, KEY_ADDRESS, 10n);
    const failing = (
      answer: { result: unknown } | { error: { code: number; message: string } },
    ) => {
      t.node.intercept = (_endpoint, method, params) =>
        method === 'eth_call' &&
        (params[0] as { data?: string }).data === t.client.abi.encodeDeprecated()
          ? answer
          : undefined;
      return t.run(
        t.builder.estimateFee(
          intent({ asset: tokenAsset, outputs: [{ to: RECIPIENT, amount: 10n }] }),
          t.build(),
        ),
      );
    };
    // The node's own error, never the token's answer.
    await expect(
      failing({ error: { code: -32000, message: 'header not found' } }),
    ).rejects.toMatchObject({ code: 'RPC_ERROR', retryable: true });
    await expect(failing({ result: 42 })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    expect(t.node.served.map((s) => s.method)).not.toContain('eth_estimateGas');
  });

  it('refuses a signing digest that is not the payload digest', async () => {
    const t = setup();
    const unsigned = await t.prepare();
    const [request] = unsigned.signingRequests;
    const forged: UnsignedTx = {
      ...unsigned,
      signingRequests: [{ ...request!, payload: new Uint8Array(32).fill(1) }],
    };
    await expect(
      t.run(t.builder.assemble(forged, await signWithKey(forged))),
    ).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
  });

  it('uses an explicit replacement or cancel fee above the bump exactly as given', async () => {
    const t = setup();
    const policy = createEvmReplacement(t.ctx)!;
    const original = await t.prepare();
    await t.run(t.broadcaster.broadcast(await t.assemble(original)));
    const replacement = await t.run(
      policy.buildReplacement!(
        original,
        { maxFeePerGas: 7n * GWEI, maxPriorityFeePerGas: 3n * GWEI, gasLimit: 25_000n },
        t.build(),
      ),
    );
    expect(replacement.fee).toEqual({
      kind: 'evm-1559',
      speed: 'custom',
      charges: [{ asset: 'native', amount: 25_000n * 7n * GWEI, label: 'network' }],
      bound: 'upper',
      details: {
        gasLimit: 25_000n,
        maxFeePerGas: 7n * GWEI,
        maxPriorityFeePerGas: 3n * GWEI,
        expected: 25_000n * 7n * GWEI,
      },
    });
    expect(await t.run(t.broadcaster.broadcast(await t.assemble(replacement)))).toEqual({
      kind: 'accepted',
    });
    const cancel = await t.run(
      policy.buildCancel!(replacement, t.build(), {
        maxFeePerGas: 8n * GWEI,
        maxPriorityFeePerGas: 4n * GWEI,
      }),
    );
    expect(cancel.fee).toMatchObject({
      speed: 'custom',
      details: {
        gasLimit: 21_000n,
        maxFeePerGas: 8n * GWEI,
        maxPriorityFeePerGas: 4n * GWEI,
      },
    });
    expect(await t.run(t.broadcaster.broadcast(await t.assemble(cancel)))).toEqual({
      kind: 'accepted',
    });
  });

  it('replaces an ERC-20 transfer through assemble, keeping its call and gas limit', async () => {
    const t = setup();
    t.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    t.node.mintToken(TOKEN, KEY_ADDRESS, 10n);
    const policy = createEvmReplacement(t.ctx)!;
    const original = await t.prepare(
      intent({ asset: tokenAsset, outputs: [{ to: RECIPIENT, amount: 10n }] }),
    );
    const first = await t.assemble(original);
    await t.run(t.broadcaster.broadcast(first));
    const replacement = await t.run(
      policy.buildReplacement!(original, 'fast', t.build()),
    );
    expect(replacement.summary).toEqual(original.summary);
    expect(replacement.fee.details).toMatchObject({ gasLimit: 61_200n });
    const replaced = await t.assemble(replacement);
    expect(await t.run(t.broadcaster.broadcast(replaced))).toEqual({ kind: 'accepted' });
    t.node.mine();
    expect(t.node.receipt(replaced.ref.id)?.status).toBe(1);
    expect(t.node.receipt(first.ref.id)).toBeUndefined();
    expect(t.node.tokenBalance(TOKEN, RECIPIENT)).toBe(10n);
  });

  it('recomputes the OP Stack L1 data fee for the bytes of a replacement and a cancel', async () => {
    const t = setup('base', 'sepolia', { l1Fee: 777n });
    const policy = createEvmReplacement(t.ctx)!;
    const original = await t.prepare();
    await t.run(t.broadcaster.broadcast(await t.assemble(original)));
    const asked: string[] = [];
    const getL1Fee = t.client.abi.encodeGetL1Fee('0x').slice(0, 10);
    t.node.intercept = (_endpoint, method, params) => {
      const call = params[0] as { to?: string; data?: string };
      if (
        method !== 'eth_call' ||
        call.to?.toLowerCase() !== GAS_PRICE_ORACLE.toLowerCase() ||
        !call.data?.startsWith(getL1Fee)
      )
        return undefined;
      asked.push(call.data ?? '');
      return { result: `0x${888n.toString(16).padStart(64, '0')}` };
    };
    const replacement = await t.run(
      policy.buildReplacement!(original, 'fast', t.build()),
    );
    const cancel = await t.run(policy.buildCancel!(replacement, t.build()));
    for (const built of [replacement, cancel]) {
      expect(built.fee).toMatchObject({
        bound: 'expected',
        charges: [
          { label: 'network' },
          { asset: 'native', amount: 888n, label: 'l1-data' },
        ],
        details: { l1Fee: 888n },
      });
    }
    expect(asked).toEqual([
      t.client.abi.encodeGetL1Fee(replacement.payload.data),
      t.client.abi.encodeGetL1Fee(cancel.payload.data),
    ]);
  });

  it('replaces and cancels on a legacy network, naming the gas price', async () => {
    const t = setup('bsc', 'testnet');
    const policy = createEvmReplacement(t.ctx)!;
    const original = await t.prepare();
    await t.run(t.broadcaster.broadcast(await t.assemble(original)));
    const refusal = t.run(policy.buildReplacement!(original, 'normal', t.build()));
    await expect(refusal).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    await expect(refusal).rejects.toThrow(
      'a replacement must raise the gas price by at least 10%',
    );
    const replacement = await t.run(
      policy.buildReplacement!(original, 'fast', t.build()),
    );
    expect(replacement.fee.details).toEqual({
      gasLimit: 21_000n,
      gasPrice: 6_250_000_000n,
      expected: 21_000n * 6_250_000_000n,
    });
    expect(await t.run(t.broadcaster.broadcast(await t.assemble(replacement)))).toEqual({
      kind: 'accepted',
    });
    const cancel = await t.run(policy.buildCancel!(replacement, t.build()));
    expect(cancel.fee.details).toMatchObject({
      gasLimit: 21_000n,
      gasPrice: 6_875_000_000n,
    });
    const cancelled = await t.assemble(cancel);
    expect(await t.run(t.broadcaster.broadcast(cancelled))).toEqual({ kind: 'accepted' });
    t.node.mine();
    expect(t.node.receipt(cancelled.ref.id)?.status).toBe(1);
    expect(t.node.balance(RECIPIENT)).toBe(0n);
  });
});

describe('EVM broadcaster', () => {
  const signed: SignedTx = {
    raw: { encoding: 'hex', data: '0x01' },
    ref: { id: '', idKind: 'tx-hash', canonical: true },
  };
  const stub = (send: (tags: EvmCallTags) => Promise<string>) =>
    createEvmBroadcaster(
      {
        sendRawTransaction: (_raw: string, tags: EvmCallTags) => send(tags),
      } as unknown as EvmClient,
      11_155_111n,
    );

  it('sends with broadcast tags, passing fanout and signal through', async () => {
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

  it('classifies only a definitive RPC_ERROR and rethrows every other failure', async () => {
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
