import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CryptoAio,
  createLogger,
  noopLogger,
  secret,
  type NetworkInfo,
  type Plugin,
} from '../../../src';
import { TON_CHAINS } from '../../../src/adapters/ton/chains';
import {
  TON_CAPABILITIES,
  TON_INDEXER_CAPABILITIES,
  TON_PEER_DEPENDENCIES,
} from '../../../src/adapters/ton/index';
import { tonLibraryDriverFactory } from '../../../src/adapters/ton/native-client';
import { tonManifest, tonPlugin } from '../../../src/adapters/ton/plugin';
import { TON_PRESETS } from '../../../src/adapters/ton/presets';
import { TON_TOKENS } from '../../../src/adapters/ton/tokens';
import { samePlugin } from '../../../src/core/registry/plugin';
import { drive } from '../../../src/testing/fake-clock';
import { thrown } from '../../helpers';
import { tonClock } from './support/harness';
import { ScriptedTonNode } from './support/node';
import { PUBLIC_KEY, TEST_WALLETS } from './support/vectors';

const ROOT = join(__dirname, '..', '..', '..');
const GRAM = 1_000_000_000n;

function container(extra: Partial<ConstructorParameters<typeof CryptoAio>[0]> = {}) {
  const clock = tonClock();
  const node = new ScriptedTonNode({ clock });
  const aio = new CryptoAio({
    env: false,
    logger: noopLogger,
    clock,
    transport: { fetch: node.fetch.fetch, baseDelayMs: 1, maxDelayMs: 2 },
    providers: {
      node: { endpoints: [{ url: node.endpoint('main', 'v2') }] },
      nodeIndex: { endpoints: [{ url: node.endpoint('main', 'v3'), kind: 'indexer' }] },
    },
    // A watch-only v4r2 wallet: enough to estimate a transfer, nothing to sign with.
    wallets: { hot: { publicKey: PUBLIC_KEY, ton: { version: 'v4r2' } } },
    ...extra,
  });
  return { aio, node, run: <T>(p: Promise<T>) => drive(clock, p) };
}

/**
 * A TON network of the user's own (a copy of testnet under another chain id), served by the
 * built-in manifest: how a network's `params` and capability overrides reach the driver.
 */
function customTon(name: string, patch: Partial<NetworkInfo>): Plugin {
  const [ton] = TON_CHAINS;
  const testnet = ton?.networks.testnet as NetworkInfo;
  return {
    name,
    chains: [
      {
        ...ton!,
        id: name,
        defaultNetwork: 'testnet',
        networks: { testnet: { ...testnet, ...patch } },
      },
    ],
    adapters: [{ ...tonManifest, family: name, chains: [name] }],
  };
}

