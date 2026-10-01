// Lazy loading: only the manifest's `load()` may require an SDK. Each check runs
// in a module registry of its own, where requiring any SDK the package declares (every
// family's, not only TON's) is recorded, then served as usual.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tonPlugin } from '../../../src/adapters/ton/plugin';

type Entry = typeof import('../../../src');
type TonEntry = typeof import('../../../src/adapters/ton');
type TonPlugin = typeof import('../../../src/adapters/ton/plugin');

/** Every SDK the package declares, other families' too: `load()` requires only its own. */
const SDKS = Object.keys(
  (
    JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as { peerDependencies: Record<string, string> }
  ).peerDependencies,
);

/** The SDKs `run` requires, as recorded, in a module registry of its own. */
function requiredSdks(run: () => void): string[] {
  const loaded: string[] = [];
  jest.isolateModules(() => {
    for (const sdk of SDKS) {
      jest.doMock(sdk, () => {
        loaded.push(sdk);
        return jest.requireActual(sdk);
      });
    }
    run();
  });
  return loaded;
}

describe('lazy loading of the TON SDKs', () => {
  it('imports crypto-aio and crypto-aio/ton without loading any SDK', () => {
    expect(SDKS).toEqual(
      expect.arrayContaining(['@ton/ton', '@ton/core', '@ton/crypto']),
    );
    const loaded = requiredSdks(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const entry = require('../../../src') as Entry;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ton = require('../../../src/adapters/ton') as TonEntry;
      new entry.CryptoAio({
        env: false,
        providers: {
          v2: { endpoints: [{ url: 'https://node.invalid/api/v2' }] },
          v3: { endpoints: [{ url: 'https://node.invalid/api/v3', kind: 'indexer' }] },
        },
      }).blockchain({ chain: 'ton', provider: 'v2', indexer: 'v3' });
      expect(Object.keys(ton.TON_PEER_DEPENDENCIES)).toHaveLength(3);
    });
    expect(loaded).toEqual([]);
  });

  it('never requires native-client.ts or driver.ts before load()', async () => {
    const modules = ['native-client', 'driver'] as const;
    const loaded: string[] = [];
    let pending: Promise<unknown> | undefined;
    jest.isolateModules(() => {
      for (const name of modules) {
        const path = `../../../src/adapters/ton/${name}`;
        jest.doMock(path, () => {
          loaded.push(name);
          return jest.requireActual(path);
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../src');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../src/adapters/ton');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('../../../src/adapters/ton/plugin') as TonPlugin;
      expect(loaded).toEqual([]);
      pending = fresh.tonPlugin().adapters?.[0]?.load();
    });
    await pending;
    expect(loaded).toEqual(['native-client', 'driver']);
  });

  // Each manifest loads in a registry of its own, so no SDK can hide behind an earlier load.
  const manifests = (tonPlugin().adapters ?? []).map((m) => ({
    library: m.library,
    names: m.peerDependencies.map((d) => d.name),
  }));

  it.each(manifests)(
    "the $library manifest's load() loads exactly its peer dependencies",
    async ({ library, names }) => {
      let pending: Promise<unknown> | undefined;
      const loaded = requiredSdks(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require('../../../src/adapters/ton/plugin') as TonPlugin;
        pending = fresh
          .tonPlugin()
          .adapters?.find((m) => m.library === library)
          ?.load();
      });
      expect(pending).toBeDefined();
      await pending;
      // The SDKs require one another (and `@ton/crypto` re-enters itself through
      // `require('..')`), so the order and repeats are theirs: compare the sets.
      expect([...new Set(loaded)].sort()).toEqual([...names].sort());
    },
  );
});
