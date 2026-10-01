import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
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

/** Every built-in network's chain id, verified against each chain's documentation. */
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
  it('registers every chain with its chain id as the network identity', () => {
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
    expect(net('polygon').params).toEqual({
      systemLogs: 'bor',
      minPriorityFeePerGas: 25_000_000_000n,
    });
    expect(net('polygon', 'amoy').params).toEqual({ systemLogs: 'bor' });
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

  /** From Tether's supported-protocols page and Circle's USDC addresses page. */
  const TOKENS: readonly (readonly [string, 'USDT' | 'USDC', string])[] = [
    ['ethereum', 'USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7'],
    ['avalanche', 'USDT', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7'],
    ['ethereum', 'USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
    ['polygon', 'USDC', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'],
    ['avalanche', 'USDC', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'],
    ['arbitrum', 'USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'],
    ['optimism', 'USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'],
    ['base', 'USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
  ];

  /** EIP-55, computed here with keccak-256 rather than by an SDK. */
  const checksum = (address: string) => {
    const hex = address.slice(2).toLowerCase();
    const hash = bytesToHex(keccak_256(utf8ToBytes(hex)));
    const digits = [...hex].map((c, i) =>
      Number.parseInt(hash[i] ?? '0', 16) >= 8 ? c.toUpperCase() : c,
    );
    return `0x${digits.join('')}`;
  };

  it('computes EIP-55 checksums like the EIP test vectors', () => {
    for (const vector of [
      '0x52908400098527886E0F7030069857D2E4169EE7',
      '0xde709f2102306220921060314715629080e2fb77',
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    ])
      expect(checksum(vector)).toBe(vector);
  });

  it.each(TOKENS)(
    'resolves %s mainnet %s to its issuer contract, EIP-55 checksummed',
    (chain, symbol, contract) => {
      expect(contract).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(checksum(contract)).toBe(contract);
      expect(catalogs().assets.resolveAlias(chain, 'mainnet', symbol)).toMatchObject({
        id: `${chain}:mainnet/erc20:${contract}`,
        ref: { standard: 'erc20', contract },
        metadata: { symbol, decimals: 6 },
      });
    },
  );

  it('is frozen all the way down, so no caller can change the shared chain data', () => {
    const frozen = (value: unknown): boolean =>
      typeof value !== 'object' ||
      value === null ||
      (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(EVM_CHAINS)).toBe(true);
    const net = (c: string, n: string) => catalogs().chains.network(c, n);
    // FINALIZED_TAG and each chain's `remove` list are shared by all its networks.
    const finality = net('ethereum', 'sepolia').finality;
    const remove = net('arbitrum', 'mainnet').capabilities?.remove ?? [];
    expect(remove).toHaveLength(2);
    expect(Reflect.set(finality, 'fallbackConfirmations', 1)).toBe(false);
    expect(Reflect.set(remove, 2, 'tokens')).toBe(false);
    expect(() => (remove as string[]).push('tokens')).toThrow(TypeError);
    expect(net('ethereum', 'mainnet').finality).toEqual({
      kind: 'tag',
      tag: 'finalized',
      fallbackConfirmations: 128,
    });
    expect(net('arbitrum', 'sepolia').capabilities).toEqual({
      remove: ['replace-fee', 'cancel'],
    });
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

  it('refuses an empty or missing apiKey, naming the preset and network only', () => {
    for (const apiKey of ['', secret(''), secret('  ')]) {
      expect(() =>
        presets.resolve('infura', { chain: 'base', network: 'sepolia', apiKey }, 'rpc'),
      ).toThrow(
        expect.objectContaining({
          code: 'CONFIG_INVALID',
          message:
            "provider preset 'infura' requires a non-empty apiKey for base:sepolia",
        }),
      );
    }
    // Called directly, without the catalog's own apiKey check.
    const alchemy = EVM_PRESETS.find((p) => p.name === 'alchemy');
    expect(() => alchemy?.endpoints({ chain: 'bsc', network: 'testnet' })).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: "provider preset 'alchemy' requires a non-empty apiKey for bsc:testnet",
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