describe('the built-in TON plugin', () => {
  it('registers ton with @ton/ton, one output per transfer, the indexer capabilities and the balance path', async () => {
    const { aio, node, run } = container();
    const ton = aio.blockchain({
      chain: 'ton',
      network: 'testnet',
      provider: 'node',
      indexer: 'nodeIndex',
    });
    expect([ton.chain, ton.network, ton.library]).toEqual(['ton', 'testnet', '@ton/ton']);
    // F6-R15: no `batch-transfer`; the driver's limit is one output whatever the wallet.
    expect([...ton.capabilities].sort()).toEqual([
      'address-history',
      'expiry',
      'memo',
      'tokens',
    ]);
    expect(ton.supports('batch-transfer')).toBe(false);
    expect(ton.supports('block-scan')).toBe(false);
    node.fund(TEST_WALLETS.v4r2.basechain, 12n);
    await run(ton.ready());
    expect(await run(ton.limits())).toEqual({ maxOutputs: 1 });
    expect(await run(ton.with({ wallet: 'hot' }).limits())).toEqual({ maxOutputs: 1 });
    expect((await run(ton.getBalance(TEST_WALLETS.v4r2.basechain))).amount.base).toBe(
      12n,
    );
    expect(
      (await run(ton.getBalance(TEST_WALLETS.v4r2.basechain))).amount.asset.metadata
        .symbol,
    ).toBe('GRAM');
    expect(() => ton.scanner({ cursorKey: 'x', from: 'latest', mode: 'final' })).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }),
    );
    await aio.close();
  });

  it('falls back to the public indexer, with a warning, when none is configured', async () => {
    const warnings: string[] = [];
    const { aio } = container({
      logger: createLogger('test', (level, _namespace, message) => {
        if (level === 'warn') warnings.push(message);
      }),
    });
    const ton = aio.blockchain({ chain: 'ton', network: 'testnet', provider: 'node' });
    expect(ton.config).toMatchObject({
      indexers: [{ name: 'public', production: false }],
    });
    expect(warnings).toEqual([
      'no indexer provider configured; using the public provider (not for production)',
    ]);
    expect(() => aio.blockchain({ chain: 'ton', provider: 'toncenter' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    expect(() =>
      aio.blockchain({ chain: 'ton', library: 'tonweb' as '@ton/ton', provider: 'node' }),
    ).toThrow(
      expect.objectContaining({
        code: 'INCOMPATIBLE_SELECTION',
        message: expect.stringContaining('supported: @ton/ton'),
      }),
    );
    await aio.close();
  });

  it('keeps the toncenter key in a secret header, out of the config view and every error', async () => {
    const key = 'a1b2'.repeat(16);
    const { aio, node, run } = container({
      providers: { tc: { preset: 'toncenter', apiKey: secret(key) } },
    });
    // toncenter answers every request with a server error: the probes fail, and ready() too.
    const seen: string[] = [];
    node.fetch.route('https://testnet.toncenter.com', (request) => {
      seen.push(`${request.url.href} ${request.headers.get('X-API-Key') ?? '-'}`);
      return { status: 503, json: { ok: false, error: 'unavailable', code: 503 } };
    });
    const ton = aio.blockchain({
      chain: 'ton',
      network: 'testnet',
      provider: 'tc',
      indexer: 'tc',
    });
    expect(ton.config).toMatchObject({
      providers: [{ name: 'tc', production: true }],
      indexers: [{ name: 'tc', production: true }],
    });
    expect(JSON.stringify(ton.config)).not.toContain(key.slice(0, 8));
    const error = (await run(ton.ready()).catch((caught: unknown) => caught)) as Error;
    expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    // The key went out in the header only, and comes back in no error.
    expect(seen.length).toBeGreaterThan(0);
    for (const line of seen) {
      expect(line).toMatch(/^https:\/\/testnet\.toncenter\.com\/api\/v[23]\/\S* a1b2/);
      expect(line.split(' ')[0]).not.toContain(key.slice(0, 8));
    }
    expect(
      [error.message, JSON.stringify(error), String(error.stack)].join('\n'),
    ).not.toContain(key.slice(0, 8));
    await aio.close();
  });

  it('resolves GRAM, TON and USDT by alias, each only on its own network', async () => {
    const { aio, run } = container();
    const main = aio.blockchain({ chain: 'ton', provider: 'node', indexer: 'nodeIndex' });
    expect((await run(main.resolveAsset('TON'))).id).toBe('ton:mainnet/native');
    expect((await run(main.resolveAsset('GRAM'))).id).toBe('ton:mainnet/native');
    expect((await run(main.resolveAsset('USDT'))).id).toBe(
      'ton:mainnet/jetton:0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe',
    );
    const test = main.with({ network: 'testnet' });
    await expect(run(test.resolveAsset('USDT'))).rejects.toMatchObject({
      code: 'ASSET_RESOLUTION',
    });
    await aio.close();
  });

  it('is data only: the plugin files import no SDK, and plugin.ts no driver module', () => {
    expect(tonPlugin().adapters).toEqual([tonManifest]);
    expect(tonManifest).toMatchObject({
      family: 'ton',
      library: '@ton/ton',
      chains: ['ton'],
      requiresIndexer: true,
      indexerCapabilities: ['address-history'],
    });
    // Keyed by package (Plan 2's final shape); the one library needs all three.
    expect(TON_PEER_DEPENDENCIES).toEqual({
      '@ton/ton': { name: '@ton/ton', range: '^16.3.0' },
      '@ton/core': { name: '@ton/core', range: '^0.63.1' },
      '@ton/crypto': { name: '@ton/crypto', range: '^3.3.0' },
    });
    expect(tonManifest.peerDependencies).toEqual(Object.values(TON_PEER_DEPENDENCIES));
    const source = (file: string): string =>
      readFileSync(join(ROOT, 'src', 'adapters', 'ton', `${file}.ts`), 'utf8');
    for (const file of [
      'plugin',
      'types',
      'chains',
      'presets',
      'tokens',
      'address',
      'api',
      'network',
      'fees',
      'errors',
    ]) {
      expect([file, /(from |require\(|import\()'@ton\//.test(source(file))]).toEqual([
        file,
        false,
      ]);
    }
    // M10: plugin.ts reaches the library module only through `load()`'s `require`, and never
    // names driver.ts at all (lazy.test.ts proves it at run time).
    const plugin = source('plugin');
    expect(plugin).not.toMatch(/from '\.\/(driver|native-client|builder|reader)'/);
    expect(plugin).not.toMatch(/'\.\/driver'/);
    expect(plugin.match(/require\('[^']*'\)/g)).toEqual(["require('./native-client')"]);
  });

  it('serves exactly TON_CAPABILITIES, with no batch-transfer, and loads tonLibraryDriverFactory', async () => {
    expect(tonManifest.capabilities).toBe(TON_CAPABILITIES);
    expect([...tonManifest.capabilities].sort()).toEqual(['expiry', 'memo', 'tokens']);
    expect(tonManifest.capabilities).not.toContain('batch-transfer');
    expect(tonManifest.indexerCapabilities).toBe(TON_INDEXER_CAPABILITIES);
    expect(await tonManifest.load()).toBe(tonLibraryDriverFactory);
  });

  it('pins the SDK ranges package.json declares as optional peers and pins for tests (R82)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<
      'peerDependencies' | 'devDependencies',
      Record<string, string>
    > & { peerDependenciesMeta: Record<string, { optional?: boolean }> };
    const peers = Object.values(TON_PEER_DEPENDENCIES);
    expect(peers.map((d) => d.name)).toEqual(['@ton/ton', '@ton/core', '@ton/crypto']);
    for (const { name, range } of peers) {
      expect([name, pkg.peerDependencies[name]]).toEqual([name, range]);
      expect([name, pkg.peerDependenciesMeta[name]?.optional]).toEqual([name, true]);
      expect([name, `^${pkg.devDependencies[name]}`]).toEqual([name, range]);
    }
  });

  it('ships frozen data: the manifest, its lists and the peer entries (R56)', () => {
    const plugin = tonPlugin();
    expect(plugin).toMatchObject({ name: 'ton' });
    expect(plugin.chains).toBe(TON_CHAINS);
    expect(plugin.presets).toBe(TON_PRESETS);
    expect(plugin.assets).toBe(TON_TOKENS);
    for (const value of [
      tonManifest,
      tonManifest.chains,
      tonManifest.capabilities,
      tonManifest.indexerCapabilities,
      tonManifest.peerDependencies,
      TON_PEER_DEPENDENCIES,
      ...Object.values(TON_PEER_DEPENDENCIES),
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it('ships frozen toncenter presets: a keyless rate only as toncenter publishes it, burst 1 (A28, F6-R3)', () => {
    const { presets } = tonPlugin();
    expect(presets?.every((preset) => Object.isFrozen(preset))).toBe(true);
    const rates = (presets ?? []).flatMap((preset) =>
      ['mainnet', 'testnet'].flatMap((network) =>
        preset
          .endpoints({
            chain: 'ton',
            network,
            ...(preset.requiresApiKey ? { apiKey: secret('k') } : {}),
          })
          .map((endpoint) => [preset.name, preset.kind, network, endpoint.rateLimit]),
      ),
    );
    // Toncenter publishes 1 request per second keyless and 10 with a free key, per network
    // for v2 and v3 together (X2: half each); the keyed burst is one (F6-R3).
    expect(rates).toEqual(
      [
        ['public', 'rpc'],
        ['public', 'indexer'],
        ['toncenter', 'rpc'],
        ['toncenter', 'indexer'],
      ].flatMap(([name, kind]) =>
        ['mainnet', 'testnet'].map((network) => [
          name,
          kind,
          network,
          name === 'public' ? { rps: 0.5 } : { rps: 5, burst: 1 },
        ]),
      ),
    );
  });

  it("takes a network's maxNetworkFee from the plugin's network config into the builder (F6-R17)", async () => {
    const { aio, node, run } = container({
      plugins: [
        customTon('tonlab', {
          params: {
            ...TON_CHAINS[0]?.networks.testnet?.params,
            maxNetworkFee: { basechain: 1n },
          },
        }),
      ],
    });
    node.fund(TEST_WALLETS.v4r2.basechain, 3n * GRAM);
    const intent = { to: TEST_WALLETS.v5r1.testnet, amount: GRAM };
    const handle = (chain: string) =>
      aio.blockchain({
        chain: chain as 'ton',
        network: 'testnet',
        provider: 'node',
        indexer: 'nodeIndex',
        wallet: 'hot',
      });
    expect((await run(handle('ton').estimateFee(intent))).kind).toBe('ton');
    await expect(run(handle('tonlab').estimateFee(intent))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      message: expect.stringContaining('the policy maximum'),
      retryable: true,
    });
    await aio.close();
  });

  it('takes maxNetworkFee from the handle and chain options on the built-in networks (F6-R24, F6-R25)', async () => {
    const { aio, node, run } = container({
      chains: {
        ton: { network: 'testnet', options: { maxNetworkFee: { basechain: 1n } } },
      },
    });
    node.fund(TEST_WALLETS.v4r2.basechain, 3n * GRAM);
    const intent = { to: TEST_WALLETS.v5r1.testnet, amount: GRAM };
    const handle = (options?: Readonly<Record<string, unknown>>) =>
      aio.blockchain({
        chain: 'ton',
        network: 'testnet',
        provider: 'node',
        indexer: 'nodeIndex',
        wallet: 'hot',
        ...(options ? { options } : {}),
      });
    await expect(run(handle().estimateFee(intent))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      message: expect.stringContaining('the policy maximum'),
    });
    expect(
      (await run(handle({ maxNetworkFee: { basechain: GRAM } }).estimateFee(intent)))
        .kind,
    ).toBe('ton');
    await expect(
      run(handle({ maxNetworkFe: { basechain: GRAM } }).estimateFee(intent)),
    ).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringContaining("the TON driver's only option is 'maxNetworkFee'"),
    });
    await aio.close();
  });

  it.each(['batch-transfer', 'block-scan', 'replace-fee'])(
    'refuses a plugin network that adds %s, before any traffic (Task 11)',
    async (capability) => {
      const { aio, node, run } = container({
        plugins: [customTon('tonlab', { capabilities: { add: [capability] } })],
      });
      const bc = aio.blockchain({
        chain: 'tonlab' as 'ton',
        provider: 'node',
        indexer: 'nodeIndex',
      });
      await expect(run(bc.ready())).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
        message: `TON network tonlab:testnet: '${capability}' is not available on TON`,
      });
      expect(node.served).toEqual([]);
      await aio.close();
    },
  );
});

describe('the built-in TON plugin registered again (A18)', () => {
  it('keeps use() idempotent for the same plugin, and refuses another named ton', async () => {
    // The composition root already registered tonPlugin(); these are fresh copies of it.
    expect(samePlugin(tonPlugin(), tonPlugin())).toBe(true);
    const { aio } = container({ plugins: [tonPlugin()] });
    expect(() => aio.use(tonPlugin())).not.toThrow();
    // Functions match by identity: the same manifest around a new `load` is another plugin.
    const rebuilt = {
      ...tonPlugin(),
      adapters: [{ ...tonManifest, load: () => tonManifest.load() }],
    };
    for (const other of [{ name: 'ton' }, rebuilt]) {
      expect(thrown(() => aio.use(other))).toMatchObject({
        code: 'CONFIG_INVALID',
        message: "plugin 'ton' is already registered with a different definition",
      });
    }
    await aio.close();
  });
});

describe('the crypto-aio/ton entry', () => {
  // The key order of every family's entries is test/architecture/packaging.test.ts's rule.
  it('publishes CJS and types, typesVersions and the API docs', () => {
    const read = (file: string): unknown =>
      JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
    const pkg = read('package.json') as {
      exports: Record<string, unknown>;
      typesVersions: Record<string, Record<string, string[]>>;
    };
    expect(pkg.exports['./ton']).toEqual({
      types: './dist/adapters/ton/index.d.ts',
      default: './dist/adapters/ton/index.js',
    });
    expect(pkg.typesVersions['*']?.ton).toEqual(['dist/adapters/ton/index.d.ts']);
    const { entryPoints } = read('typedoc.json') as { entryPoints: string[] };
    expect(entryPoints).toContain('src/adapters/ton/index.ts');
  });
});
