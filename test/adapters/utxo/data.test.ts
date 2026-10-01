import { BITCOIN_CHAIN } from '../../../src/adapters/utxo/chains';
import { UTXO_CAPABILITIES, utxoNetworkConfig } from '../../../src/adapters/utxo/network';
import { UTXO_PRESETS } from '../../../src/adapters/utxo/presets';
import type { NetworkInfo } from '../../../src/core/model/chain';
import { PresetCatalog } from '../../../src/core/registry/providers';
import { thrown } from '../../helpers';

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

  it('accepts an HRP of up to 30 letters, the most a p2tr address fits in 90 (M4)', () => {
    const network = withNetwork({
      params: { ...mainnet.params, bech32: 'a'.repeat(30) },
    });
    expect(utxoNetworkConfig(BITCOIN_CHAIN, network).address.bech32).toBe('a'.repeat(30));
  });

  it('removes network capabilities, and adds only those the driver serves (F3-R15)', () => {
    const capabilitiesOf = (capabilities: unknown) =>
      utxoNetworkConfig(
        BITCOIN_CHAIN,
        withNetwork({ capabilities: capabilities as NetworkInfo['capabilities'] }),
      ).capabilities;
    expect(capabilitiesOf({ remove: ['cancel', 'replace-fee'] })).toEqual(
      new Set([
        'batch-transfer',
        'block-scan',
        'address-history',
        'hd-public-derivation',
      ]),
    );
    expect(capabilitiesOf({ add: ['cancel'] })).toEqual(new Set(UTXO_CAPABILITIES));
    const refusal = (capabilities: unknown) =>
      thrown(() => capabilitiesOf(capabilities)) as Error & { code: string };
    const serves =
      'the UTXO driver serves batch-transfer, replace-fee, cancel, block-scan, address-history, hd-public-derivation';
    // The core would accept a memo, and the builder cannot write one (no OP_RETURN).
    for (const capability of [
      'memo',
      'tokens',
      'finality-tag',
      'contract-read',
      'fee-market-1559',
      'expiry',
    ]) {
      for (const side of ['add', 'remove'] as const) {
        expect(refusal({ [side]: [capability] })).toMatchObject({
          code: 'CONFIG_INVALID',
          message: `UTXO network bitcoin:mainnet: capabilities.${side}: '${capability}' is not one; ${serves}`,
        });
      }
    }
    // An unknown name (a typo, or a pasted value) is never echoed.
    for (const capability of ['memos', `xprv${'K'.repeat(107)}`, 42, null]) {
      for (const side of ['add', 'remove'] as const) {
        expect(refusal({ [side]: [capability] }).message).toBe(
          `UTXO network bitcoin:mainnet: capabilities.${side}: an unknown name; ${serves}`,
        );
      }
    }
    expect(refusal({ add: 'memo' }).message).toBe(
      'UTXO network bitcoin:mainnet: capabilities.add and capabilities.remove must be lists',
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
    [
      'an HRP over 30 letters',
      withNetwork({ params: { ...mainnet.params, bech32: 'a'.repeat(31) } }),
    ],
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

  it('never names an unknown option key, listing the accepted ones (F3-R16)', () => {
    const message = (key: string) =>
      (thrown(() => utxoNetworkConfig(BITCOIN_CHAIN, mainnet, { [key]: 1 })) as Error)
        .message;
    for (const key of [
      'maxFeeRates',
      `a.b:c-d_${'e'.repeat(32)}`,
      'e'.repeat(41),
      `xprv${'K'.repeat(107)}`,
      'apiKey=hunter2',
      'key with spaces',
      "it's",
      '',
      'x'.repeat(100_000),
    ]) {
      expect(message(key)).toBe(
        "UTXO network bitcoin:mainnet: unknown option; the accepted names are 'coinSelection', 'maxEstimatedFeeRate', 'maxFee', 'maxFeeRate', 'minInputConfirmations', 'nonWitnessUtxo' and 'rbf'",
      );
    }
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
