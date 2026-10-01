import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CryptoAio, noopLogger } from '../../../src';
import { SOLANA_PEER_DEPENDENCIES } from '../../../src/adapters/solana/index';
import { solanaPlugin } from '../../../src/adapters/solana/plugin';
import { SOLANA_PRESETS } from '../../../src/adapters/solana/presets';
import { SOLANA_TOKENS } from '../../../src/adapters/solana/tokens';
import { samePlugin } from '../../../src/core/registry/plugin';
import { FakeClock, drive } from '../../../src/testing/fake-clock';
import { thrown } from '../../helpers';
import { ScriptedSolanaNode } from './support/node';
import { KEY_ADDRESS } from './support/vectors';

function container(extra: Partial<ConstructorParameters<typeof CryptoAio>[0]> = {}) {
  const clock = new FakeClock();
  const node = new ScriptedSolanaNode({ clock });
  const aio = new CryptoAio({
    env: false,
    logger: noopLogger,
    clock,
    transport: { fetch: node.fetch.fetch, baseDelayMs: 1, maxDelayMs: 2 },
    providers: { local: { endpoints: [{ url: node.endpoint('main') }] } },
    ...extra,
  });
  return { aio, node, run: <T>(p: Promise<T>) => drive(clock, p) };
}

describe('the built-in Solana plugin', () => {
  it('registers solana with @solana/web3.js as its library', async () => {
    const { aio, node, run } = container();
    const sol = aio.blockchain({ chain: 'solana', network: 'devnet', provider: 'local' });
    expect([sol.chain, sol.network, sol.library]).toEqual([
      'solana',
      'devnet',
      '@solana/web3.js',
    ]);
    expect([...sol.capabilities].sort()).toEqual([
      'address-history',
      'block-scan',
      'expiry',
      'memo',
      'tokens',
    ]);
    node.fund(KEY_ADDRESS, 12n);
    node.produce(1);
    await run(sol.ready());
    expect((await run(sol.getBalance(KEY_ADDRESS))).amount.toDecimalString()).toBe(
      '0.000000012',
    );
    expect(aio.blockchain({ chain: 'solana', provider: 'public' }).network).toBe(
      'mainnet',
    );
    expect(() =>
      aio.blockchain({ chain: 'solana', network: 'testnet', provider: 'alchemy' }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() =>
      aio.blockchain({
        chain: 'solana',
        library: 'ethers' as '@solana/web3.js',
        provider: 'local',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'INCOMPATIBLE_SELECTION',
        message:
          "unknown library for chain 'solana'; the only accepted name is '@solana/web3.js'",
      }),
    );
    await aio.close();
  });

  it('resolves the well-known tokens by alias, only on their own cluster', async () => {
    const { aio, run } = container();
    const devnet = aio.blockchain({
      chain: 'solana',
      network: 'devnet',
      provider: 'local',
    });
    expect((await run(devnet.resolveAsset('USDC'))).id).toBe(
      'solana:devnet/spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    );
    await expect(run(devnet.resolveAsset('USDT'))).rejects.toMatchObject({
      code: 'ASSET_RESOLUTION',
    });
    const mainnet = aio.blockchain({ chain: 'solana', provider: 'local' });
    expect((await run(mainnet.resolveAsset('USDT'))).metadata).toEqual({
      symbol: 'USDT',
      decimals: 6,
    });
    await aio.close();
  });

  it('is data only: registering it loads no SDK', () => {
    const plugin = solanaPlugin();
    expect(
      plugin.adapters?.map((m) => [m.family, m.library, m.chains, m.peerDependencies]),
    ).toEqual([
      [
        'solana',
        '@solana/web3.js',
        ['solana'],
        [{ name: '@solana/web3.js', range: '^1.99.0' }],
      ],
    ]);
    expect(plugin.chains?.map((c) => c.id)).toEqual(['solana']);
  });

  it('pins the SDK range package.json declares as an optional peer and pins for tests', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as Record<'peerDependencies' | 'devDependencies', Record<string, string>> & {
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    const peers = Object.values(SOLANA_PEER_DEPENDENCIES);
    expect(peers.length).toBeGreaterThan(0);
    for (const { name, range } of peers) {
      expect([name, pkg.peerDependencies[name]]).toEqual([name, range]);
      expect([name, pkg.peerDependenciesMeta[name]?.optional]).toEqual([name, true]);
      expect([name, `^${pkg.devDependencies[name]}`]).toEqual([name, range]);
    }
  });

  // The key order of every family's entries is test/architecture/packaging.test.ts's rule.
  it('publishes crypto-aio/solana for both resolvers', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as {
      exports: Record<string, unknown>;
      typesVersions: { '*': Record<string, string[]> };
    };
    expect(pkg.exports['./solana']).toEqual({
      types: './dist/adapters/solana/index.d.ts',
      default: './dist/adapters/solana/index.js',
    });
    expect(pkg.typesVersions['*'].solana).toEqual(['dist/adapters/solana/index.d.ts']);
  });
});

describe('the built-in Solana plugin registered again', () => {
  it('builds every function once, so two calls are the same plugin', () => {
    const [a, b] = [solanaPlugin(), solanaPlugin()];
    expect(samePlugin(a, b)).toBe(true);
    // Functions match only themselves: the manifest's `load` and the presets' are shared.
    expect(a.adapters?.[0]?.load).toBe(b.adapters?.[0]?.load);
    expect(a.presets).toBe(SOLANA_PRESETS);
    expect(b.presets).toBe(SOLANA_PRESETS);
    expect(a.assets).toBe(SOLANA_TOKENS);
  });

  it('keeps use() idempotent for the same plugin, and refuses another under its name', async () => {
    // The composition root already registered solanaPlugin(); these are fresh copies of it.
    const { aio } = container({ plugins: [solanaPlugin()] });
    expect(() => aio.use(solanaPlugin())).not.toThrow();
    expect(thrown(() => aio.use({ name: 'solana' }))).toMatchObject({
      code: 'CONFIG_INVALID',
      message: "plugin 'solana' is already registered with a different definition",
    });
    await aio.close();
  });
});
