import { BITCOIN_CHAIN } from '../../../src/adapters/utxo/chains';
import { UTXO_CAPABILITIES, utxoNetworkConfig } from '../../../src/adapters/utxo/network';
import { UTXO_PRESETS } from '../../../src/adapters/utxo/presets';
import type { NetworkInfo } from '../../../src/core/model/chain';
import { PresetCatalog } from '../../../src/core/registry/providers';

/** Plan 3 Appendix A: genesis hashes and address prefixes (Bitcoin Core chainparams.cpp). */
const EXPECTED: Record<string, [string, string, number, number]> = {
  mainnet: [
    '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
    'bc',
    0x00,
    0x05,
  ],
  testnet: [
    '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943',
    'tb',
    0x6f,
    0xc4,
  ],
  testnet4: [
    '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043',
    'tb',
    0x6f,
    0xc4,
  ],
  signet: [
    '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
    'tb',
    0x6f,
    0xc4,
  ],
  regtest: [
    '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',
    'bcrt',
    0x6f,
    0xc4,
  ],
};

const mainnet = BITCOIN_CHAIN.networks.mainnet as NetworkInfo;
const withNetwork = (patch: Partial<NetworkInfo>): NetworkInfo => ({
  ...mainnet,
  ...patch,
});

describe('the Bitcoin chain data', () => {
  it('matches Appendix A for every network', () => {
    expect(Object.keys(BITCOIN_CHAIN.networks)).toEqual(Object.keys(EXPECTED));
    for (const [id, [genesis, hrp, pkh, sh]] of Object.entries(EXPECTED)) {
      const network = BITCOIN_CHAIN.networks[id] as NetworkInfo;
      expect(network.identity).toBe(genesis);
      expect(network.params).toMatchObject({
        bech32: hrp,
        pubKeyHash: pkh,
        scriptHash: sh,
      });
      expect(network.params).toMatchObject({ dustRelayFee: 3_000n, minRelayFee: 1_000n });
      expect(network.finality).toEqual({ kind: 'confirmations', confirmations: 6 });
      expect(network.testnet).toBe(id !== 'mainnet');
      expect(utxoNetworkConfig(BITCOIN_CHAIN, network).genesisHash).toBe(genesis);
    }
    expect(BITCOIN_CHAIN).toMatchObject({
      family: 'utxo',
      model: 'utxo',
      ordering: 'inputs',
      nativeAsset: { symbol: 'BTC', decimals: 8 },
      schemes: ['secp256k1-ecdsa', 'secp256k1-schnorr'],
    });
  });

  it('is deep-frozen (R56)', () => {
    expect(Object.isFrozen(BITCOIN_CHAIN)).toBe(true);
    expect(Object.isFrozen(mainnet)).toBe(true);
    expect(Object.isFrozen(mainnet.params)).toBe(true);
    expect(Object.isFrozen(mainnet.explorer)).toBe(true);
  });

  it('has explorers only where the templates are verified', () => {
    expect(mainnet.explorer).toEqual({
      tx: 'https://blockstream.info/tx/{id}',
      address: 'https://blockstream.info/address/{address}',
    });
    expect(BITCOIN_CHAIN.networks.testnet?.explorer).toEqual({
      tx: 'https://blockstream.info/testnet/tx/{id}',
      address: 'https://blockstream.info/testnet/address/{address}',
    });
    expect(BITCOIN_CHAIN.networks.signet?.explorer).toEqual({
      tx: 'https://blockstream.info/signet/tx/{id}',
      address: 'https://blockstream.info/signet/address/{address}',
    });
    expect(BITCOIN_CHAIN.networks.testnet4?.explorer).toBeUndefined();
    expect(BITCOIN_CHAIN.networks.regtest?.explorer).toBeUndefined();
  });
});

