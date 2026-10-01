/**
 * Avalanche provider presets (spec §11), verified on 2026-10-01:
 * - `public` (`rpc`): Ava Labs' public API, `https://api.avax.network/ext/bc/{X,P}` on
 *   mainnet and `https://api.avax-test.network/ext/bc/{X,P}` on Fuji. Each chain's JSON-RPC
 *   endpoint is its own URL.
 * - `public` (`indexer`): the Avalanche Data API (formerly Glacier) without a key,
 *   `https://data-api.avax.network/v1/networks/{mainnet,fuji}/blockchains/{x-chain,p-chain}`.
 * - `glacier` (`indexer`): the same Data API with an API key, sent in its
 *   `x-glacier-api-key` header (the service's OpenAPI document) as a `Secret`, so it never
 *   reaches logs, errors or events.
 * The public services are rate limited and marked `production: false`; their limits are not
 * published, so none is set here. For production, run your own AvalancheGo node and
 * configure it as `{ endpoints: [{ url: 'https://node.example/ext/bc/X' }] }`.
 */
import { ConfigError } from '../../core/errors/error';
import type { PresetInput, ProviderPreset } from '../../core/registry/providers';
import { reveal, secret } from '../../core/secret/secret';
import type { EndpointConfig } from '../../core/transport/types';
import { deepFreeze } from './chains';

const NODES: Readonly<Record<string, string>> = Object.freeze({
  mainnet: 'https://api.avax.network',
  fuji: 'https://api.avax-test.network',
});

const DATA_API = 'https://data-api.avax.network/v1/networks';

const CHAINS: Readonly<
  Record<string, { readonly alias: string; readonly name: string }>
> = Object.freeze({
  'avalanche-x': { alias: 'X', name: 'x-chain' },
  'avalanche-p': { alias: 'P', name: 'p-chain' },
});

/** Own keys only: `constructor`, `toString` or `__proto__` is not a chain or network. */
const supports = (chain: string, network: string): boolean =>
  Object.hasOwn(CHAINS, chain) && Object.hasOwn(NODES, network);

/** Unreachable through the catalog, which asks `supports` first. */
function chainOf(input: PresetInput) {
  if (!supports(input.chain, input.network)) {
    throw new Error(`no Avalanche endpoint for ${input.chain}:${input.network}`);
  }
  return CHAINS[input.chain] as { readonly alias: string; readonly name: string };
}

const nodeUrl = (input: PresetInput): string =>
  `${NODES[input.network] as string}/ext/bc/${chainOf(input).alias}`;

const dataApiUrl = (input: PresetInput): string =>
  `${DATA_API}/${input.network}/blockchains/${chainOf(input).name}`;

/** The revealed key; the error names the preset and network, never the key. */
function apiKeyOf(input: PresetInput): string {
  const key: unknown = input.apiKey === undefined ? undefined : reveal(input.apiKey);
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ConfigError(
      'CONFIG_INVALID',
      `provider preset 'glacier' requires a non-empty apiKey for ${input.chain}:${input.network}`,
    );
  }
  return key;
}

/** Built once at module level, so the plugin's functions keep their identity (A25). */
export const AVALANCHE_PRESETS: readonly ProviderPreset[] = deepFreeze([
  {
    name: 'public',
    kind: 'rpc',
    production: false,
    supports,
    endpoints: (input: PresetInput): readonly EndpointConfig[] => [
      { name: 'avax', url: nodeUrl(input) },
    ],
  },
  {
    name: 'public',
    kind: 'indexer',
    production: false,
    supports,
    endpoints: (input: PresetInput): readonly EndpointConfig[] => [
      { name: 'data-api', url: dataApiUrl(input) },
    ],
  },
  {
    name: 'glacier',
    kind: 'indexer',
    requiresApiKey: true,
    supports,
    endpoints: (input: PresetInput): readonly EndpointConfig[] => [
      {
        name: 'data-api',
        url: dataApiUrl(input),
        headers: { 'x-glacier-api-key': secret(apiKeyOf(input)) },
      },
    ],
  },
] satisfies ProviderPreset[]);
