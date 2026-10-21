import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CryptoAio, noopLogger, type ChainInfo } from '../../../src';
import { EVM_CHAINS } from '../../../src/adapters/evm/chains';
import { EVM_PEER_DEPENDENCIES, evmChainPlugin } from '../../../src/adapters/evm/index';
import { evmPlugin } from '../../../src/adapters/evm/plugin';
import { FakeClock, drive } from '../../../src/testing/fake-clock';
import { fakePlugin } from '../../../src/testing/fake-plugin';
import { ScriptedEvmNode } from './support/node';
import { KEY_ADDRESS } from './support/vectors';
import { samePlugin } from '../../../src/core/registry/plugin';
import { thrown } from '../../helpers';

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
        message:
          "unknown library for chain 'ethereum'; the accepted names are 'ethers' and 'web3'",
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

  it('lists ethers then web3, each with its own peer dependency, for every built-in chain', () => {
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
    expect(plugin.adapters?.[1]?.chains).toEqual(plugin.adapters?.[0]?.chains);
  });

  it('pins the SDK ranges package.json declares as optional peers and pins for tests', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as Record<'peerDependencies' | 'devDependencies', Record<string, string>> & {
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    const peers = Object.values(EVM_PEER_DEPENDENCIES);
    expect(peers.map((d) => d.name)).toEqual(['ethers', 'web3']);
    for (const { name, range } of peers) {
      expect([name, pkg.peerDependencies[name]]).toEqual([name, range]);
      expect([name, pkg.peerDependenciesMeta[name]?.optional]).toEqual([name, true]);
      expect([name, `^${pkg.devDependencies[name]}`]).toEqual([name, range]);
    }
  });
});

