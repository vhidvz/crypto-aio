// Lazy loading (spec §4): only a manifest's `load()` may require an SDK. Each check runs in
// a fresh module registry where requiring any SDK the package declares is recorded, then
// served as usual.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { solanaPlugin } from '../../../src/adapters/solana/plugin';

type Entry = typeof import('../../../src');
type SolanaEntry = typeof import('../../../src/adapters/solana');
type SolanaPlugin = typeof import('../../../src/adapters/solana/plugin');

/**
 * Every SDK the package declares, other families' too (the Plan 3 merge convention), so a
 * Solana module that required another family's SDK would show: `load()` requires only its
 * own.
 */
const SDKS = Object.keys(
  (
    JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as { peerDependencies: Record<string, string> }
  ).peerDependencies,
);

/** The SDKs `run` requires, in order, in a module registry of its own. */
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

describe('lazy loading of the Solana SDK', () => {
  it('imports crypto-aio and crypto-aio/solana without loading any SDK', () => {
    expect(SDKS).toContain('@solana/web3.js');
    expect(SDKS.length).toBeGreaterThan(1);
    const loaded = requiredSdks(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const entry = require('../../../src') as Entry;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const solana = require('../../../src/adapters/solana') as SolanaEntry;
      // Both entries are usable: the family is registered and its constants are there.
      new entry.CryptoAio({
        env: false,
        providers: { local: { endpoints: [{ url: 'https://node.invalid/rpc' }] } },
      }).blockchain({ chain: 'solana', provider: 'local' });
      expect(solana.SOLANA_CAPABILITIES).toContain('expiry');
    });
    expect(loaded).toEqual([]);
  });

  // Each manifest loads in a registry of its own, so no SDK can hide behind an earlier load.
  const manifests = (solanaPlugin().adapters ?? []).map((m) => ({
    library: m.library,
    names: m.peerDependencies.map((d) => d.name),
  }));

  it('has a manifest to check', () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  it.each(manifests)(
    "the $library manifest's load() loads exactly its peer dependencies",
    async ({ library, names }) => {
      let pending: Promise<unknown> | undefined;
      const loaded = requiredSdks(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require('../../../src/adapters/solana/plugin') as SolanaPlugin;
        pending = fresh
          .solanaPlugin()
          .adapters?.find((m) => m.library === library)
          ?.load();
      });
      expect(pending).toBeDefined();
      await pending;
      expect(loaded).toEqual(names);
    },
  );
});
