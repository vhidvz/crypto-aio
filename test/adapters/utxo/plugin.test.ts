import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { HDKey } from '@scure/bip32';
import { CryptoAio, noopLogger } from '../../../src';
import { walletAddress } from '../../../src/adapters/utxo/address';
import { BITCOIN_CHAIN } from '../../../src/adapters/utxo/chains';
import {
  UTXO_PEER_DEPENDENCIES,
  utxoManifest,
  utxoPlugin,
} from '../../../src/adapters/utxo/plugin';
import { UTXO_PRESETS } from '../../../src/adapters/utxo/presets';
import { samePlugin } from '../../../src/core/registry/plugin';
import { FakeClock, drive } from '../../../src/testing/fake-clock';
import { thrown } from '../../helpers';
import { ScriptedEsploraNode } from './support/node';
import { REGTEST } from './support/vectors';

function container(extra: Partial<ConstructorParameters<typeof CryptoAio>[0]> = {}) {
  const clock = new FakeClock();
  const node = new ScriptedEsploraNode({ clock });
  const aio = new CryptoAio({
    env: false,
    logger: noopLogger,
    clock,
    transport: { fetch: node.fetch.fetch, baseDelayMs: 1, maxDelayMs: 2 },
    providers: { local: { endpoints: [{ url: node.endpoint('a') }] } },
    ...extra,
  });
  return { aio, node, run: <T>(p: Promise<T>) => drive(clock, p) };
}

