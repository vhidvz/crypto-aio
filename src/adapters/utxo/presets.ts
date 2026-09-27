/**
 * Esplora provider presets (spec §11). Each is registered twice, as an `rpc` provider
 * (blocks, transactions, broadcasts, proofs, fee estimates) and as an `indexer` (address
 * UTXOs, balances, history), because the core requires an `rpc` provider and the UTXO
 * manifest `requiresIndexer`. Only base URLs verified against the operators' own sources
 * are listed (Plan 3 appendix); a preset refuses every other network with `CONFIG_INVALID`.
 * Both services are free and rate limited, so they are marked `production: false`: for
 * production, run your own Esplora and configure it as `{ endpoints: [...] }`.
 */
import type { PresetInput, ProviderPreset } from '../../core/registry/providers';
import type { EndpointConfig } from '../../core/transport/types';

type Table = Readonly<Record<string, string>>;

/** blockstream.info: mainnet, testnet (v3) and signet. */
const BLOCKSTREAM: Table = Object.freeze({
  mainnet: 'https://blockstream.info/api',
  testnet: 'https://blockstream.info/testnet/api',
  signet: 'https://blockstream.info/signet/api',
});

/** mempool.space: mainnet, testnet (v3), testnet4 and signet. */
const MEMPOOL: Table = Object.freeze({
  mainnet: 'https://mempool.space/api',
  testnet: 'https://mempool.space/testnet/api',
  testnet4: 'https://mempool.space/testnet4/api',
  signet: 'https://mempool.space/signet/api',
});

/** Own keys only: `table['toString']` would find `Object.prototype`'s. */
function has(table: Table, network: string): boolean {
  return Object.hasOwn(table, network);
}

function url(table: Table, network: string): string {
  // Unreachable through the catalog, which asks `supports` first.
  if (!has(table, network)) throw new Error(`no entry for bitcoin:${network}`);
  return table[network] as string;
}

function presets(
  name: string,
  endpoints: (network: string) => readonly EndpointConfig[],
  supports: (network: string) => boolean,
): ProviderPreset[] {
  return (['rpc', 'indexer'] as const).map((kind) =>
    Object.freeze<ProviderPreset>({
      name,
      kind,
      production: false,
      supports: (chain: string, network: string) =>
        chain === 'bitcoin' && supports(network),
      endpoints: (input: PresetInput) => endpoints(input.network),
    }),
  );
}

export const UTXO_PRESETS: readonly ProviderPreset[] = Object.freeze([
  ...presets(
    'blockstream',
    (network) => [{ name: 'blockstream', url: url(BLOCKSTREAM, network) }],
    (network) => has(BLOCKSTREAM, network),
  ),
  ...presets(
    'mempool',
    (network) => [{ name: 'mempool', url: url(MEMPOOL, network) }],
    (network) => has(MEMPOOL, network),
  ),
  // The fallback when a handle names no provider: both services, mempool.space first.
  ...presets(
    'public',
    (network) => [
      { name: 'mempool', url: url(MEMPOOL, network), priority: 0 },
      ...(has(BLOCKSTREAM, network)
        ? [{ name: 'blockstream', url: url(BLOCKSTREAM, network), priority: 1 }]
        : []),
    ],
    (network) => has(MEMPOOL, network),
  ),
]);
