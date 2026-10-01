// Lazy loading: only the manifest's `load()` may require @avalabs/avalanchejs. Each
// check runs in a fresh module registry where requiring an SDK is recorded, then served.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Entry = typeof import('../../../src');
type AvalancheEntry = typeof import('../../../src/adapters/avalanche');
type AvalanchePlugin = typeof import('../../../src/adapters/avalanche/plugin');

/** Every SDK the package declares, other families' too: `load()` requires only its own. */
const SDKS = Object.keys(
  (
    JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as { peerDependencies: Record<string, string> }
  ).peerDependencies,
);

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

describe('lazy loading of @avalabs/avalanchejs', () => {
  it('imports crypto-aio and crypto-aio/avalanche without loading any SDK', () => {
    expect(SDKS).toContain('@avalabs/avalanchejs');
    const loaded = requiredSdks(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const entry = require('../../../src') as Entry;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const avalanche = require('../../../src/adapters/avalanche') as AvalancheEntry;
      new entry.CryptoAio({ env: false }).blockchain({ chain: 'avalanche-x' });
      expect(avalanche.AVALANCHE_PEER_DEPENDENCIES['@avalabs/avalanchejs'].name).toBe(
        '@avalabs/avalanchejs',
      );
    });
    expect(loaded).toEqual([]);
  });

  it('never imports driver.ts statically: only load() requires it', async () => {
    const loaded: string[] = [];
    let pending: Promise<unknown> | undefined;
    jest.isolateModules(() => {
      jest.doMock('../../../src/adapters/avalanche/driver', () => {
        loaded.push('driver');
        return jest.requireActual('../../../src/adapters/avalanche/driver');
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../src');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('../../../src/adapters/avalanche/plugin') as AvalanchePlugin;
      expect(loaded).toEqual([]);
      pending = fresh.avalanchePlugin().adapters?.[0]?.load();
    });
    await pending;
    expect(loaded).toEqual(['driver']);
  });

  it("the manifest's load() loads exactly its peer dependency", async () => {
    let pending: Promise<unknown> | undefined;
    const loaded = requiredSdks(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('../../../src/adapters/avalanche/plugin') as AvalanchePlugin;
      pending = fresh.avalanchePlugin().adapters?.[0]?.load();
    });
    await pending;
    expect(loaded).toEqual(['@avalabs/avalanchejs']);
  });
});
