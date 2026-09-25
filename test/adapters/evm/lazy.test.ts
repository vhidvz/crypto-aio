// Lazy loading (spec §4): only a manifest's `load()` may require an SDK. Each check runs in
// a fresh module registry where requiring `ethers` or `web3` is recorded, then served as usual.
import type { AdapterManifest } from '../../../src';

type Entry = typeof import('../../../src');
type EvmEntry = typeof import('../../../src/adapters/evm');
type EvmPlugin = typeof import('../../../src/adapters/evm/plugin');

const SDKS = ['ethers', 'web3'] as const;

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

  it("loads each SDK only from its own manifest's load()", async () => {
    const pending: Promise<unknown>[] = [];
    const loaded = requiredSdks((sofar) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { evmPlugin } = require('../../../src/adapters/evm/plugin') as EvmPlugin;
      const manifests: readonly AdapterManifest[] = evmPlugin().adapters ?? [];
      for (const manifest of manifests) {
        const before = sofar.length;
        pending.push(manifest.load());
        expect(sofar.slice(before)).toEqual([manifest.library]);
      }
    });
    await Promise.all(pending);
    expect(loaded).toEqual(['ethers', 'web3']);
  });
});
