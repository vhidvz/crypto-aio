import { TRON_CHAIN } from '../../../src/adapters/tron/chains';
import { TRON_PRESETS, TRONGRID_HOSTS } from '../../../src/adapters/tron/presets';
import { TRON_TOKENS } from '../../../src/adapters/tron/tokens';
import { tronNetworkConfig, MAX_EXPIRATION_MS } from '../../../src/adapters/tron/network';
import { explorerUrl, type NetworkInfo } from '../../../src/core/model/chain';
import { isSecret, reveal, secret } from '../../../src/core/secret/secret';

/** Plan 4 Appendix A: each value read from its cited source. */
const GENESIS = {
  mainnet: '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc',
  shasta: '0000000000000000de1aa88295e1fcf982742f773e0419c5a9c134c994a9059e',
  nile: '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc',
};

describe('Tron chain data (verified, Appendix A)', () => {
  it('pins each network identity (block 0) and its explorer', () => {
    expect(Object.keys(TRON_CHAIN.networks)).toEqual(['mainnet', 'shasta', 'nile']);
    for (const [id, genesis] of Object.entries(GENESIS)) {
      const network = TRON_CHAIN.networks[id] as NetworkInfo;
      expect(network).toMatchObject({
        identity: genesis,
        testnet: id !== 'mainnet',
        feeModel: 'tron',
        finality: { kind: 'solidified' },
        defaultConfirmations: 1,
        reorgWindow: 64,
        maxLagBlocks: 20,
      });
      expect(tronNetworkConfig(TRON_CHAIN, network)).toEqual({
        identity: genesis,
        expirationMs: 60_000,
        energyMarginPercent: 20,
      });
    }
    expect(TRON_CHAIN).toMatchObject({
      family: 'tron',
      model: 'account',
      ordering: 'expiry',
      schemes: ['secp256k1-ecdsa'],
      nativeAsset: { symbol: 'TRX', decimals: 6 },
      defaultNetwork: 'mainnet',
    });
    expect(explorerUrl(TRON_CHAIN.networks.mainnet as NetworkInfo, 'tx', 'ab')).toBe(
      'https://tronscan.org/#/transaction/ab',
    );
    expect(explorerUrl(TRON_CHAIN.networks.nile as NetworkInfo, 'address', 'TX')).toBe(
      'https://nile.tronscan.org/#/address/TX',
    );
  });

  it('is deep-frozen (R56)', () => {
    expect(Object.isFrozen(TRON_CHAIN.networks.nile?.finality)).toBe(true);
    expect(Object.isFrozen(TRON_TOKENS[0]?.ref)).toBe(true);
    expect(Object.isFrozen(TRONGRID_HOSTS)).toBe(true);
    expect(Object.isFrozen(TRON_PRESETS)).toBe(true);
    expect(TRON_PRESETS.every((preset) => Object.isFrozen(preset))).toBe(true);
  });

  it('pins the token catalog: USDT on mainnet only, 6 decimals', () => {
    expect(TRON_TOKENS).toEqual([
      {
        chain: 'tron',
        network: 'mainnet',
        ref: { standard: 'trc20', contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
        metadata: { symbol: 'USDT', decimals: 6 },
        aliases: ['USDT'],
      },
    ]);
    // Task 2's codec test pins its hex form, 41a614f803b6fd780986a42c78ec9c7f77e6ded13c.
    expect(TRON_TOKENS[0]?.ref).toMatchObject({
      contract: expect.stringMatching(/^T[1-9A-HJ-NP-Za-km-z]{33}$/),
    });
  });

  it('pins the TronGrid hosts and the preset kinds', () => {
    expect(TRONGRID_HOSTS).toEqual({
      mainnet: 'https://api.trongrid.io',
      shasta: 'https://api.shasta.trongrid.io',
      nile: 'https://nile.trongrid.io',
    });
    expect(
      TRON_PRESETS.map((p) => [
        p.name,
        p.kind,
        p.requiresApiKey ?? false,
        p.production ?? true,
      ]),
    ).toEqual([
      ['public', 'rpc', false, false],
      ['trongrid', 'rpc', true, true],
      ['public', 'indexer', false, false],
      ['trongrid', 'indexer', true, true],
    ]);
  });

  it('sends the TronGrid key only as a Secret header, and never names it', () => {
    const key = 'tron-key-1234';
    const [trongrid] = TRON_PRESETS.filter(
      (p) => p.name === 'trongrid' && p.kind === 'indexer',
    );
    const [endpoint] =
      trongrid?.endpoints({ chain: 'tron', network: 'nile', apiKey: secret(key) }) ?? [];
    expect(endpoint).toMatchObject({ url: 'https://nile.trongrid.io', kind: 'indexer' });
    const header = endpoint?.headers?.['TRON-PRO-API-KEY'];
    expect(isSecret(header) && reveal(header)).toBe(key);
    expect(JSON.stringify(endpoint)).not.toContain(key);
    for (const apiKey of [undefined, ' ', secret('')]) {
      expect(() =>
        trongrid?.endpoints({ chain: 'tron', network: 'nile', apiKey }),
      ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    }
    const [open] =
      TRON_PRESETS[0]?.endpoints({ chain: 'tron', network: 'mainnet' }) ?? [];
    expect(open).toEqual({
      name: 'trongrid-public',
      url: 'https://api.trongrid.io',
      kind: 'rpc',
    });
    expect(TRON_PRESETS[0]?.supports('tron', 'nile')).toBe(true);
    expect(TRON_PRESETS[0]?.supports('tron', 'toString')).toBe(false);
    expect(TRON_PRESETS[0]?.supports('ethereum', 'mainnet')).toBe(false);
  });

  it('validates a network of your own with CONFIG_INVALID', () => {
    const nile = TRON_CHAIN.networks.nile as NetworkInfo;
    for (const network of [
      { ...nile, identity: '0xabc' },
      { ...nile, feeModel: 'evm-1559' },
      { ...nile, finality: { kind: 'confirmations', confirmations: 19 } as const },
    ]) {
      expect(() => tronNetworkConfig(TRON_CHAIN, network)).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
    expect(() => tronNetworkConfig({ ...TRON_CHAIN, ordering: 'nonce' }, nile)).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    expect(
      tronNetworkConfig(TRON_CHAIN, nile, { expirationMs: MAX_EXPIRATION_MS })
        .expirationMs,
    ).toBe(300_000);
    for (const options of [
      { expirationMs: 9_999 },
      { expirationMs: 300_001 },
      { energyMarginPercent: -1 },
      { expirationMs: '60000' },
    ]) {
      expect(() => tronNetworkConfig(TRON_CHAIN, nile, options)).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
  });
});
