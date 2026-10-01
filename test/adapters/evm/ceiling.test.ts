import { EVM_CHAINS } from '../../../src/adapters/evm/chains';
import { createEvmBuilder } from '../../../src/adapters/evm/builder';
import {
  DEFAULT_MAX_FEE_PER_GAS,
  assertWithinCeiling,
  capPrice,
  feeDraft,
} from '../../../src/adapters/evm/fees';
import { evmNetworkConfig } from '../../../src/adapters/evm/network';
import { readSentTx } from '../../../src/adapters/evm/rawtx';
import type { ChainInfo, NetworkInfo } from '../../../src/core/model/chain';
import { evmHarness } from './support/context';
import { countingSigner, createEvmEnv } from './support/env';
import { LIBRARIES } from './support/harness';
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

describe('the EVM fee ceiling, maxFeePerGas (Plan 7 D6, F4-R28 shape)', () => {
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
          "EVM network ethereum:sepolia: unknown option; the only accepted name is 'maxFeePerGas'",
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
