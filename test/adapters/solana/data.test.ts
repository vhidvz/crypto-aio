import { SOLANA_CHAIN } from '../../../src/adapters/solana/chains';
import {
  SOLANA_CAPABILITIES,
  solanaNetworkConfig,
} from '../../../src/adapters/solana/network';
import { SOLANA_PRESETS } from '../../../src/adapters/solana/presets';
import { SOLANA_TOKENS } from '../../../src/adapters/solana/tokens';
import type { ChainInfo, NetworkInfo } from '../../../src/core/model/chain';
import { reveal, secret } from '../../../src/core/secret/secret';

const preset = (name: string) => SOLANA_PRESETS.find((p) => p.name === name)!;
const urls = (name: string, network: string, apiKey?: string) =>
  preset(name)
    .endpoints({
      chain: 'solana',
      network,
      ...(apiKey !== undefined ? { apiKey: secret(apiKey) } : {}),
    })
    .map((e) => reveal(e.url));

describe('Solana chain data', () => {
  it('has the three clusters with their genesis hashes and the finalized commitment', () => {
    expect(SOLANA_CHAIN).toMatchObject({
      id: 'solana',
      family: 'solana',
      model: 'account',
      ordering: 'expiry',
      schemes: ['ed25519'],
      nativeAsset: { symbol: 'SOL', decimals: 9 },
      defaultNetwork: 'mainnet',
    });
    expect(
      Object.values(SOLANA_CHAIN.networks).map((n) => [n.id, n.identity, n.testnet]),
    ).toEqual([
      ['mainnet', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', false],
      ['devnet', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', true],
      ['testnet', '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY', true],
    ]);
    for (const network of Object.values(SOLANA_CHAIN.networks)) {
      expect(network).toMatchObject({
        feeModel: 'solana',
        finality: { kind: 'commitment', level: 'finalized' },
        defaultConfirmations: 1,
        reorgWindow: 64,
        maxLagBlocks: 150,
      });
      expect(network.replacement).toBeUndefined();
    }
    expect(SOLANA_CHAIN.networks.devnet?.explorer).toEqual({
      tx: 'https://explorer.solana.com/tx/{id}?cluster=devnet',
      address: 'https://explorer.solana.com/address/{address}?cluster=devnet',
    });
    expect(SOLANA_CHAIN.networks.mainnet?.explorer?.tx).toBe(
      'https://explorer.solana.com/tx/{id}',
    );
  });

  it('is deeply frozen (R56)', () => {
    expect(Object.isFrozen(SOLANA_CHAIN)).toBe(true);
    expect(Object.isFrozen(SOLANA_CHAIN.networks.mainnet?.finality)).toBe(true);
    expect(Object.isFrozen(SOLANA_TOKENS[0]?.ref)).toBe(true);
    expect(Object.isFrozen(SOLANA_PRESETS)).toBe(true);
  });

  it('registers USDC and USDT by mint, only where their issuers list them', () => {
    expect(
      SOLANA_TOKENS.map((t) => [
        t.network,
        t.metadata.symbol,
        t.ref === 'native' ? '' : t.ref.contract,
        t.metadata.decimals,
      ]),
    ).toEqual([
      ['mainnet', 'USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6],
      ['mainnet', 'USDT', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6],
      ['devnet', 'USDC', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 6],
    ]);
    expect(
      SOLANA_TOKENS.every((t) => t.ref !== 'native' && t.ref.standard === 'spl'),
    ).toBe(true);
  });
});

describe('Solana provider presets', () => {
  it('serves the verified URL templates, keyed URLs as secrets', () => {
    expect(urls('public', 'mainnet')).toEqual(['https://api.mainnet.solana.com']);
    expect(urls('public', 'testnet')).toEqual(['https://api.testnet.solana.com']);
    expect(urls('alchemy', 'devnet', 'k1')).toEqual([
      'https://solana-devnet.g.alchemy.com/v2/k1',
    ]);
    expect(urls('infura', 'mainnet', 'k2')).toEqual([
      'https://solana-mainnet.infura.io/v3/k2',
    ]);
    expect(urls('ankr', 'devnet', 'k3')).toEqual([
      'https://rpc.ankr.com/solana_devnet/k3',
    ]);
    const [endpoint] = preset('alchemy').endpoints({
      chain: 'solana',
      network: 'mainnet',
      apiKey: 'k4',
    });
    expect(String(endpoint?.url)).toBe('[REDACTED]');
    expect(preset('public').production).toBe(false);
  });

  it('supports only the documented clusters, and refuses an empty key without naming it', () => {
    expect(preset('alchemy').supports('solana', 'testnet')).toBe(false);
    expect(preset('ankr').supports('solana', 'testnet')).toBe(false);
    expect(preset('public').supports('ethereum', 'mainnet')).toBe(false);
    expect(preset('public').supports('solana', 'toString')).toBe(false);
    for (const key of ['', '   ']) {
      expect(() => urls('infura', 'devnet', key)).toThrow(
        expect.objectContaining({
          code: 'CONFIG_INVALID',
          message: expect.not.stringContaining(`'${key}'`),
        }),
      );
    }
  });
});

describe('solanaNetworkConfig', () => {
  const devnet = SOLANA_CHAIN.networks.devnet as NetworkInfo;
  const withNetwork = (network: Partial<NetworkInfo>) => () =>
    solanaNetworkConfig(SOLANA_CHAIN, { ...devnet, ...network });

  it('derives the genesis hash and the capabilities', () => {
    const config = solanaNetworkConfig(SOLANA_CHAIN, devnet);
    expect(config.genesisHash).toBe('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
    expect([...config.capabilities].sort()).toEqual([...SOLANA_CAPABILITIES].sort());
    expect(
      [
        ...solanaNetworkConfig(SOLANA_CHAIN, {
          ...devnet,
          capabilities: { remove: ['memo'] },
        }).capabilities,
      ].sort(),
    ).toEqual(['address-history', 'block-scan', 'expiry', 'tokens']);
  });

  it('refuses data the driver cannot serve with CONFIG_INVALID (M3)', () => {
    const cases: (() => unknown)[] = [
      withNetwork({ identity: 'not-base58!' }),
      withNetwork({ identity: '1111' }),
      withNetwork({ feeModel: 'evm-1559' }),
      withNetwork({ finality: { kind: 'confirmations', confirmations: 32 } }),
      withNetwork({ replacement: { minBumpPercent: 10 } }),
      withNetwork({ capabilities: { add: ['replace-fee'] } }),
      withNetwork({ capabilities: { remove: ['expiry'] } }),
      () =>
        solanaNetworkConfig(
          { ...SOLANA_CHAIN, schemes: ['secp256k1-ecdsa'] } as ChainInfo,
          devnet,
        ),
      () =>
        solanaNetworkConfig({ ...SOLANA_CHAIN, ordering: 'nonce' } as ChainInfo, devnet),
    ];
    for (const run of cases) {
      expect(run).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    }
  });
});
