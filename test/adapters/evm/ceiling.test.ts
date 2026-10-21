import { EVM_CHAINS } from '../../../src/adapters/evm/chains';
import {
  createEvmBroadcaster,
  createEvmBuilder,
  createEvmReplacement,
} from '../../../src/adapters/evm/builder';
import {
  DEFAULT_MAX_FEE_PER_GAS,
  DEFAULT_MAX_GAS_LIMIT,
  assertWithinCeiling,
  assertWithinGasLimit,
  capPrice,
  feeDraft,
} from '../../../src/adapters/evm/fees';
import { evmNetworkConfig } from '../../../src/adapters/evm/network';
import { readSentTx } from '../../../src/adapters/evm/rawtx';
import type { ChainInfo, NetworkInfo } from '../../../src/core/model/chain';
import type { DriverIntent } from '../../../src/core/model/intent';
import { evmHarness } from './support/context';
import { countingSigner, createEvmEnv } from './support/env';
import { LIBRARIES } from './support/harness';
import { signWithKey } from './support/signing';
import { KEY_ADDRESS, RECIPIENT } from './support/vectors';

const GWEI = 1_000_000_000n;
const ethereum = EVM_CHAINS.find((c) => c.id === 'ethereum') as ChainInfo;
const sepolia = ethereum.networks.sepolia as NetworkInfo;
const PASTED = 'pasted-Zk8sQ2xVw9LmN4pR7tY1uE3iO6aS5dF0';

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

describe('the EVM fee ceiling, maxFeePerGas', () => {
  it('takes the handle option, else the network params, else 1,000 gwei', () => {
    expect(DEFAULT_MAX_FEE_PER_GAS).toBe(1_000n * GWEI);
    expect(evmNetworkConfig(ethereum, sepolia).maxFeePerGas).toBe(1_000n * GWEI);
    const own: NetworkInfo = { ...sepolia, params: { maxFeePerGas: 50n * GWEI } };
    expect(evmNetworkConfig(ethereum, own).maxFeePerGas).toBe(50n * GWEI);
    expect(
      evmNetworkConfig(ethereum, own, { maxFeePerGas: 7n * GWEI }).maxFeePerGas,
    ).toBe(7n * GWEI);
  });

  it('refuses a bad ceiling, and any other option key without echoing it', () => {
    for (const value of [0n, -1n, 2n ** 256n, 5, '1000', null]) {
      expect(
        thrown(() => evmNetworkConfig(ethereum, sepolia, { maxFeePerGas: value })),
      ).toMatchObject({
        code: 'CONFIG_INVALID',
        message:
          'EVM network ethereum:sepolia: maxFeePerGas must be a bigint of wei per gas from 1 to 2^256 − 1',
      });
    }
    // A network value is checked even where the option overrides it.
    const bad: NetworkInfo = { ...sepolia, params: { maxFeePerGas: 0n } };
    expect(
      thrown(() => evmNetworkConfig(ethereum, bad, { maxFeePerGas: GWEI })),
    ).toMatchObject({ message: expect.stringContaining('params.maxFeePerGas must be') });
    for (const key of [PASTED, 'maxFeeLimit']) {
      const error = thrown(() => evmNetworkConfig(ethereum, sepolia, { [key]: 1n }));
      expect(error).toMatchObject({
        code: 'CONFIG_INVALID',
        message:
          "EVM network ethereum:sepolia: unknown option; the accepted names are 'maxFeePerGas' and 'maxGasLimit'",
      });
    }
  });

  it('clamps a suggestion to the ceiling and refuses a price above it', () => {
    const ceiling = 100n * GWEI;
    expect(
      capPrice(
        { type: 'eip1559', maxFeePerGas: 500n * GWEI, maxPriorityFeePerGas: 300n * GWEI },
        ceiling,
      ),
    ).toEqual({ type: 'eip1559', maxFeePerGas: ceiling, maxPriorityFeePerGas: ceiling });
    const within = {
      type: 'eip1559',
      maxFeePerGas: 90n * GWEI,
      maxPriorityFeePerGas: 2n * GWEI,
    } as const;
    expect(capPrice(within, ceiling)).toEqual(within);
    expect(capPrice({ type: 'legacy', gasPrice: ceiling + 1n }, ceiling)).toEqual({
      type: 'legacy',
      gasPrice: ceiling,
    });
    expect(() =>
      assertWithinCeiling({ type: 'legacy', gasPrice: ceiling }, ceiling),
    ).not.toThrow();
    expect(
      thrown(() =>
        assertWithinCeiling({ type: 'legacy', gasPrice: ceiling + 1n }, ceiling),
      ),
    ).toMatchObject({
      code: 'INVALID_INTENT',
      details: { required: String(ceiling + 1n), maxFeePerGas: String(ceiling) },
    });
  });
});

