import { EVM_CHAINS } from '../../../src/adapters/evm/chains';
import { EVM_PRESETS } from '../../../src/adapters/evm/presets';
import { EVM_TOKENS } from '../../../src/adapters/evm/tokens';
import { explorerUrl } from '../../../src/core/model/chain';
import { applyPlugin, createCatalogs } from '../../../src/core/registry/plugin';
import { isSecret, reveal, secret } from '../../../src/core/secret/secret';

function catalogs() {
  const all = createCatalogs();
  applyPlugin(all, {
    name: 'evm-data',
    chains: EVM_CHAINS,
    presets: EVM_PRESETS,
    assets: EVM_TOKENS,
  });
  return all;
}

/** Spec §2, verified against each chain's documentation (Plan 2 appendix). */
const CHAIN_IDS: Record<string, Record<string, string>> = {
  ethereum: { mainnet: '1', sepolia: '11155111', hoodi: '560048' },
  bsc: { mainnet: '56', testnet: '97' },
  polygon: { mainnet: '137', amoy: '80002' },
  avalanche: { mainnet: '43114', fuji: '43113' },
  arbitrum: { mainnet: '42161', sepolia: '421614' },
  optimism: { mainnet: '10', sepolia: '11155420' },
  base: { mainnet: '8453', sepolia: '84532' },
};

describe('EVM chain data', () => {
  it('registers every chain of spec §2 with its chain id as the network identity', () => {
    const { chains } = catalogs();
    for (const [chainId, networks] of Object.entries(CHAIN_IDS)) {
      const chain = chains.get(chainId);
      expect(chain).toMatchObject({
        family: 'evm',
        model: 'account',
        ordering: 'nonce',
        schemes: ['secp256k1-ecdsa'],
        defaultNetwork: 'mainnet',
      });
      expect(
        Object.fromEntries(Object.values(chain.networks).map((n) => [n.id, n.identity])),
      ).toEqual(networks);
      expect(chain.nativeAsset.decimals).toBe(18);
    }
    expect(EVM_CHAINS.map((c) => [c.id, c.nativeAsset.symbol])).toEqual([
      ['ethereum', 'ETH'],
      ['bsc', 'BNB'],
      ['polygon', 'POL'],
      ['avalanche', 'AVAX'],
      ['arbitrum', 'ETH'],
      ['optimism', 'ETH'],
      ['base', 'ETH'],
    ]);
  });

  it("keeps each network's fee model, finality, replacement rule and capability overrides", () => {
    const { chains } = catalogs();
    const net = (c: string, n = 'mainnet') => chains.network(c, n);
    expect(net('bsc')).toMatchObject({
      feeModel: 'evm-legacy',
      capabilities: { remove: ['fee-market-1559'] },
      maxLagBlocks: 134,
    });
    expect(net('ethereum', 'sepolia')).toMatchObject({
      feeModel: 'evm-1559',
      finality: { kind: 'tag', tag: 'finalized' },
      replacement: { minBumpPercent: 10 },
    });
    expect(net('avalanche')).toMatchObject({
      finality: { kind: 'confirmations', confirmations: 1 },
      capabilities: { remove: ['finality-tag'] },
    });
    expect(net('arbitrum').replacement).toBeUndefined();
    expect(net('arbitrum').capabilities).toEqual({ remove: ['replace-fee', 'cancel'] });
    expect(net('polygon').params).toEqual({ minPriorityFeePerGas: 25_000_000_000n });
    expect(net('polygon', 'amoy').params).toBeUndefined();
    for (const chain of ['optimism', 'base']) {
      for (const network of ['mainnet', 'sepolia'])
        expect(net(chain, network).params).toEqual({ l1DataFee: 'op-stack' });
    }
    expect(explorerUrl(net('base'), 'tx', '0xabc')).toBe('https://basescan.org/tx/0xabc');
    expect(explorerUrl(net('avalanche'), 'tx', '0xabc')).toBeUndefined();
  });

  it('registers USDT and USDC by alias on the mainnets where their issuers deploy them', () => {
    const { assets } = catalogs();
    expect(assets.resolveAlias('ethereum', 'mainnet', 'usdt').id).toBe(
      'ethereum:mainnet/erc20:0xdAC17F958D2ee523a2206206994597C13D831ec7',
    );
    expect(assets.resolveAlias('base', 'mainnet', 'USDC').metadata).toEqual({
      symbol: 'USDC',
      decimals: 6,
    });
    expect(() => assets.resolveAlias('bsc', 'mainnet', 'USDT')).toThrow(
      expect.objectContaining({ code: 'ASSET_RESOLUTION' }),
    );
    expect(() => assets.resolveAlias('ethereum', 'sepolia', 'USDC')).toThrow(
      expect.objectContaining({ code: 'ASSET_RESOLUTION' }),
    );
    expect(EVM_TOKENS).toHaveLength(8);
  });
});

describe('EVM provider presets', () => {
  const { presets } = catalogs();
  const urlOf = (name: string, chain: string, network: string, apiKey?: string) => {
    const { endpoints } = presets.resolve(
      name,
      { chain, network, ...(apiKey ? { apiKey: secret(apiKey) } : {}) },
      'rpc',
    );
    return endpoints.map((e) => e.url);
  };

  it('builds keyed URLs as secrets and never prints the key', () => {
    const [alchemy] = urlOf('alchemy', 'polygon', 'amoy', 'KEY1');
    expect(isSecret(alchemy)).toBe(true);
    expect(reveal(alchemy)).toBe('https://polygon-amoy.g.alchemy.com/v2/KEY1');
    expect(JSON.stringify(alchemy)).not.toContain('KEY1');
    expect(reveal(urlOf('infura', 'ethereum', 'hoodi', 'KEY2')[0])).toBe(
      'https://hoodi.infura.io/v3/KEY2',
    );
    expect(reveal(urlOf('ankr', 'avalanche', 'mainnet', 'KEY3')[0])).toBe(
      'https://rpc.ankr.com/avalanche/KEY3',
    );
    expect(() => urlOf('alchemy', 'base', 'mainnet')).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringMatching(/requires an apiKey/),
      }),
    );
  });

  it('serves public endpoints only where the chain documents one, marked not for production', () => {
    expect(urlOf('public', 'arbitrum', 'sepolia')).toEqual([
      'https://sepolia-rollup.arbitrum.io/rpc',
    ]);
    expect(
      presets.resolve('public', { chain: 'base', network: 'mainnet' }, 'rpc').preset
        .production,
    ).toBe(false);
    expect(() => urlOf('public', 'ethereum', 'mainnet')).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    expect(() => urlOf('ankr', 'optimism', 'mainnet', 'K')).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringMatching(/does not support optimism:mainnet/),
      }),
    );
  });
});
