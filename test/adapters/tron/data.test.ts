import { TRON_CHAIN } from '../../../src/adapters/tron/chains';
import { TRON_PRESETS, TRONGRID_HOSTS } from '../../../src/adapters/tron/presets';
import { TRON_TOKENS } from '../../../src/adapters/tron/tokens';
import { tronNetworkConfig, MAX_EXPIRATION_MS } from '../../../src/adapters/tron/network';
import { explorerUrl, type NetworkInfo } from '../../../src/core/model/chain';
import { isSecret, reveal, secret } from '../../../src/core/secret/secret';

/** Each network's block 0 id, read from its TronGrid endpoint (`getblockbynum`). */
const GENESIS = {
  mainnet: '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc',
  shasta: '0000000000000000de1aa88295e1fcf982742f773e0419c5a9c134c994a9059e',
  nile: '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc',
};

describe('Tron chain data (verified)', () => {
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
        maxFeeLimit: 100_000_000n,
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

  it('is deep-frozen', () => {
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
    // The codec test pins its hex form, 41a614f803b6fd780986a42c78ec9c7f77e6ded13c.
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
      { ...nile, identity: undefined },
      { ...nile, identity: GENESIS.nile.toUpperCase() },
      { ...nile, feeModel: 'evm-1559' },
      { ...nile, finality: { kind: 'confirmations', confirmations: 19 } as const },
    ]) {
      expect(() => tronNetworkConfig(TRON_CHAIN, network)).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
    for (const chain of [
      { ...TRON_CHAIN, ordering: 'nonce' as const },
      { ...TRON_CHAIN, family: 'evm' },
    ]) {
      expect(() => tronNetworkConfig(chain, nile)).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
    expect(
      tronNetworkConfig(TRON_CHAIN, nile, { expirationMs: MAX_EXPIRATION_MS })
        .expirationMs,
    ).toBe(300_000);
    for (const energyMarginPercent of [0, 1_000]) {
      expect(
        tronNetworkConfig(TRON_CHAIN, nile, { energyMarginPercent }).energyMarginPercent,
      ).toBe(energyMarginPercent);
    }
    for (const options of [
      { expirationMs: 9_999 },
      { expirationMs: 300_001 },
      { energyMarginPercent: -1 },
      { energyMarginPercent: 1_001 },
      { energyMarginPercent: 20.5 },
      { expirationMs: '60000' },
    ]) {
      expect(() => tronNetworkConfig(TRON_CHAIN, nile, options)).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
  });

  it('refuses an unknown option key, listing the accepted names and echoing neither the key nor its value', () => {
    const nile = TRON_CHAIN.networks.nile as NetworkInfo;
    for (const [key, value] of [
      ['expirationMS', 120_000],
      ['feeLimit', 'value-that-must-stay-private'],
      ['constructor', 7_777],
      ['extra', undefined],
      ['sk_live_0123456789abcdef', 1],
    ] as const) {
      let caught: unknown;
      try {
        tronNetworkConfig(TRON_CHAIN, nile, { expirationMs: 60_000, [key]: value });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: 'CONFIG_INVALID',
        message:
          "Tron network tron:nile: unknown option; the accepted names are 'energyMarginPercent', 'expirationMs' and 'maxFeeLimit'",
      });
      const { message } = caught as Error;
      expect(message).not.toContain(key);
      expect(message).not.toContain(String(value));
    }
  });

  it('bounds the fee limit by maxFeeLimit: 100 TRX by default, options › network params › default', () => {
    const nile = TRON_CHAIN.networks.nile as NetworkInfo;
    const own = (params: Record<string, unknown>): NetworkInfo => ({ ...nile, params });
    const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
    expect(tronNetworkConfig(TRON_CHAIN, nile).maxFeeLimit).toBe(100_000_000n);
    expect(tronNetworkConfig(TRON_CHAIN, nile, { maxFeeLimit: 1n }).maxFeeLimit).toBe(1n);
    expect(
      tronNetworkConfig(TRON_CHAIN, nile, { maxFeeLimit: MAX_SAFE }).maxFeeLimit,
    ).toBe(MAX_SAFE);
    // A network of your own may set its own bound; a handle option still wins.
    expect(
      tronNetworkConfig(TRON_CHAIN, own({ maxFeeLimit: 250_000_000n })).maxFeeLimit,
    ).toBe(250_000_000n);
    expect(
      tronNetworkConfig(TRON_CHAIN, own({ maxFeeLimit: 250_000_000n }), {
        maxFeeLimit: 5_000_000n,
      }).maxFeeLimit,
    ).toBe(5_000_000n);
    // Sun as a bigint, from 1 to 2^53 − 1 (what the codec writes exactly); the
    // message names where the value came from, never the value.
    const refusal = (network: NetworkInfo, options?: Record<string, unknown>): string => {
      let caught: unknown;
      try {
        tronNetworkConfig(TRON_CHAIN, network, options);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 'CONFIG_INVALID' });
      return (caught as Error).message;
    };
    for (const value of [
      0n,
      -1n,
      MAX_SAFE + 1n,
      2n ** 64n,
      100_000_000,
      '100000000',
      null,
    ]) {
      expect(refusal(nile, { maxFeeLimit: value })).toBe(
        'Tron network tron:nile: maxFeeLimit must be a bigint of sun from 1 to 2^53 − 1',
      );
      expect(refusal(own({ maxFeeLimit: value }))).toBe(
        'Tron network tron:nile: params.maxFeeLimit must be a bigint of sun from 1 to 2^53 − 1',
      );
      // A bad network value fails loudly even where an option would override it.
      expect(refusal(own({ maxFeeLimit: value }), { maxFeeLimit: 1n })).toContain(
        'params.maxFeeLimit',
      );
    }
    expect(refusal(nile, { maxFeeLimit: 12_345_678_901_234_567n })).not.toContain(
      '12345678901234567',
    );
  });

  it('refuses a capability override the Tron driver cannot serve', () => {
    const nile = TRON_CHAIN.networks.nile as NetworkInfo;
    const withCapabilities = (capabilities: unknown): NetworkInfo => ({
      ...nile,
      capabilities: capabilities as NetworkInfo['capabilities'],
    });
    /** The CONFIG_INVALID message `tronNetworkConfig` throws. */
    const refusal = (network: NetworkInfo, options?: Record<string, unknown>): string => {
      let caught: unknown;
      try {
        tronNetworkConfig(TRON_CHAIN, network, options);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 'CONFIG_INVALID' });
      return (caught as Error).message;
    };
    // A network may drop what the driver has, or list it again.
    for (const capabilities of [
      { remove: ['tokens', 'memo', 'block-scan', 'hd-public-derivation'] },
      { remove: ['address-history'] },
      { add: ['tokens', 'expiry'] },
      { add: ['address-history'], remove: ['address-history'] },
    ]) {
      expect(() =>
        tronNetworkConfig(TRON_CHAIN, withCapabilities(capabilities)),
      ).not.toThrow();
    }
    // Never advertise what the driver lacks: its fee model, finality and features say no.
    for (const capability of [
      'replace-fee',
      'cancel',
      'fee-market-1559',
      'finality-tag',
      'batch-transfer',
      'contract-read',
    ]) {
      expect(refusal(withCapabilities({ add: [capability] }))).toBe(
        `Tron network tron:nile: capabilities.add: the Tron driver does not have '${capability}'`,
      );
    }
    // Only a core capability's fixed name is shown; anything else may be pasted.
    expect(refusal(withCapabilities({ add: ['acme:custom'] }))).toBe(
      'Tron network tron:nile: capabilities.add: the Tron driver does not have an unknown capability',
    );
    expect(refusal(withCapabilities({ add: ['address-history'] }))).toBe(
      "Tron network tron:nile: capabilities.add: 'address-history' comes with an indexer, never from the network",
    );
    expect(refusal(withCapabilities({ remove: ['expiry'] }))).toBe(
      "Tron network tron:nile: capabilities.remove: every Tron transaction expires, so 'expiry' stays",
    );
    // A removal names a Tron capability, so a typo fails instead of leaving it advertised.
    expect(refusal(withCapabilities({ remove: ['memos'] }))).toBe(
      'Tron network tron:nile: capabilities.remove: the Tron driver does not have an unknown capability',
    );
    expect(refusal(withCapabilities({ add: 'memo' }))).toBe(
      'Tron network tron:nile: capabilities.add and capabilities.remove must be lists',
    );
    // A name that is not a core capability is never shown, so a pasted value never is.
    const long = 'x'.repeat(100_000);
    for (const network of [
      withCapabilities({ add: [long] }),
      withCapabilities({ remove: [long] }),
      withCapabilities({ add: ['memo\nsecret-value'] }),
    ]) {
      const message = refusal(network);
      expect(message).toContain('an unknown capability');
      expect(message.length).toBeLessThan(200);
      expect(message).not.toContain('secret-value');
    }
    // An option key is never shown at all: the refusal lists the accepted names instead.
    const message = refusal(nile, { [long]: 1 });
    expect(message).toContain('unknown option;');
    expect(message.length).toBeLessThan(200);
  });
});