describe.each(LIBRARIES)('the EVM fee ceiling end to end (%s)', (library) => {
  it('never signs above the ceiling however an endpoint prices the fee', async () => {
    // An endpoint suggests a 100,000 gwei tip, and the wallet could afford it.
    const tip = 100_000n * GWEI;
    const env = await createEvmEnv({
      library,
      fund: 10n ** 20n,
      node: { rewards: [tip, tip, tip] },
    });
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: 5n }, { idempotencyKey: 'clamped' }),
    );
    const record = await env.stores.operations.get('default', sub.operationId);
    expect(readSentTx(record?.attempts[0]?.raw.data as string)).toMatchObject({
      type: 2,
      maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
    });
    const final = await env.mineWhile(
      env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(env.node.balance(RECIPIENT)).toBe(5n);
  });

  it('refuses an explicit fee above the handle option before any fee request or signing', async () => {
    const counting = countingSigner();
    const env = await createEvmEnv({
      library,
      signer: counting.signer,
      options: { maxFeePerGas: 50n * GWEI },
    });
    const error = await env
      .run(
        env.bc.transfer(
          {
            to: RECIPIENT,
            amount: 5n,
            fee: { maxFeePerGas: 51n * GWEI, maxPriorityFeePerGas: GWEI },
          },
          { idempotencyKey: 'too-high' },
        ),
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'INVALID_INTENT',
      details: { required: String(51n * GWEI), maxFeePerGas: String(50n * GWEI) },
    });
    expect(counting.calls()).toBe(0);
    const served = env.node.served.map((s) => s.method);
    for (const method of ['eth_feeHistory', 'eth_estimateGas', 'eth_sendRawTransaction'])
      expect(served).not.toContain(method);
  });

  it('refuses a replacement or a cancel that would pay above the ceiling', async () => {
    const ceiling = 50n * GWEI;
    const env = await createEvmEnv({ library, options: { maxFeePerGas: ceiling } });
    const sub = await env.run(
      env.bc.transfer(
        {
          to: RECIPIENT,
          amount: 5n,
          fee: { maxFeePerGas: ceiling, maxPriorityFeePerGas: 2n * GWEI },
        },
        { idempotencyKey: 'at-ceiling' },
      ),
    );
    // The least cancel bump raises the fee cap 10% above the ceiling.
    await expect(env.run(env.bc.cancel(sub.operationId))).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      details: { maxFeePerGas: String(ceiling) },
    });
    await expect(
      env.run(
        env.bc.replace(sub.operationId, {
          fee: { maxFeePerGas: 60n * GWEI, maxPriorityFeePerGas: 3n * GWEI },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    // The original is untouched and lands.
    const final = await env.mineWhile(
      env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(final.operation?.attempts).toHaveLength(1);
  });

  it('checks the ceiling again in build, whatever produced the fee object', async () => {
    const h = evmHarness(library);
    const builder = createEvmBuilder(h.ctx);
    const fee = feeDraft('custom', 21_000n, {
      type: 'eip1559',
      maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS + 1n,
      maxPriorityFeePerGas: GWEI,
    });
    await expect(
      h.run(
        builder.build(
          {
            asset: 'native',
            outputs: [{ to: RECIPIENT, amount: 1n }],
            from: KEY_ADDRESS,
            fee: 'normal',
          },
          fee,
          {
            from: KEY_ADDRESS,
            keys: h.keys,
            wallet: {},
            ordering: { kind: 'nonce', nonce: 0n },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
  });
});

const TOKEN = '0x00000000000000000000000000000000000070Ce';
const tokenAsset = { standard: 'erc20', contract: TOKEN } as const;

describe('the EVM gas-limit bound, maxGasLimit', () => {
  it('takes the handle option, else the network params, else 2^24 gas', () => {
    expect(DEFAULT_MAX_GAS_LIMIT).toBe(2n ** 24n);
    expect(evmNetworkConfig(ethereum, sepolia).maxGasLimit).toBe(2n ** 24n);
    const own: NetworkInfo = { ...sepolia, params: { maxGasLimit: 500_000n } };
    expect(evmNetworkConfig(ethereum, own).maxGasLimit).toBe(500_000n);
    expect(evmNetworkConfig(ethereum, own, { maxGasLimit: 100_000n }).maxGasLimit).toBe(
      100_000n,
    );
    // The two bounds are independent options.
    expect(
      evmNetworkConfig(ethereum, sepolia, { maxFeePerGas: GWEI, maxGasLimit: 21_000n }),
    ).toMatchObject({ maxFeePerGas: GWEI, maxGasLimit: 21_000n });
  });

  it('refuses a bound below a plain transfer or outside a uint64, without echoing it', () => {
    for (const value of [20_999n, 0n, -1n, 2n ** 64n, 21_000, '100000', null]) {
      expect(
        thrown(() => evmNetworkConfig(ethereum, sepolia, { maxGasLimit: value })),
      ).toMatchObject({
        code: 'CONFIG_INVALID',
        message:
          'EVM network ethereum:sepolia: maxGasLimit must be a bigint of gas from 21,000 to 2^64 − 1',
      });
    }
    expect(
      evmNetworkConfig(ethereum, sepolia, { maxGasLimit: 2n ** 64n - 1n }).maxGasLimit,
    ).toBe(2n ** 64n - 1n);
    // A network value is checked even where the option overrides it.
    const bad: NetworkInfo = { ...sepolia, params: { maxGasLimit: 1n } };
    expect(
      thrown(() => evmNetworkConfig(ethereum, bad, { maxGasLimit: 100_000n })),
    ).toMatchObject({ message: expect.stringContaining('params.maxGasLimit must be') });
  });

  it('refuses a gas limit above the bound, never one at it', () => {
    expect(() => assertWithinGasLimit(60_000n, 60_000n)).not.toThrow();
    expect(thrown(() => assertWithinGasLimit(60_001n, 60_000n))).toMatchObject({
      code: 'INVALID_INTENT',
      retryable: false,
      message:
        'the gas limit is above maxGasLimit, the EVM handle option that bounds it (gas)',
      details: { required: '60001', maxGasLimit: '60000' },
    });
  });
});

describe.each(LIBRARIES)('the EVM gas-limit bound end to end (%s)', (library) => {
  it("refuses an endpoint's absurd gas estimate under the default bound before signing", async () => {
    const counting = countingSigner();
    const env = await createEvmEnv({ library, signer: counting.signer });
    // 2^25 gas with its headroom is about 0.16 ETH at these prices: the wallet could pay it.
    env.node.intercept = (_endpoint, method) =>
      method === 'eth_estimateGas' ? { result: '0x2000000' } : undefined;
    await expect(
      env.run(
        env.bc.transfer({ to: RECIPIENT, amount: 5n }, { idempotencyKey: 'absurd' }),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      details: {
        required: '40265319', // 2^25 plus 20%, rounded up
        maxGasLimit: String(DEFAULT_MAX_GAS_LIMIT),
      },
    });
    expect(counting.calls()).toBe(0);
    expect(env.node.served.map((s) => s.method)).not.toContain('eth_sendRawTransaction');
  });

  it('bounds the estimate with its headroom, the gas limit a transfer would sign', async () => {
    const counting = countingSigner();
    const env = await createEvmEnv({
      library,
      signer: counting.signer,
      options: { maxGasLimit: 60_000n },
    });
    env.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    env.node.mintToken(TOKEN, env.address, 5_000_000n);
    // The token transfer estimates 51,000 gas: 61,200 with its headroom.
    await expect(
      env.run(
        env.bc.transfer(
          { to: RECIPIENT, amount: '1', asset: tokenAsset },
          { idempotencyKey: 'token' },
        ),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      details: { required: '61200', maxGasLimit: '60000' },
    });
    expect(counting.calls()).toBe(0);
    // A plain transfer fits and lands.
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: 5n }, { idempotencyKey: 'plain' }),
    );
    const final = await env.mineWhile(
      env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
  });

  it('refuses an explicit gasLimit above the bound before any fee request or signing', async () => {
    const counting = countingSigner();
    const env = await createEvmEnv({
      library,
      signer: counting.signer,
      options: { maxGasLimit: 60_000n },
    });
    const error = await env
      .run(
        env.bc.transfer(
          {
            to: RECIPIENT,
            amount: 5n,
            fee: {
              maxFeePerGas: 4n * GWEI,
              maxPriorityFeePerGas: GWEI,
              gasLimit: 60_001n,
            },
          },
          { idempotencyKey: 'explicit' },
        ),
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'INVALID_INTENT',
      details: { required: '60001', maxGasLimit: '60000' },
    });
    expect(counting.calls()).toBe(0);
    const served = env.node.served.map((s) => s.method);
    for (const method of ['eth_feeHistory', 'eth_estimateGas', 'eth_sendRawTransaction'])
      expect(served).not.toContain(method);
  });

  it('refuses a replacement or a cancel whose gas limit is above the bound', async () => {
    const h = evmHarness(library);
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    h.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    h.node.mintToken(TOKEN, KEY_ADDRESS, 10n);
    const build = {
      from: KEY_ADDRESS,
      keys: h.keys,
      wallet: {},
      ordering: { kind: 'nonce' as const, nonce: 0n },
    };
    const intent: DriverIntent = {
      asset: tokenAsset,
      outputs: [{ to: RECIPIENT, amount: 10n }],
      from: KEY_ADDRESS,
      fee: 'normal',
    };
    // Built under the default bound (61,200 gas), then the operator lowers it.
    const builder = createEvmBuilder(h.ctx);
    const fee = await h.run(builder.estimateFee(intent, build));
    const original = await h.run(builder.build(intent, fee, build));
    const signed = await h.run(builder.assemble(original, await signWithKey(original)));
    await h.run(createEvmBroadcaster(h.client, h.ctx.config.chainId).broadcast(signed));
    const lowered = { ...h.ctx, config: { ...h.ctx.config, maxGasLimit: 60_000n } };
    const policy = createEvmReplacement(lowered)!;
    const above = { required: '61200', maxGasLimit: '60000' };
    await expect(
      h.run(policy.buildReplacement!(original, 'fast', build)),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT', details: above });
    const explicit = {
      maxFeePerGas: 10n * GWEI,
      maxPriorityFeePerGas: 5n * GWEI,
      gasLimit: 60_001n,
    };
    await expect(
      h.run(policy.buildReplacement!(original, explicit, build)),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT', details: { required: '60001' } });
    await expect(
      h.run(policy.buildCancel!(original, build, explicit)),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT', details: { required: '60001' } });
    // A cancel is a 21,000-gas self-transfer, within every bound.
    const cancel = await h.run(policy.buildCancel!(original, build));
    expect(cancel.fee.details).toMatchObject({ gasLimit: 21_000n });
    // The bound is checked again in build, whatever produced the fee object.
    await expect(
      h.run(createEvmBuilder(lowered).build(intent, fee, build)),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT', details: above });
  });
});
