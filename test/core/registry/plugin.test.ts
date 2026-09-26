import type { AdapterManifest } from '../../../src/core/driver/types';
import type { ChainInfo } from '../../../src/core/model/chain';
import {
  applyPlugin,
  cloneCatalogs,
  createCatalogs,
  samePlugin,
  type Plugin,
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

  it('keeps the missing-module error as the cause of DEPENDENCY_MISSING', async () => {
    const missing = Object.assign(new Error("Cannot find module 'test-sdk'"), {
      code: 'MODULE_NOT_FOUND',
    });
    const m = manifest({
      load: async () => {
        throw missing;
      },
    });
    const error = await createCatalogs()
      .adapters.load(m)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'DEPENDENCY_MISSING' });
    expect((error as Error).cause).toBe(missing);
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

  it('rethrows a missing module that is not a peer dependency unchanged, never "install <peer>"', async () => {
    // A broken build: the adapter module itself is missing, while the SDK is installed.
    const missing = Object.assign(
      new Error(
        "Cannot find module './ethers-client'\nRequire stack:\n- /app/dist/adapters/evm/plugin.js",
      ),
      { code: 'MODULE_NOT_FOUND' },
    );
    const m = manifest({
      peerDependencies: [{ name: 'ethers', range: '^6.17.0' }],
      load: async () => {
        throw missing;
      },
    });
    await expect(createCatalogs().adapters.load(m)).rejects.toBe(missing);
  });
});

describe('duplicate plugin names (A18, A25)', () => {
  // A factory that reuses its functions, as the built-in ones do: fresh objects around the
  // same function objects.
  const shared = manifest();
  const supports: ProviderPreset['supports'] = (c, n) =>
    c === 'testchain' && n === 'local';
  const build = (overrides: Partial<Plugin> = {}): Plugin => ({
    name: 'test',
    chains: [{ ...chain, networks: { ...chain.networks } }],
    adapters: [{ ...shared }],
    presets: [{ ...acme, supports }],
    ...overrides,
  });

  it('accepts the same plugin again, and a structurally identical one, as a no-op', () => {
    const catalogs = createCatalogs();
    const plugin = build();
    applyPlugin(catalogs, plugin);
    applyPlugin(catalogs, plugin);
    applyPlugin(catalogs, build());
    expect(catalogs.chains.list().map((c) => c.id)).toEqual(['testchain']);
  });

  it('refuses a different plugin under a registered name, leaving the catalogs as they were', () => {
    const catalogs = createCatalogs();
    applyPlugin(catalogs, build());
    const other = [
      { name: 'test' },
      build({ chains: [{ ...chain, nativeAsset: { symbol: 'TST', decimals: 6 } }] }),
      build({
        adapters: [
          manifest({
            load: async () => {
              throw new Error('another driver');
            },
          }),
        ],
      }),
    ];
    for (const plugin of other) {
      expect(thrown(() => applyPlugin(catalogs, plugin))).toMatchObject({
        code: 'CONFIG_INVALID',
        message: "plugin 'test' is already registered with a different definition",
      });
    }
    expect(catalogs.chains.get('testchain').nativeAsset.decimals).toBe(18);
  });

  it('refuses two plugins whose closures capture different values (A25)', () => {
    const presetFor = (url: string): ProviderPreset => ({
      ...acme,
      endpoints: () => [{ url }],
    });
    const catalogs = createCatalogs();
    applyPlugin(catalogs, build({ presets: [presetFor('https://a.test')] }));
    expect(
      thrown(() =>
        applyPlugin(catalogs, build({ presets: [presetFor('https://b.test')] })),
      ),
    ).toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('compares data structurally, and functions and class instances by identity (A25)', () => {
    const withValue = (value: unknown) =>
      ({ name: 'p', chains: [value] }) as unknown as Plugin;
    const same = () => 1;
    function bound(this: unknown): unknown {
      return this;
    }
    const pattern = /x/;
    expect(samePlugin(withValue(same), withValue(same))).toBe(true);
    expect(
      samePlugin(
        withValue(() => 1),
        withValue(() => 1),
      ),
    ).toBe(false);
    expect(samePlugin(withValue(bound.bind(1)), withValue(bound.bind(2)))).toBe(false);
    expect(samePlugin(withValue(pattern), withValue(pattern))).toBe(true);
    expect(samePlugin(withValue(/x/), withValue(/x/))).toBe(false);
    expect(samePlugin(withValue({ a: 1n }), withValue({ a: 1n }))).toBe(true);
    expect(samePlugin(withValue({ a: 1 }), withValue({ a: 1, b: undefined }))).toBe(
      false,
    );
  });
});