describe('utxoNetworkConfig (lessons 10 and 14)', () => {
  it('applies the option defaults', () => {
    expect(utxoNetworkConfig(BITCOIN_CHAIN, mainnet)).toMatchObject({
      confirmations: 6,
      maxFeeRate: 1_000_000n,
      maxFee: 10_000_000n,
      minInputConfirmations: 1,
      coinSelection: 'accumulative',
      rbf: true,
      maxEstimatedFeeRate: 200_000n,
      nonWitnessUtxo: true,
      address: { bech32: 'bc', pubKeyHash: 0, scriptHash: 5 },
    });
    expect([...utxoNetworkConfig(BITCOIN_CHAIN, mainnet).capabilities]).toEqual(
      UTXO_CAPABILITIES,
    );
  });

  it('applies valid options, down to the accepted boundaries', () => {
    const options = {
      coinSelection: 'all',
      minInputConfirmations: 0,
      rbf: false,
      nonWitnessUtxo: false,
      maxFee: 1n,
      // Equal to the network's minRelayFee (1,000 sat/kvB): the lowest accepted rate.
      maxFeeRate: 1_000n,
      maxEstimatedFeeRate: 1_000n,
    };
    expect(utxoNetworkConfig(BITCOIN_CHAIN, mainnet, options)).toMatchObject(options);
  });

  it('adds and removes the network capabilities', () => {
    const network = withNetwork({
      capabilities: { add: ['memo'], remove: ['cancel', 'replace-fee'] },
    });
    expect(utxoNetworkConfig(BITCOIN_CHAIN, network).capabilities).toEqual(
      new Set([
        'batch-transfer',
        'block-scan',
        'address-history',
        'hd-public-derivation',
        'memo',
      ]),
    );
  });

  it.each([
    ['a non-genesis identity', withNetwork({ identity: '1' })],
    ['another fee model', withNetwork({ feeModel: 'evm-1559' })],
    [
      'a tag finality',
      withNetwork({
        finality: { kind: 'tag', tag: 'finalized', fallbackConfirmations: 6 },
      }),
    ],
    [
      'zero confirmations',
      withNetwork({ finality: { kind: 'confirmations', confirmations: 0 } }),
    ],
    [
      'fractional confirmations',
      withNetwork({ finality: { kind: 'confirmations', confirmations: 1.5 } }),
    ],
    ['an uppercase HRP', withNetwork({ params: { ...mainnet.params, bech32: 'BC' } })],
    ['a number fee', withNetwork({ params: { ...mainnet.params, dustRelayFee: 3000 } })],
    ['equal prefixes', withNetwork({ params: { ...mainnet.params, scriptHash: 0 } })],
    [
      'a version byte above 255',
      withNetwork({ params: { ...mainnet.params, pubKeyHash: 256 } }),
    ],
    [
      'a negative minRelayFee',
      withNetwork({ params: { ...mainnet.params, minRelayFee: -1n } }),
    ],
    [
      'a number incrementalRelayFee',
      withNetwork({ params: { ...mainnet.params, incrementalRelayFee: 1000 } }),
    ],
    [
      'a string feeFallback',
      withNetwork({ params: { ...mainnet.params, feeFallback: '1000' } }),
    ],
  ])('refuses %s with CONFIG_INVALID', (_name, network) => {
    expect(() => utxoNetworkConfig(BITCOIN_CHAIN, network)).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  it.each([
    [{ maxFee: 1 }],
    [{ maxFee: 0n }],
    [{ maxEstimatedFeeRate: 10n }],
    [{ nonWitnessUtxo: 'yes' }],
    [{ maxFeeRate: -1n }],
    [{ maxFeeRate: 10n }],
    [{ minInputConfirmations: -1 }],
    [{ minInputConfirmations: 0.5 }],
    [{ coinSelection: 'largest' }],
    [{ rbf: 'yes' }],
    [{ unknown: true }],
  ])('refuses the options %p with CONFIG_INVALID', (options) => {
    expect(() => utxoNetworkConfig(BITCOIN_CHAIN, mainnet, options)).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });
});

describe('the Esplora presets', () => {
  const catalog = new PresetCatalog();
  for (const preset of UTXO_PRESETS) catalog.register(preset);
  const url = (name: string, network: string, kind: 'rpc' | 'indexer') =>
    catalog
      .resolve(name, { chain: 'bitcoin', network }, kind)
      .endpoints.map((e) => e.url);

  it('serves the verified base URLs as both rpc and indexer', () => {
    for (const kind of ['rpc', 'indexer'] as const) {
      expect(url('blockstream', 'mainnet', kind)).toEqual([
        'https://blockstream.info/api',
      ]);
      expect(url('blockstream', 'testnet', kind)).toEqual([
        'https://blockstream.info/testnet/api',
      ]);
      expect(url('blockstream', 'signet', kind)).toEqual([
        'https://blockstream.info/signet/api',
      ]);
      expect(url('mempool', 'mainnet', kind)).toEqual(['https://mempool.space/api']);
      expect(url('mempool', 'testnet', kind)).toEqual([
        'https://mempool.space/testnet/api',
      ]);
      expect(url('mempool', 'testnet4', kind)).toEqual([
        'https://mempool.space/testnet4/api',
      ]);
      expect(url('mempool', 'signet', kind)).toEqual([
        'https://mempool.space/signet/api',
      ]);
      expect(url('public', 'mainnet', kind)).toEqual([
        'https://mempool.space/api',
        'https://blockstream.info/api',
      ]);
      // blockstream.info serves no testnet4, so the fallback is mempool.space alone.
      expect(url('public', 'testnet4', kind)).toEqual([
        'https://mempool.space/testnet4/api',
      ]);
    }
    expect(UTXO_PRESETS.every((p) => p.production === false)).toBe(true);
    // R56/M13: the exported presets are frozen, each one too.
    expect(Object.isFrozen(UTXO_PRESETS)).toBe(true);
    expect(UTXO_PRESETS.every((p) => Object.isFrozen(p))).toBe(true);
  });

  it('refuses networks and chains it does not serve', () => {
    for (const [name, network] of [
      ['blockstream', 'testnet4'],
      ['blockstream', 'regtest'],
      ['mempool', 'regtest'],
    ]) {
      expect(() => url(name as string, network as string, 'rpc')).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
    expect(() =>
      catalog.resolve('mempool', { chain: 'ethereum', network: 'mainnet' }, 'rpc'),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('looks up own network keys only, never inherited ones', () => {
    for (const network of ['toString', 'constructor', '__proto__']) {
      for (const preset of UTXO_PRESETS) {
        expect(preset.supports('bitcoin', network)).toBe(false);
      }
      expect(() => url('public', network, 'rpc')).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
  });
});
