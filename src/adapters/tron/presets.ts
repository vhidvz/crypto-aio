/**
 * Tron provider presets (spec §11): TronGrid, the hosted service Tron's own documentation
 * lists for every network. `trongrid` sends the API key in the `TRON-PRO-API-KEY` header as
 * a `Secret`; `public` is the same hosts without a key (rate limited, not for production).
 * Each preset serves both kinds: `rpc` (the full node, solidity node and JSON-RPC paths) and
 * `indexer` (TronGrid's `/v1` account history), so `{ provider, indexer }` may name it twice.
 */
import { ConfigError } from '../../core/errors/error';
import type { PresetInput, ProviderPreset } from '../../core/registry/providers';
import { reveal, secret } from '../../core/secret/secret';
import type { EndpointConfig } from '../../core/transport/types';
import { deepFreeze } from './chains';

/** TronGrid hosts per network (Tron developer docs, "Networks"). */
export const TRONGRID_HOSTS: Readonly<Record<string, string>> = Object.freeze({
  mainnet: 'https://api.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
  nile: 'https://nile.trongrid.io',
});

const supports = (chain: string, network: string): boolean =>
  chain === 'tron' && Object.hasOwn(TRONGRID_HOSTS, network);

function host(input: PresetInput): string {
  const value = TRONGRID_HOSTS[input.network];
  // Unreachable through the catalog, which asks `supports` first.
  if (value === undefined) throw new Error(`no TronGrid host for ${input.network}`);
  return value;
}

/** The revealed key; the error names the preset and network, never the key. */
function apiKeyOf(input: PresetInput): string {
  const key: unknown = input.apiKey === undefined ? undefined : reveal(input.apiKey);
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ConfigError(
      'CONFIG_INVALID',
      `provider preset 'trongrid' requires a non-empty apiKey for ${input.chain}:${input.network}`,
    );
  }
  return key;
}

function presets(kind: 'rpc' | 'indexer'): ProviderPreset[] {
  return [
    {
      name: 'public',
      kind,
      production: false,
      supports,
      endpoints: (input): readonly EndpointConfig[] => [
        { name: 'trongrid-public', url: host(input), kind },
      ],
    },
    {
      name: 'trongrid',
      kind,
      requiresApiKey: true,
      supports,
      endpoints: (input): readonly EndpointConfig[] => [
        {
          name: 'trongrid',
          url: host(input),
          kind,
          headers: { 'TRON-PRO-API-KEY': secret(apiKeyOf(input)) },
        },
      ],
    },
  ];
}

/** Frozen with each preset (R56); built once, so `use(tronPlugin())` stays idempotent (X6). */
export const TRON_PRESETS: readonly ProviderPreset[] = deepFreeze([
  ...presets('rpc'),
  ...presets('indexer'),
]);
