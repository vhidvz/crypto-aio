// Lazy loading: only the manifest's `load()` may require bitcoinjs-lib. Each check
// runs in a fresh module registry where requiring an SDK is recorded, then served as usual.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { utxoPlugin } from '../../../src/adapters/utxo/plugin';

type Entry = typeof import('../../../src');
type UtxoEntry = typeof import('../../../src/adapters/utxo');
type UtxoPlugin = typeof import('../../../src/adapters/utxo/plugin');

/** Every SDK the package declares, other families' too: `load()` requires only its own. */
const SDKS = Object.keys(
  (
    JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as {
      peerDependencies: Record<string, string>;
    }
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

describe('lazy loading of bitcoinjs-lib', () => {
  it('imports crypto-aio and crypto-aio/utxo without loading any SDK', () => {
    expect(SDKS).toContain('bitcoinjs-lib');
    const loaded = requiredSdks(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const entry = require('../../../src') as Entry;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const utxo = require('../../../src/adapters/utxo') as UtxoEntry;
      new entry.CryptoAio({
        env: false,
        providers: { local: { endpoints: [{ url: 'https://esplora.invalid/api' }] } },
      }).blockchain({ chain: 'bitcoin', provider: 'local', indexer: 'local' });
      expect(utxo.UTXO_PEER_DEPENDENCIES['bitcoinjs-lib'].name).toBe('bitcoinjs-lib');
    });
    expect(loaded).toEqual([]);
  });

  it('never imports driver.ts statically: only load() requires it', async () => {
    const loaded: string[] = [];
    let pending: Promise<unknown> | undefined;
    jest.isolateModules(() => {
      jest.doMock('../../../src/adapters/utxo/driver', () => {
        loaded.push('driver');
        return jest.requireActual('../../../src/adapters/utxo/driver');
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../src');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('../../../src/adapters/utxo/plugin') as UtxoPlugin;
      expect(loaded).toEqual([]);
      pending = fresh.utxoPlugin().adapters?.[0]?.load();
    });
    await pending;
    expect(loaded).toEqual(['driver']);
  });

  const manifests = (utxoPlugin().adapters ?? []).map((m) => ({
    library: m.library,
    names: m.peerDependencies.map((d) => d.name),
  }));

  it.each(manifests)(
    "the $library manifest's load() loads exactly its peer dependencies",
    async ({ library, names }) => {
      let pending: Promise<unknown> | undefined;
      const loaded = requiredSdks(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require('../../../src/adapters/utxo/plugin') as UtxoPlugin;
        pending = fresh
          .utxoPlugin()
          .adapters?.find((m) => m.library === library)
          ?.load();
      });
      expect(pending).toBeDefined();
      await pending;
      expect(loaded).toEqual(names);
    },
  );
});
