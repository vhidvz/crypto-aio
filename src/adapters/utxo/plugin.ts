/**
 * The UTXO family plugin (SDK-free): the Bitcoin chain, the Esplora presets and the
 * bitcoinjs-lib manifest. Only `load()` pulls in the driver module and, with it, the SDK.
 */
import type {
  AdapterManifest,
  DriverFactory,
  PeerDependency,
} from '../../core/driver/types';
import type { Plugin } from '../../core/registry/plugin';
import { BITCOIN_CHAIN } from './chains';
import { UTXO_CAPABILITIES } from './network';
import { UTXO_PRESETS } from './presets';

/** Keyed by library name, as in every family; each manifest lists only its own. */
export const UTXO_PEER_DEPENDENCIES: Readonly<Record<'bitcoinjs-lib', PeerDependency>> =
  Object.freeze({
    'bitcoinjs-lib': Object.freeze({ name: 'bitcoinjs-lib', range: '^7.0.2' }),
  });

/**
 * The `bitcoinjs-lib` manifest. Built once, at module level, like the presets, so every
 * `utxoPlugin()` carries the same `load` function and registering it again is the same
 * plugin, a no-op: the registry compares functions by identity, and a different plugin
 * under a registered name is `CONFIG_INVALID`.
 */
export const utxoManifest: AdapterManifest = Object.freeze({
  family: 'utxo',
  library: 'bitcoinjs-lib',
  chains: Object.freeze(['bitcoin']),
  capabilities: UTXO_CAPABILITIES,
  // Esplora is the only data source; the core refuses a handle without one.
  requiresIndexer: true,
  peerDependencies: Object.freeze([UTXO_PEER_DEPENDENCIES['bitcoinjs-lib']]),
  load: async (): Promise<DriverFactory> => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./driver') as typeof import('./driver');
    return mod.utxoDriverFactory;
  },
});

/** The built-in UTXO family: chain `bitcoin` with mainnet, testnet, testnet4, signet and regtest. */
export function utxoPlugin(): Plugin {
  return {
    name: 'utxo',
    chains: [BITCOIN_CHAIN],
    adapters: [utxoManifest],
    presets: UTXO_PRESETS,
  };
}
