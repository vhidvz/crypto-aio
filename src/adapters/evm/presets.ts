/**
 * EVM provider presets (spec §11). Only URL templates verified against the provider's own
 * documentation are listed (Plan 2 appendix); a preset refuses every other network with
 * `CONFIG_INVALID`. Keyed URLs are `Secret`s, so the key never reaches logs or errors.
 */
import { ConfigError } from '../../core/errors/error';
import type { PresetInput, ProviderPreset } from '../../core/registry/providers';
import { reveal, secret } from '../../core/secret/secret';
import type { EndpointConfig } from '../../core/transport/types';

type Table = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Free public endpoints named in each chain's own documentation: the chain operator's, or a
 * third party's where the docs list one (Polygon's are drpc's).
 */
const PUBLIC: Table = {
  bsc: {
    mainnet: 'https://bsc-dataseed.bnbchain.org',
    testnet: 'https://bsc-testnet-dataseed.bnbchain.org',
  },
  polygon: {
    mainnet: 'https://polygon.drpc.org',
    amoy: 'https://polygon-amoy.drpc.org',
  },
  avalanche: {
    mainnet: 'https://api.avax.network/ext/bc/C/rpc',
    fuji: 'https://api.avax-test.network/ext/bc/C/rpc',
  },
  arbitrum: {
    mainnet: 'https://arb1.arbitrum.io/rpc',
    sepolia: 'https://sepolia-rollup.arbitrum.io/rpc',
  },
  optimism: {
    mainnet: 'https://mainnet.optimism.io',
    sepolia: 'https://sepolia.optimism.io',
  },
  base: { mainnet: 'https://mainnet.base.org', sepolia: 'https://sepolia.base.org' },
};

/** `https://<host>.g.alchemy.com/v2/<key>`. */
const ALCHEMY: Table = {
  ethereum: { mainnet: 'eth-mainnet', sepolia: 'eth-sepolia', hoodi: 'eth-hoodi' },
  bsc: { mainnet: 'bnb-mainnet', testnet: 'bnb-testnet' },
  polygon: { mainnet: 'polygon-mainnet', amoy: 'polygon-amoy' },
  avalanche: { mainnet: 'avax-mainnet', fuji: 'avax-fuji' },
  arbitrum: { mainnet: 'arb-mainnet', sepolia: 'arb-sepolia' },
  optimism: { mainnet: 'opt-mainnet', sepolia: 'opt-sepolia' },
  base: { mainnet: 'base-mainnet', sepolia: 'base-sepolia' },
};

/** `https://<host>.infura.io/v3/<key>`. */
const INFURA: Table = {
  ethereum: { mainnet: 'mainnet', sepolia: 'sepolia', hoodi: 'hoodi' },
  bsc: { mainnet: 'bsc-mainnet', testnet: 'bsc-testnet' },
  polygon: { mainnet: 'polygon-mainnet', amoy: 'polygon-amoy' },
  avalanche: { mainnet: 'avalanche-mainnet', fuji: 'avalanche-fuji' },
  arbitrum: { mainnet: 'arbitrum-mainnet', sepolia: 'arbitrum-sepolia' },
  optimism: { mainnet: 'optimism-mainnet', sepolia: 'optimism-sepolia' },
  base: { mainnet: 'base-mainnet', sepolia: 'base-sepolia' },
};

/** `https://rpc.ankr.com/<path>/<key>`: only the paths Ankr's documentation shows. */
const ANKR: Table = {
  ethereum: { mainnet: 'eth' },
  bsc: { mainnet: 'bsc' },
  avalanche: { mainnet: 'avalanche' },
  arbitrum: { mainnet: 'arbitrum' },
  base: { mainnet: 'base' },
};

function entry(table: Table, input: PresetInput): string {
  const value = table[input.chain]?.[input.network];
  // Unreachable through the catalog, which asks `supports` first.
  if (value === undefined)
    throw new Error(`no entry for ${input.chain}:${input.network}`);
  return value;
}

/** The revealed key; the error names the preset and network, never the key. */
function apiKeyOf(name: string, input: PresetInput): string {
  const key: unknown = input.apiKey === undefined ? undefined : reveal(input.apiKey);
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ConfigError(
      'CONFIG_INVALID',
      `provider preset '${name}' requires a non-empty apiKey for ${input.chain}:${input.network}`,
    );
  }
  return key;
}

function keyed(
  name: string,
  table: Table,
  url: (value: string, key: string) => string,
): ProviderPreset {
  return {
    name,
    kind: 'rpc',
    requiresApiKey: true,
    supports: (chain, network) => table[chain]?.[network] !== undefined,
    endpoints: (input): readonly EndpointConfig[] => [
      { name, url: secret(url(entry(table, input), apiKeyOf(name, input))) },
    ],
  };
}

export const EVM_PRESETS: readonly ProviderPreset[] = [
  {
    name: 'public',
    kind: 'rpc',
    production: false,
    supports: (chain, network) => PUBLIC[chain]?.[network] !== undefined,
    endpoints: (input) => [{ name: 'public', url: entry(PUBLIC, input) }],
  },
  keyed('alchemy', ALCHEMY, (host, key) => `https://${host}.g.alchemy.com/v2/${key}`),
  keyed('infura', INFURA, (host, key) => `https://${host}.infura.io/v3/${key}`),
  keyed('ankr', ANKR, (path, key) => `https://rpc.ankr.com/${path}/${key}`),
];