describe('the built-in EVM plugin registered again', () => {
  it('keeps use() idempotent for the same plugin, built-ins included', async () => {
    // The composition root already registered evmPlugin(); these are fresh copies of it.
    expect(samePlugin(evmPlugin(), evmPlugin())).toBe(true);
    const { aio } = container(1n, { plugins: [evmPlugin()] });
    expect(() => aio.use(evmPlugin())).not.toThrow();
    expect(thrown(() => aio.use({ name: 'evm' }))).toMatchObject({
      code: 'CONFIG_INVALID',
      message: "plugin 'evm' is already registered with a different definition",
    });
    await aio.close();
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

  it("registers as 'evm:<name>'", () => {
    expect(evmChainPlugin({ name: 'acme', chains: [acme] }).name).toBe('evm:acme');
  });

  it('registers the same custom chain plugin twice as a no-op, and refuses another under its name', async () => {
    const { aio } = container(777n);
    aio.use(evmChainPlugin({ name: 'acme', chains: [acme] }));
    expect(() => aio.use(evmChainPlugin({ name: 'acme', chains: [acme] }))).not.toThrow();
    const other = evmChainPlugin({ name: 'acme', chains: [{ ...acme, id: 'acme2' }] });
    expect(thrown(() => aio.use(other))).toMatchObject({ code: 'CONFIG_INVALID' });
    await aio.close();
  });

  it.each(['evm', 'fake'])(
    "registers and serves a chain under a name equal to a built-in family ('%s')",
    async (name) => {
      const { aio, node, run } = container(777n, {
        plugins: [fakePlugin(), evmChainPlugin({ name, chains: [acme] })],
      });
      node.fund(KEY_ADDRESS, 7n);
      const bc = aio.blockchain({
        chain: 'acmechain' as 'ethereum',
        network: 'main' as 'mainnet',
        provider: 'local',
      });
      expect(bc.library).toBe('ethers');
      expect((await run(bc.getBalance(KEY_ADDRESS))).amount.base).toBe(7n);
      await aio.close();
    },
  );

  it.each(['', 'a/b', 'Acme', 'ACME', '1acme', '-acme', 'acme_x', 'evm:acme', 'acme '])(
    'refuses the plugin name %j',
    (name) => {
      expect(() => evmChainPlugin({ name, chains: [acme] })).toThrow(
        expect.objectContaining({
          code: 'CONFIG_INVALID',
          message: expect.stringMatching(/plugin name/),
        }),
      );
    },
  );

  it('refuses a chain id a built-in chain already has', () => {
    expect(() =>
      container(1n, {
        plugins: [evmChainPlugin({ name: 'x', chains: [{ ...acme, id: 'ethereum' }] })],
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: "chain 'ethereum' is already registered",
      }),
    );
  });

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

  describe('tokens', () => {
    // Ethereum's USDC, EIP-55 checksummed: any 20-byte contract would do.
    const CONTRACT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const token = (ref: { readonly standard: string; readonly contract: string }) => ({
      chain: 'acmechain',
      network: 'main',
      ref,
      metadata: { symbol: 'TKN', decimals: 6 },
      aliases: ['TKN'],
    });
    const erc20 = (contract: string) => token({ standard: 'erc20', contract });

    it.each([
      ['lower', CONTRACT.toLowerCase()],
      ['upper', `0x${CONTRACT.slice(2).toUpperCase()}`],
      ['checksummed', CONTRACT],
    ])(
      'registers a %s-case contract checksummed, so its alias and its ref name one asset',
      async (_case, contract) => {
        // A lower-case contract, as a receipt's contractAddress prints it, once registered
        // as written: the alias named one asset id, the driver's checksummed ref another.
        const plugin = evmChainPlugin({
          name: 'acme',
          chains: [acme],
          assets: [erc20(contract)],
        });
        expect(plugin.assets?.[0]?.ref).toEqual({
          standard: 'erc20',
          contract: CONTRACT,
        });
        expect(
          samePlugin(
            plugin,
            evmChainPlugin({ name: 'acme', chains: [acme], assets: [erc20(CONTRACT)] }),
          ),
        ).toBe(true);
        const { aio, run } = container(777n, { plugins: [plugin] });
        const bc = aio.blockchain({
          chain: 'acmechain' as 'ethereum',
          network: 'main' as 'mainnet',
          provider: 'local',
        });
        const id = `acmechain:main/erc20:${CONTRACT}`;
        expect((await run(bc.resolveAsset('TKN'))).id).toBe(id);
        const byRef = await run(bc.resolveAsset({ standard: 'erc20', contract }));
        // The registration itself, metadata included, not a second asset read from the node.
        expect([byRef.id, byRef.metadata]).toEqual([id, { symbol: 'TKN', decimals: 6 }]);
        await aio.close();
      },
    );

    it.each([
      ['another standard', token({ standard: 'trc20', contract: CONTRACT }), /'erc20'/],
      ['a short contract', erc20(CONTRACT.slice(0, 40)), /20-byte hex contract/],
      ['no 0x prefix', erc20(CONTRACT.slice(2)), /20-byte hex contract/],
      // One letter's case flipped: a mixed-case contract with a wrong checksum is a typo.
      ['a wrong checksum', erc20(`0xa${CONTRACT.slice(3)}`), /wrong checksum/],
    ])(
      'refuses a token with %s, at registration, never repeating it',
      (_name, asset, reason) => {
        const error = thrown(() =>
          evmChainPlugin({ name: 'acme', chains: [acme], assets: [asset] }),
        );
        expect(error).toMatchObject({
          code: 'CONFIG_INVALID',
          message: expect.stringMatching(reason),
        });
        expect((error as Error).message).not.toContain(asset.ref.contract.slice(2, 12));
      },
    );
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
    for (const schemes of [['ed25519'], ['secp256k1-ecdsa', 'ed25519'], []]) {
      expect(() => evmChainPlugin({ name: 'x', chains: [{ ...acme, schemes }] })).toThrow(
        expect.objectContaining({
          code: 'CONFIG_INVALID',
          message: "EVM chain 'acmechain': its only scheme must be 'secp256k1-ecdsa'",
        }),
      );
    }
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
