import { CryptoAio, noopLogger, type ChainInfo } from '../../../src';
import { EVM_CHAINS } from '../../../src/adapters/evm/chains';
import { evmChainPlugin } from '../../../src/adapters/evm/index';
import { evmPlugin } from '../../../src/adapters/evm/plugin';
import { FakeClock, drive } from '../../../src/testing/fake-clock';
import { ScriptedEvmNode } from './support/node';
import { KEY_ADDRESS } from './support/vectors';

function container(
  chainId: bigint,
  extra: Partial<ConstructorParameters<typeof CryptoAio>[0]> = {},
) {
  const clock = new FakeClock();
  const node = new ScriptedEvmNode({ chainId, clock });
  const aio = new CryptoAio({
    env: false,
    logger: noopLogger,
    clock,
    transport: { fetch: node.fetch.fetch, baseDelayMs: 1, maxDelayMs: 2 },
    providers: { local: { endpoints: [{ url: node.endpoint('main') }] } },
    ...extra,
  });
  return { aio, node, run: <T>(p: Promise<T>) => drive(clock, p) };
}

describe('the built-in EVM plugin', () => {
  it('registers every chain with ethers as the default library and web3 as the other', async () => {
    const { aio, node, run } = container(11155111n);
    const eth = aio.blockchain({
      chain: 'ethereum',
      network: 'sepolia',
      provider: 'local',
    });
    expect([eth.chain, eth.network, eth.library]).toEqual([
      'ethereum',
      'sepolia',
      'ethers',
    ]);
    expect(eth.with({ library: 'web3' }).library).toBe('web3');
    expect([...eth.capabilities].sort()).toEqual([
      'block-scan',
      'cancel',
      'fee-market-1559',
      'finality-tag',
      'hd-public-derivation',
      'replace-fee',
      'tokens',
    ]);
    node.fund(KEY_ADDRESS, 12n);
    await run(eth.ready());
    expect((await run(eth.getBalance(KEY_ADDRESS))).amount.base).toBe(12n);
    expect(
      (await run(eth.with({ library: 'web3' }).getBalance(KEY_ADDRESS.toLowerCase())))
        .amount.base,
    ).toBe(12n);
    await expect(run(eth.history(KEY_ADDRESS, { limit: 1 }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
    expect(
      aio
        .blockchain({ chain: 'bsc', network: 'testnet', provider: 'local' })
        .supports('fee-market-1559'),
    ).toBe(false);
    expect(
      aio.blockchain({ chain: 'arbitrum', provider: 'local' }).supports('replace-fee'),
    ).toBe(false);
    expect(() => aio.blockchain({ chain: 'ethereum', provider: 'public' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    expect(() =>
      aio.blockchain({
        chain: 'ethereum',
        library: 'tronweb' as 'ethers',
        provider: 'local',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'INCOMPATIBLE_SELECTION',
        message: expect.stringContaining('supported: ethers, web3'),
      }),
    );
    await aio.close();
  });

  it('resolves the well-known tokens by alias, only on their own network', async () => {
    const { aio, run } = container(1n);
    const eth = aio.blockchain({ chain: 'ethereum', provider: 'local' });
    expect((await run(eth.resolveAsset('USDT'))).id).toBe(
      'ethereum:mainnet/erc20:0xdAC17F958D2ee523a2206206994597C13D831ec7',
    );
    await expect(
      run(
        eth.resolveAsset('base:mainnet/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
      ),
    ).rejects.toMatchObject({ code: 'ASSET_RESOLUTION' });
    await aio.close();
  });

  it('is data only: registering it loads no SDK', () => {
    const plugin = evmPlugin();
    expect(
      plugin.adapters?.map((m) => [m.family, m.library, m.peerDependencies]),
    ).toEqual([
      ['evm', 'ethers', [{ name: 'ethers', range: '^6.17.0' }]],
      ['evm', 'web3', [{ name: 'web3', range: '^4.16.0' }]],
    ]);
    expect(plugin.adapters?.[0]?.chains).toEqual([
      'ethereum',
      'bsc',
      'polygon',
      'avalanche',
      'arbitrum',
      'optimism',
      'base',
    ]);
  });
});

describe('evmChainPlugin', () => {
  const acme: ChainInfo = {
    ...(EVM_CHAINS[0] as ChainInfo),
    id: 'acmechain',
    nativeAsset: { symbol: 'ACME', decimals: 18 },
    networks: {
      main: {
        ...(EVM_CHAINS[0]?.networks.sepolia as ChainInfo['networks'][string]),
        id: 'main',
        identity: '777',
      },
    },
    defaultNetwork: 'main',
  };

  it('serves a chain of your own with the built-in EVM driver', async () => {
    const { aio, node, run } = container(777n, {
      plugins: [evmChainPlugin({ name: 'acme', chains: [acme] })],
    });
    node.fund(KEY_ADDRESS, 5n);
    const bc = aio.blockchain({
      chain: 'acmechain' as 'ethereum',
      network: 'main' as 'mainnet',
      library: 'web3',
      provider: 'local',
    });
    expect((await run(bc.getBalance(KEY_ADDRESS))).amount.toDecimalString()).toBe(
      '0.000000000000000005',
    );
    await aio.close();
  });

  it('refuses chain data the EVM driver cannot serve, at registration', () => {
    expect(() =>
      evmChainPlugin({ name: 'x', chains: [{ ...acme, family: 'utxo' }] }),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringMatching(/family must be 'evm'/),
      }),
    );
    expect(() =>
      evmChainPlugin({ name: 'x', chains: [{ ...acme, ordering: 'expiry' }] }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    const bad = {
      ...acme,
      networks: { main: { ...acme.networks.main!, identity: 'acme' } },
    };
    expect(() => evmChainPlugin({ name: 'x', chains: [bad] })).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringMatching(/decimal chain id/),
      }),
    );
  });
});
