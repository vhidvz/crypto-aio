import { SOLANA_CHAIN } from '../../../src/adapters/solana/chains';
import {
  DEFAULT_MAX_COMPUTE_UNIT_PRICE,
  SOLANA_CAPABILITIES,
  solanaNetworkConfig,
} from '../../../src/adapters/solana/network';
import { SOLANA_PRESETS } from '../../../src/adapters/solana/presets';
import { SOLANA_TOKENS } from '../../../src/adapters/solana/tokens';
import type { ChainInfo, NetworkInfo } from '../../../src/core/model/chain';
import { reveal, secret } from '../../../src/core/secret/secret';

const preset = (name: string) => SOLANA_PRESETS.find((p) => p.name === name)!;
const KEYED = ['alchemy', 'infura', 'ankr'] as const;

/**
 * Every supported (preset, cluster) pair and its endpoint for the key `k`, as each
 * provider documents it. The public RPC publishes 100 requests per 10 s and 40 per 10 s
 * for one method, per IP, so 4 rps; the observed `getBlock` limit is lower (about 6 per
 * 10 s), which the preset leaves out: a keyless preset sets only a rate its operator
 * publishes.
 */
const PUBLIC_LIMIT = { rps: 4 };
const ENDPOINTS = [
  [
    'public',
    'mainnet',
    { name: 'public', url: 'https://api.mainnet.solana.com', rateLimit: PUBLIC_LIMIT },
  ],
  [
    'public',
    'devnet',
    { name: 'public', url: 'https://api.devnet.solana.com', rateLimit: PUBLIC_LIMIT },
  ],
  [
    'public',
    'testnet',
    { name: 'public', url: 'https://api.testnet.solana.com', rateLimit: PUBLIC_LIMIT },
  ],
  [
    'alchemy',
    'mainnet',
    { name: 'alchemy', url: 'https://solana-mainnet.g.alchemy.com/v2/k' },
  ],
  [
    'alchemy',
    'devnet',
    { name: 'alchemy', url: 'https://solana-devnet.g.alchemy.com/v2/k' },
  ],
  ['infura', 'mainnet', { name: 'infura', url: 'https://solana-mainnet.infura.io/v3/k' }],
  ['infura', 'devnet', { name: 'infura', url: 'https://solana-devnet.infura.io/v3/k' }],
  ['ankr', 'mainnet', { name: 'ankr', url: 'https://rpc.ankr.com/solana/k' }],
  ['ankr', 'devnet', { name: 'ankr', url: 'https://rpc.ankr.com/solana_devnet/k' }],
];

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

  it('is deeply frozen', () => {
    expect(Object.isFrozen(SOLANA_CHAIN)).toBe(true);
    expect(Object.isFrozen(SOLANA_CHAIN.networks.mainnet?.finality)).toBe(true);
    expect(Object.isFrozen(SOLANA_TOKENS[0]?.ref)).toBe(true);
    expect(Object.isFrozen(SOLANA_PRESETS)).toBe(true);
    expect(SOLANA_PRESETS.map((p) => Object.isFrozen(p))).toEqual([
      true,
      true,
      true,
      true,
    ]);
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
  it('serves the verified endpoint of every supported cluster, and of no other', () => {
    const served = SOLANA_PRESETS.flatMap((p) =>
      Object.keys(SOLANA_CHAIN.networks)
        .filter((network) => p.supports('solana', network))
        .map((network) => [
          p.name,
          network,
          ...p
            .endpoints({ chain: 'solana', network, apiKey: secret('k') })
            .map((e) => ({ ...e, url: reveal(e.url) })),
        ]),
    );
    expect(served).toEqual(ENDPOINTS);
    expect(preset('public').supports('ethereum', 'mainnet')).toBe(false);
    expect(preset('public').supports('solana', 'toString')).toBe(false);
  });

  it('keeps keyed URLs secret, and marks the public RPC as not for production', () => {
    for (const name of KEYED) {
      const [endpoint] = preset(name).endpoints({
        chain: 'solana',
        network: 'mainnet',
        apiKey: 'k4',
      });
      expect(String(endpoint?.url)).toBe('[REDACTED]');
    }
    expect(preset('public').production).toBe(false);
  });

  it('refuses a missing or empty key with a fixed text that names no key', () => {
    for (const name of KEYED) {
      for (const apiKey of [undefined, '', secret(''), secret('   ')]) {
        expect(() =>
          preset(name).endpoints({
            chain: 'solana',
            network: 'devnet',
            ...(apiKey !== undefined ? { apiKey } : {}),
          }),
        ).toThrow(
          expect.objectContaining({
            code: 'CONFIG_INVALID',
            message: `provider preset '${name}' requires a non-empty apiKey for solana:devnet`,
          }),
        );
      }
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

  it('refuses data the driver cannot serve with CONFIG_INVALID', () => {
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

describe('the handle option maxComputeUnitPrice', () => {
  const devnet = SOLANA_CHAIN.networks.devnet as NetworkInfo;
  const withParams = (params: Record<string, unknown>): NetworkInfo => ({
    ...devnet,
    params,
  });
  const bound = (network: NetworkInfo, options?: Record<string, unknown>) =>
    solanaNetworkConfig(SOLANA_CHAIN, network, options).maxComputeUnitPrice;

  it('takes the option, else the network entry, else 10,000,000 micro-lamports', () => {
    expect(DEFAULT_MAX_COMPUTE_UNIT_PRICE).toBe(10_000_000n);
    expect(bound(devnet)).toBe(DEFAULT_MAX_COMPUTE_UNIT_PRICE);
    expect(bound(devnet, {})).toBe(DEFAULT_MAX_COMPUTE_UNIT_PRICE);
    expect(bound(withParams({ maxComputeUnitPrice: 50_000n }))).toBe(50_000n);
    expect(
      bound(withParams({ maxComputeUnitPrice: 50_000n }), {
        maxComputeUnitPrice: 2_000_000n,
      }),
    ).toBe(2_000_000n);
    expect(bound(devnet, { maxComputeUnitPrice: 999n })).toBe(999n);
    expect(bound(devnet, { maxComputeUnitPrice: 2n ** 64n - 1n })).toBe(2n ** 64n - 1n);
  });

  it('refuses a bound that is not a bigint from 999 to 2^64 − 1, from either place', () => {
    for (const value of [998n, 0n, -1n, 2n ** 64n, 10_000_000, '10000000', null]) {
      for (const run of [
        () => bound(devnet, { maxComputeUnitPrice: value }),
        () => bound(withParams({ maxComputeUnitPrice: value })),
        // A bad network value fails loudly even where the option overrides it.
        () =>
          bound(withParams({ maxComputeUnitPrice: value }), {
            maxComputeUnitPrice: 5_000n,
          }),
      ]) {
        expect(run).toThrow(
          expect.objectContaining({
            code: 'CONFIG_INVALID',
            message: expect.stringContaining('maxComputeUnitPrice must be a bigint'),
          }),
        );
      }
    }
  });

  it('refuses any other option, listing the accepted name and never echoing the key', () => {
    for (const key of ['maxPriorityFeeMicroLamports', 'maxFeeLimit', 'sk_live_abc123']) {
      let caught: unknown;
      try {
        bound(devnet, { [key]: 1n });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: 'CONFIG_INVALID',
        message:
          "Solana network solana:devnet: unknown option; the only accepted name is 'maxComputeUnitPrice'",
      });
      expect(JSON.stringify(caught)).not.toContain(key);
      expect(String((caught as Error).stack)).not.toContain(key);
    }
  });
});