describe('the built-in UTXO plugin', () => {
  it('registers bitcoin with bitcoinjs-lib, the family capabilities and the indexer requirement', async () => {
    const { aio, node, run } = container();
    const bc = aio.blockchain({
      chain: 'bitcoin',
      network: 'regtest',
      provider: 'local',
      indexer: 'local',
    });
    expect([bc.chain, bc.network, bc.library]).toEqual([
      'bitcoin',
      'regtest',
      'bitcoinjs-lib',
    ]);
    expect([...bc.capabilities].sort()).toEqual([
      'address-history',
      'batch-transfer',
      'block-scan',
      'cancel',
      'hd-public-derivation',
      'replace-fee',
    ]);
    node.fund('bcrt1qelwllzs5wpgtrstfn2hda98vwtqqq2anllgcxd', 12n);
    await run(bc.ready());
    expect(
      (await run(bc.getBalance('bcrt1qelwllzs5wpgtrstfn2hda98vwtqqq2anllgcxd'))).amount
        .base,
    ).toBe(12n);
    expect(() =>
      aio.blockchain({
        chain: 'bitcoin',
        library: 'ethers' as 'bitcoinjs-lib',
        provider: 'local',
      }),
    ).toThrow(expect.objectContaining({ code: 'INCOMPATIBLE_SELECTION' }));
    await aio.close();
  });

  it('derives deposit addresses from a wallet xpub (hd-public-derivation)', async () => {
    const tpub = { private: 0x04358394, public: 0x043587cf };
    const root = HDKey.fromMasterSeed(sha256(utf8ToBytes('crypto-aio/utxo xpub')), tpub);
    const account = root.derive("m/84'/1'/0'");
    const { aio, run } = container();
    const scoped = aio.scope({
      wallets: {
        deposits: { xpub: account.publicExtendedKey, utxo: { addressType: 'p2tr' } },
      },
    });
    const bc = scoped.blockchain({
      chain: 'bitcoin',
      network: 'regtest',
      provider: 'local',
      indexer: 'local',
    });
    const child = account.derive('m/0/7').publicKey as Uint8Array;
    expect((await run(bc.deriveAddress('deposits', 7))).canonical).toBe(
      walletAddress(child, 'p2tr', REGTEST).address,
    );
    await aio.close();
  });

  it('falls back to the public Esplora presets when no provider is named', () => {
    const aio = new CryptoAio({ env: false, logger: noopLogger });
    const bc = aio.blockchain({ chain: 'bitcoin', network: 'testnet4' });
    expect(bc.config).toMatchObject({
      providers: [
        {
          name: 'public',
          production: false,
          endpoints: [{ kind: 'rpc', url: 'https://mempool.space/testnet4/api' }],
        },
      ],
      indexers: [
        {
          name: 'public',
          production: false,
          endpoints: [{ kind: 'indexer', url: 'https://mempool.space/testnet4/api' }],
        },
      ],
    });
    expect(() => aio.blockchain({ chain: 'bitcoin', network: 'regtest' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  it('refuses a handle with a provider but no indexer where no public preset serves one (F3-R16 M1)', async () => {
    // regtest has no public preset: the manifest's `requiresIndexer` refuses the handle
    // before any driver is made, instead of the "no provider" refusal above.
    const { aio } = container();
    expect(() =>
      aio.blockchain({ chain: 'bitcoin', network: 'regtest', provider: 'local' }),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message:
          "library 'bitcoinjs-lib' requires an indexer provider for bitcoin:regtest",
      }),
    );
    await aio.close();
  });

  it('is SDK-free data plus a lazy manifest', () => {
    const plugin = utxoPlugin();
    expect(
      plugin.adapters?.map((m) => [m.family, m.library, m.peerDependencies]),
    ).toEqual([['utxo', 'bitcoinjs-lib', [{ name: 'bitcoinjs-lib', range: '^7.0.2' }]]]);
    expect(plugin.adapters?.[0]).toMatchObject({
      chains: ['bitcoin'],
      requiresIndexer: true,
    });
  });

  it('pins the SDK range package.json declares as an optional peer and pins for tests', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as Record<'peerDependencies' | 'devDependencies', Record<string, string>> & {
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    const peers = Object.values(UTXO_PEER_DEPENDENCIES);
    expect(peers.map((d) => d.name)).toEqual(['bitcoinjs-lib']);
    for (const { name, range } of peers) {
      expect([name, pkg.peerDependencies[name]]).toEqual([name, range]);
      expect([name, pkg.peerDependenciesMeta[name]?.optional]).toEqual([name, true]);
      expect([name, `^${pkg.devDependencies[name]}`]).toEqual([name, range]);
    }
  });

  it('ships frozen data: the manifest, its peer list and the peer entries (R56)', () => {
    const { adapters, chains } = utxoPlugin();
    expect(adapters).toEqual([utxoManifest]);
    expect(chains).toEqual([BITCOIN_CHAIN]);
    expect(Object.isFrozen(utxoManifest)).toBe(true);
    expect(Object.isFrozen(utxoManifest.chains)).toBe(true);
    expect(Object.isFrozen(utxoManifest.peerDependencies)).toBe(true);
    expect(Object.isFrozen(UTXO_PEER_DEPENDENCIES)).toBe(true);
    expect(Object.isFrozen(UTXO_PEER_DEPENDENCIES['bitcoinjs-lib'])).toBe(true);
  });

  it('ships the frozen Esplora presets, none with a guessed rate limit (A28)', () => {
    const { presets } = utxoPlugin();
    expect(presets).toBe(UTXO_PRESETS);
    expect(presets?.every((preset) => Object.isFrozen(preset))).toBe(true);
    // Neither mempool.space nor blockstream.info publishes a keyless rate.
    const networks = Object.keys(BITCOIN_CHAIN.networks);
    let served = 0;
    for (const preset of presets ?? []) {
      for (const network of networks.filter((n) => preset.supports('bitcoin', n))) {
        for (const endpoint of preset.endpoints({ chain: 'bitcoin', network })) {
          expect([preset.name, network, endpoint.rateLimit]).toEqual([
            preset.name,
            network,
            undefined,
          ]);
          served += 1;
        }
      }
    }
    expect(served).toBeGreaterThan(0);
  });

  // The key order of every family's entries is test/architecture/packaging.test.ts's rule.
  it('publishes crypto-aio/utxo: CJS and types, typesVersions and the API docs', () => {
    const read = (file: string): unknown =>
      JSON.parse(readFileSync(join(__dirname, '..', '..', '..', file), 'utf8'));
    const pkg = read('package.json') as {
      exports: Record<string, unknown>;
      typesVersions: Record<string, Record<string, string[]>>;
    };
    expect(pkg.exports['./utxo']).toEqual({
      types: './dist/adapters/utxo/index.d.ts',
      default: './dist/adapters/utxo/index.js',
    });
    expect(pkg.typesVersions['*']?.utxo).toEqual(['dist/adapters/utxo/index.d.ts']);
    const { entryPoints } = read('typedoc.json') as { entryPoints: string[] };
    expect(entryPoints).toContain('src/adapters/utxo/index.ts');
  });
});

describe('the built-in UTXO plugin registered again (A18)', () => {
  it('keeps use() idempotent for the same plugin, and refuses another named utxo', async () => {
    // The composition root already registered utxoPlugin(); these are fresh copies of it.
    expect(samePlugin(utxoPlugin(), utxoPlugin())).toBe(true);
    const { aio } = container({ plugins: [utxoPlugin()] });
    expect(() => aio.use(utxoPlugin())).not.toThrow();
    // Functions match by identity: the same manifest around a new `load` is another plugin.
    const rebuilt = {
      ...utxoPlugin(),
      adapters: [{ ...utxoManifest, load: () => utxoManifest.load() }],
    };
    for (const other of [{ name: 'utxo' }, rebuilt]) {
      expect(thrown(() => aio.use(other))).toMatchObject({
        code: 'CONFIG_INVALID',
        message: "plugin 'utxo' is already registered with a different definition",
      });
    }
    await aio.close();
  });
});
