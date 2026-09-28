/**
 * The Tron family plugin (spec §4): the chain, the USDT catalog and the TronGrid presets as
 * data, plus the `tronweb` manifest. SDK-free: only the manifest's `load()` requires the
 * codec module, and with it tronweb and the driver.
 */
import type {
  AdapterManifest,
  DriverFactory,
  PeerDependency,
} from '../../core/driver/types';
import type { Plugin } from '../../core/registry/plugin';
import { TRON_CHAIN } from './chains';
import { TRON_CAPABILITIES, TRON_INDEXER_CAPABILITIES } from './network';
import { TRON_PRESETS } from './presets';
import { TRON_TOKENS } from './tokens';

/** The SDK version this adapter is validated against (spec §16), keyed by library. */
export const TRON_PEER_DEPENDENCIES: Readonly<Record<'tronweb', PeerDependency>> =
  Object.freeze({ tronweb: Object.freeze({ name: 'tronweb', range: '^6.5.1' }) });

/**
 * The `tronweb` manifest. A25/X6: built once, at module level, like the presets, so every
 * `tronPlugin()` carries the same `load` function and registering it again is the same
 * plugin.
 */
export const tronManifest: AdapterManifest = Object.freeze({
  family: 'tron',
  library: 'tronweb',
  chains: Object.freeze(['tron']),
  capabilities: TRON_CAPABILITIES,
  indexerCapabilities: TRON_INDEXER_CAPABILITIES,
  peerDependencies: Object.freeze([TRON_PEER_DEPENDENCIES.tronweb]),
  load: async (): Promise<DriverFactory> => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./codec') as typeof import('./codec');
    return mod.tronwebDriverFactory;
  },
});

/** The built-in Tron family: chain `tron` with mainnet, Shasta and Nile. */
export function tronPlugin(): Plugin {
  return {
    name: 'tron',
    chains: [TRON_CHAIN],
    adapters: [tronManifest],
    presets: TRON_PRESETS,
    assets: TRON_TOKENS,
  };
}
