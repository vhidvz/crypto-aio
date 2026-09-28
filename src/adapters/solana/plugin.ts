/**
 * The Solana family plugin (spec §4): the chain, tokens and provider presets as data, plus
 * one adapter manifest. SDK-free: only the manifest's `load()` requires the `@solana/web3.js`
 * module, and with it the SDK.
 */
import type {
  AdapterManifest,
  DriverFactory,
  PeerDependency,
} from '../../core/driver/types';
import type { Plugin } from '../../core/registry/plugin';
import { SOLANA_CHAIN } from './chains';
import { SOLANA_CAPABILITIES } from './network';
import { SOLANA_PRESETS } from './presets';
import { SOLANA_TOKENS } from './tokens';

/** The SDK versions this adapter is validated against (spec §16), keyed by library. */
export const SOLANA_PEER_DEPENDENCIES: Readonly<
  Record<'@solana/web3.js', PeerDependency>
> = Object.freeze({
  '@solana/web3.js': Object.freeze({ name: '@solana/web3.js', range: '^1.99.0' }),
});

/**
 * The `@solana/web3.js` manifest. A25: built once, at module level, like the presets, so
 * every `solanaPlugin()` carries the same `load` function and registering it again is the
 * same plugin.
 */
export const solanaManifest: AdapterManifest = Object.freeze({
  family: 'solana',
  library: '@solana/web3.js',
  chains: Object.freeze(['solana']),
  capabilities: SOLANA_CAPABILITIES,
  peerDependencies: Object.freeze([SOLANA_PEER_DEPENDENCIES['@solana/web3.js']]),
  load: async (): Promise<DriverFactory> => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./web3') as typeof import('./web3');
    return mod.web3DriverFactory;
  },
});

/** The built-in Solana family: mainnet, devnet and testnet (spec §2). */
export function solanaPlugin(): Plugin {
  return {
    name: 'solana',
    chains: [SOLANA_CHAIN],
    adapters: [solanaManifest],
    presets: SOLANA_PRESETS,
    assets: SOLANA_TOKENS,
  };
}
