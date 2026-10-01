// Lazy loading: only a manifest's `load()` may require an SDK. Each check runs in
// a fresh module registry where requiring `ethers` or `web3` is recorded, then served as usual.
import { evmPlugin } from '../../../src/adapters/evm/plugin';

type Entry = typeof import('../../../src');
type EvmEntry = typeof import('../../../src/adapters/evm');
type EvmPlugin = typeof import('../../../src/adapters/evm/plugin');

const SDKS = ['ethers', 'web3'] as const;

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

describe('lazy loading of the EVM SDKs', () => {
  it('imports crypto-aio and crypto-aio/evm without loading ethers or web3', () => {
    const loaded = requiredSdks(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const entry = require('../../../src') as Entry;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const evm = require('../../../src/adapters/evm') as EvmEntry;
      // Both entries are usable: the family is registered and the plugin API is there.
      new entry.CryptoAio({
        env: false,
        providers: { local: { endpoints: [{ url: 'https://node.invalid/rpc' }] } },
      }).blockchain({ chain: 'ethereum', provider: 'local' });
      expect(typeof evm.evmChainPlugin).toBe('function');
    });
    expect(loaded).toEqual([]);
  });

  // Each manifest loads in a registry of its own, so no SDK can hide behind an earlier load.
  const manifests = (evmPlugin().adapters ?? []).map((m) => ({
    library: m.library,
    names: m.peerDependencies.map((d) => d.name),
  }));

  it.each(manifests)(
    "the $library manifest's load() loads exactly its peer dependencies",
    async ({ library, names }) => {
      let pending: Promise<unknown> | undefined;
      const loaded = requiredSdks(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require('../../../src/adapters/evm/plugin') as EvmPlugin;
        pending = fresh
          .evmPlugin()
          .adapters?.find((m) => m.library === library)
          ?.load();
      });
      expect(pending).toBeDefined();
      await pending;
      expect(loaded).toEqual(names);
    },
  );
});
