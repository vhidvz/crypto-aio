/**
 * The Avalanche family plugin (SDK-free): the X-Chain and P-Chain, the public and Data API
 * presets and the avalanchejs manifest. Only `load()` pulls in the driver module and, with
 * it, the SDK.
 */
import type {
  AdapterManifest,
  DriverFactory,
  PeerDependency,
} from '../../core/driver/types';
import type { Plugin } from '../../core/registry/plugin';
import { deepFreeze } from '../../core/util/freeze';
import { AVALANCHE_CHAINS } from './chains';
import { AVALANCHE_CAPABILITIES } from './network';
import { AVALANCHE_PRESETS } from './presets';

/**
 * The SDK version this adapter is validated against, keyed by package name: the range
 * starts at the version the tests pin.
 */
export const AVALANCHE_PEER_DEPENDENCIES: Readonly<
  Record<'@avalabs/avalanchejs', PeerDependency>
> = deepFreeze({
  '@avalabs/avalanchejs': { name: '@avalabs/avalanchejs', range: '^5.2.0' },
});

/**
 * The `@avalabs/avalanchejs` manifest, built once, at module level, so every
 * `avalanchePlugin()` carries the same `load` function. Registration compares a plugin's
 * functions by identity: the same plugin again is a no-op, while one with another `load`
 * under this name is `CONFIG_INVALID`.
 */
export const avalancheManifest: AdapterManifest = Object.freeze({
  family: 'avalanche',
  library: '@avalabs/avalanchejs',
  chains: Object.freeze(['avalanche-x', 'avalanche-p']),
  capabilities: AVALANCHE_CAPABILITIES,
  // The node cannot say which block holds a transaction: the Data API locates it (the node
  // then proves it) and serves address history.
  requiresIndexer: true,
  peerDependencies: Object.freeze([AVALANCHE_PEER_DEPENDENCIES['@avalabs/avalanchejs']]),
  load: async (): Promise<DriverFactory> => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./driver') as typeof import('./driver');
    return mod.avalancheDriverFactory;
  },
});

/** The built-in Avalanche family: chains `avalanche-x` and `avalanche-p`, mainnet and Fuji. */
export function avalanchePlugin(): Plugin {
  return {
    name: 'avalanche',
    chains: AVALANCHE_CHAINS,
    adapters: [avalancheManifest],
    presets: AVALANCHE_PRESETS,
  };
}
