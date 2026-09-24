import type { AdapterManifest } from '../../../src/core/driver/types';
import type { ChainInfo } from '../../../src/core/model/chain';
import {
  applyPlugin,
  cloneCatalogs,
  createCatalogs,
} from '../../../src/core/registry/plugin';
import type { ProviderPreset } from '../../../src/core/registry/providers';
import { reveal, secret } from '../../../src/core/secret/secret';
import { thrown } from '../../helpers';

const chain: ChainInfo = {
  id: 'testchain',
  family: 'test',
  model: 'account',
  ordering: 'nonce',
  schemes: ['secp256k1-ecdsa'],
  nativeAsset: { symbol: 'TST', decimals: 18 },
  defaultNetwork: 'local',
  networks: {
    local: {
      id: 'local',
      testnet: true,
      feeModel: 'flat',
      finality: { kind: 'confirmations', confirmations: 2 },
      defaultConfirmations: 1,
      reorgWindow: 5,
    },
  },
};

const manifest = (overrides: Partial<AdapterManifest> = {}): AdapterManifest => ({
  family: 'test',
  library: 'lib-a',
  chains: ['testchain'],
  capabilities: ['memo'],
  peerDependencies: [{ name: 'test-sdk', range: '^1.0.0' }],
  load: async () => ({
    create: async () => {
      throw new Error('not used');
    },
  }),
  ...overrides,
});

const acme: ProviderPreset = {
  name: 'acme',
  kind: 'rpc',
  requiresApiKey: true,
  supports: (c, n) => c === 'testchain' && n === 'local',
  endpoints: ({ network, apiKey }) => [
    { url: secret(`https://acme.test/${network}/${reveal(apiKey ?? '')}`) },
  ],
};

describe('plugins', () => {
  it('registers chains, native assets, adapters, presets and assets once', () => {
    const catalogs = createCatalogs();
    const plugin = {
      name: 'test',
      chains: [chain],
      adapters: [manifest()],
      presets: [acme],
      assets: [
        {
          chain: 'testchain',
          network: 'local',
          ref: { standard: 'tok', contract: '0x1' },
          metadata: { symbol: 'USD', decimals: 6 },
          aliases: ['USD'],
        },
      ],
    };
    applyPlugin(catalogs, plugin);
    applyPlugin(catalogs, plugin);
    expect(catalogs.chains.get('testchain').id).toBe('testchain');
    expect(catalogs.assets.resolveAlias('testchain', 'local', 'TST').ref).toBe('native');
    expect(
      catalogs.assets.resolveAlias('testchain', 'local', 'usd').metadata.decimals,
    ).toBe(6);
    expect(catalogs.adapters.forChain('testchain').map((m) => m.library)).toEqual([
      'lib-a',
    ]);
    expect(catalogs.presets.has('acme')).toBe(true);
  });

  it('validates cross references', () => {
    expect(
      thrown(() =>
        applyPlugin(createCatalogs(), {
          name: 'x',
          adapters: [manifest({ chains: ['nope'] })],
        }),
      ),
    ).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(
      thrown(() =>
        applyPlugin(createCatalogs(), {
          name: 'x',
          chains: [{ ...chain, schemes: ['bls'] }],
        }),
      ),
    ).toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/unknown signature scheme 'bls'/),
    });
    const catalogs = createCatalogs();
    applyPlugin(catalogs, { name: 'a', chains: [chain], adapters: [manifest()] });
    expect(
      thrown(() => applyPlugin(catalogs, { name: 'b', adapters: [manifest()] })),
    ).toMatchObject({
      message: expect.stringMatching(/already registered/),
    });
  });

  it('clones catalogs independently', () => {
    const catalogs = createCatalogs();
    const copy = cloneCatalogs(catalogs);
    applyPlugin(copy, { name: 'test', chains: [chain] });
    expect(catalogs.chains.has('testchain')).toBe(false);
    expect(catalogs.plugins.has('test')).toBe(false);
  });
});

describe('PresetCatalog', () => {
  const catalogs = createCatalogs();
  applyPlugin(catalogs, { name: 'test', chains: [chain], presets: [acme] });

  it('resolves supported presets and enforces API keys', () => {
    const { endpoints } = catalogs.presets.resolve(
      'acme',
      { chain: 'testchain', network: 'local', apiKey: secret('K1') },
      'rpc',
    );
    expect(reveal(endpoints[0]!.url)).toBe('https://acme.test/local/K1');
    expect(
      thrown(() =>
        catalogs.presets.resolve('acme', { chain: 'testchain', network: 'local' }, 'rpc'),
      ),
    ).toMatchObject({
      message: expect.stringMatching(/requires an apiKey/),
    });
    expect(
      thrown(() =>
        catalogs.presets.resolve(
          'acme',
          { chain: 'testchain', network: 'main', apiKey: 'k' },
          'rpc',
        ),
      ),
    ).toMatchObject({
      message: expect.stringMatching(/does not support testchain:main/),
    });
    expect(
      thrown(() =>
        catalogs.presets.resolve(
          'acme',
          { chain: 'testchain', network: 'local' },
          'indexer',
        ),
      ),
    ).toMatchObject({
      message: expect.stringMatching(/unknown indexer provider preset 'acme'/),
    });
  });
});

describe('AdapterCatalog.load', () => {
  it('caches successful loads', async () => {
    const catalogs = createCatalogs();
    applyPlugin(catalogs, { name: 'test', chains: [chain] });
    let loads = 0;
    const m = manifest({
      load: async () => {
        loads += 1;
        return {
          create: async () => {
            throw new Error('unused');
          },
        };
      },
    });
    catalogs.adapters.register(m);
    await catalogs.adapters.load(m);
    await catalogs.adapters.load(m);
    expect(loads).toBe(1);
  });

  it('maps missing modules to DEPENDENCY_MISSING with an install hint and does not cache failures', async () => {
    const catalogs = createCatalogs();
    let attempts = 0;
    const m = manifest({
      load: async () => {
        attempts += 1;
        throw Object.assign(new Error("Cannot find module 'test-sdk'"), {
          code: 'MODULE_NOT_FOUND',
        });
      },
    });
    await expect(catalogs.adapters.load(m)).rejects.toMatchObject({
      code: 'DEPENDENCY_MISSING',
      message: expect.stringMatching(/npm i test-sdk@\^1\.0\.0/),
      details: { packages: ['test-sdk'] },
    });
    await expect(catalogs.adapters.load(m)).rejects.toMatchObject({
      code: 'DEPENDENCY_MISSING',
    });
    expect(attempts).toBe(2);
  });

  it('rethrows unrelated load errors untouched', async () => {
    const boom = new Error('syntax error in adapter');
    const m = manifest({
      load: async () => {
        throw boom;
      },
    });
    await expect(createCatalogs().adapters.load(m)).rejects.toBe(boom);
  });
});
