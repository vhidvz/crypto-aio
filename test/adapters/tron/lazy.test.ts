// Lazy loading (spec §4, R81): only a manifest's `load()` may require an SDK. Each check runs
// in a module registry of its own, where requiring tronweb is recorded, then served as usual.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterManifest } from '../../../src';

type Entry = typeof import('../../../src');
type TronEntry = typeof import('../../../src/adapters/tron');
type TronPlugin = typeof import('../../../src/adapters/tron/plugin');

const SDKS = ['tronweb'] as const;

/** The SDKs `run` requires, in order, in a module registry of its own; `run` sees them live. */
function requiredSdks(run: (loaded: readonly string[]) => void): string[] {
  const loaded: string[] = [];
  jest.isolateModules(() => {
    for (const sdk of SDKS) {
      jest.doMock(sdk, () => {
        loaded.push(sdk);
        return jest.requireActual(sdk);
      });
    }
    run(loaded);
  });
  return loaded;
}

describe('lazy loading of tronweb', () => {
  it('imports crypto-aio and crypto-aio/tron without loading tronweb', () => {
    const loaded = requiredSdks(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const entry = require('../../../src') as Entry;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tron = require('../../../src/adapters/tron') as TronEntry;
      new entry.CryptoAio({
        env: false,
        providers: { local: { endpoints: [{ url: 'https://node.invalid' }] } },
      }).blockchain({ chain: 'tron', provider: 'local' });
      expect(tron.TRON_PEER_DEPENDENCIES.tronweb.name).toBe('tronweb');
    });
    expect(loaded).toEqual([]);
  });

  it("loads exactly its own manifest's peer dependencies, each manifest in its own registry", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tronPlugin } = require('../../../src/adapters/tron/plugin') as TronPlugin;
    const manifests: readonly AdapterManifest[] = tronPlugin().adapters ?? [];
    expect(manifests).toHaveLength(1);
    for (const manifest of manifests) {
      let pending: Promise<unknown> = Promise.resolve();
      const loaded = requiredSdks(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const own = require('../../../src/adapters/tron/plugin') as TronPlugin;
        const fresh = own
          .tronPlugin()
          .adapters?.find((m) => m.library === manifest.library);
        pending = fresh?.load() ?? Promise.reject(new Error('no manifest'));
      });
      await pending;
      expect(loaded).toEqual(manifest.peerDependencies.map((d) => d.name));
    }
  });

  it('declares the same peer range as package.json, an optional peer pinned for tests', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../../package.json'), 'utf8'),
    ) as Record<'peerDependencies' | 'devDependencies', Record<string, string>> & {
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TRON_PEER_DEPENDENCIES } = require('../../../src/adapters/tron') as TronEntry;
    for (const dependency of Object.values(TRON_PEER_DEPENDENCIES)) {
      expect(pkg.peerDependencies[dependency.name]).toBe(dependency.range);
      expect(pkg.peerDependenciesMeta[dependency.name]?.optional).toBe(true);
      expect(`^${pkg.devDependencies[dependency.name]}`).toBe(dependency.range);
    }
  });

  it('publishes crypto-aio/tron: CJS and types, typesVersions and the API docs', () => {
    const read = (file: string): unknown =>
      JSON.parse(readFileSync(join(__dirname, '../../../', file), 'utf8'));
    const pkg = read('package.json') as {
      exports: Record<string, unknown>;
      typesVersions: Record<string, Record<string, string[]>>;
    };
    expect(pkg.exports['./tron']).toEqual({
      types: './dist/adapters/tron/index.d.ts',
      default: './dist/adapters/tron/index.js',
    });
    expect(pkg.typesVersions['*']?.tron).toEqual(['dist/adapters/tron/index.d.ts']);
    const { entryPoints } = read('typedoc.json') as { entryPoints: string[] };
    expect(entryPoints).toContain('src/adapters/tron/index.ts');
  });
});
