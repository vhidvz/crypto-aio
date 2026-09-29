/**
 * Solana provider presets (spec §11). Only URL templates verified against the provider's
 * own documentation are listed (Plan 5 appendix); a preset refuses every other cluster with
 * `CONFIG_INVALID`. Keyed URLs are `Secret`s, so the key never reaches logs or errors.
 */
import { ConfigError } from '../../core/errors/error';
import type { PresetInput, ProviderPreset } from '../../core/registry/providers';
import { reveal, secret } from '../../core/secret/secret';
import type { EndpointConfig } from '../../core/transport/types';
import { deepFreeze } from './chains';

type Table = Readonly<Record<string, string>>;

/** The rate-limited public endpoints the Solana documentation lists (not for production). */
const PUBLIC: Table = {
  mainnet: 'https://api.mainnet.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
};

/**
 * The public RPC's published per-IP limits (A28): 100 requests per 10 s, 40 per 10 s for a
 * single method, 40 concurrent connections, so 4 rps. The transport's bucket is per
 * endpoint, not per method, and the published per-method figure does not hold for
 * `getBlock`: devnet and testnet answered HTTP 429 (`Retry-After: 10`) after about 6
 * `getBlock` calls per 10 s in September 2026 (F5-R19, F5-R20). This rate does not keep a
 * block scan or a window proof under that; a scan waits out each 429 and falls behind, and
 * a window proof completes over many passes. A28 keeps the published rate here.
 */
const PUBLIC_RPS = 4;

/** `https://<host>.g.alchemy.com/v2/<key>`. */
const ALCHEMY: Table = { mainnet: 'solana-mainnet', devnet: 'solana-devnet' };

/** `https://<host>.infura.io/v3/<key>`. */
const INFURA: Table = { mainnet: 'solana-mainnet', devnet: 'solana-devnet' };

/** `https://rpc.ankr.com/<path>/<key>`. */
const ANKR: Table = { mainnet: 'solana', devnet: 'solana_devnet' };

const supports =
  (table: Table) =>
  (chain: string, network: string): boolean =>
    chain === 'solana' && Object.hasOwn(table, network);

function entry(table: Table, input: PresetInput): string {
  const value = Object.hasOwn(table, input.network) ? table[input.network] : undefined;
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
    supports: supports(table),
    endpoints: (input): readonly EndpointConfig[] => [
      { name, url: secret(url(entry(table, input), apiKeyOf(name, input))) },
    ],
  };
}

export const SOLANA_PRESETS: readonly ProviderPreset[] = deepFreeze([
  {
    name: 'public',
    kind: 'rpc',
    production: false,
    supports: supports(PUBLIC),
    endpoints: (input: PresetInput) => [
      { name: 'public', url: entry(PUBLIC, input), rateLimit: { rps: PUBLIC_RPS } },
    ],
  },
  keyed('alchemy', ALCHEMY, (host, key) => `https://${host}.g.alchemy.com/v2/${key}`),
  keyed('infura', INFURA, (host, key) => `https://${host}.infura.io/v3/${key}`),
  keyed('ankr', ANKR, (path, key) => `https://rpc.ankr.com/${path}/${key}`),
]);
