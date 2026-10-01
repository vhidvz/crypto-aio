/**
 * The TON family plugin (spec §4): the chain, jettons and toncenter presets as data, plus
 * one adapter manifest (library `@ton/ton`). SDK-free: only the manifest's `load()` requires
 * the library module, and with it the driver, `@ton/ton`, `@ton/core` and `@ton/crypto`.
 */
import type {
  AdapterManifest,
  DriverFactory,
  PeerDependency,
} from '../../core/driver/types';
import type { Plugin } from '../../core/registry/plugin';
import { deepFreeze } from '../../core/util/freeze';
import { TON_CHAINS } from './chains';
import { TON_CAPABILITIES, TON_INDEXER_CAPABILITIES } from './network';
import { TON_PRESETS } from './presets';
import { TON_TOKENS } from './tokens';

/**
 * The SDK versions this adapter is validated against (spec §16, D2), keyed by package name
 * (Plan 2's final family shape). The one `@ton/ton` library needs all three.
 */
export const TON_PEER_DEPENDENCIES: Readonly<
  Record<'@ton/ton' | '@ton/core' | '@ton/crypto', PeerDependency>
> = deepFreeze({
  '@ton/ton': { name: '@ton/ton', range: '^16.3.0' },
  '@ton/core': { name: '@ton/core', range: '^0.63.1' },
  '@ton/crypto': { name: '@ton/crypto', range: '^3.3.0' },
});

/**
 * The `@ton/ton` manifest. A25: built once, at module level, like the presets, so every
 * `tonPlugin()` carries the same `load` function and registering it again is the same
 * plugin (A18). Its capabilities are exactly `TON_CAPABILITIES`: no `batch-transfer`, since a
 * TON transfer carries one output (F6-R15).
 */
export const tonManifest: AdapterManifest = Object.freeze({
  family: 'ton',
  library: '@ton/ton',
  chains: Object.freeze(['ton']),
  capabilities: TON_CAPABILITIES,
  indexerCapabilities: TON_INDEXER_CAPABILITIES,
  // D3: message → transaction resolution and trace-based finality need toncenter v3.
  requiresIndexer: true,
  peerDependencies: Object.freeze([
    TON_PEER_DEPENDENCIES['@ton/ton'],
    TON_PEER_DEPENDENCIES['@ton/core'],
    TON_PEER_DEPENDENCIES['@ton/crypto'],
  ]),
  load: async (): Promise<DriverFactory> => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./native-client') as typeof import('./native-client');
    return mod.tonLibraryDriverFactory;
  },
});

/** The built-in TON family: chain `ton`, networks mainnet and testnet (spec §2). */
export function tonPlugin(): Plugin {
  return {
    name: 'ton',
    chains: TON_CHAINS,
    adapters: [tonManifest],
    presets: TON_PRESETS,
    assets: TON_TOKENS,
  };
}
