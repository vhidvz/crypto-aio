/**
 * TON provider presets (spec §11): toncenter's API v2 (a liteserver proxy, the `rpc`
 * endpoint) and API v3 (its indexer). Base URLs, the `X-API-Key` header and the limits (1
 * request per second keyless, 10 with a free key) are verified (Plan 6 appendix). The key
 * travels in a header whose value is a `Secret`, so it never reaches logs, errors or events.
 *
 * X2: one toncenter limit covers every request to a network, v2 and v3 alike (per IP
 * keyless, per account with a key), so each API's endpoint gets half of it. Health probes
 * take their tokens from the same buckets (A17). The split holds on average only: after
 * idle time each API's bucket holds its burst of one token (F6-R3: keyless by default,
 * keyed set explicitly) and refills at its rate, so v2 and v3 together can send 2 requests
 * in the first second keyless (limit 1) and 12 with a key (limit 10); toncenter's 429 then
 * comes back as a retryable `RATE_LIMITED`.
 */
import { ConfigError } from '../../core/errors/error';
import type { PresetInput, ProviderPreset } from '../../core/registry/providers';
import { reveal, secret } from '../../core/secret/secret';
import type { EndpointConfig } from '../../core/transport/types';
import { deepFreeze } from './chains';

const HOSTS: Readonly<Record<string, string>> = Object.freeze({
  mainnet: 'https://toncenter.com',
  testnet: 'https://testnet.toncenter.com',
});

const API: Readonly<Record<'rpc' | 'indexer', string>> = Object.freeze({
  rpc: '/api/v2',
  indexer: '/api/v3',
});

/** Own keys only: `constructor`, `toString` or `__proto__` is not a network. */
const supports = (chain: string, network: string): boolean =>
  chain === 'ton' && Object.hasOwn(HOSTS, network);

function baseUrl(kind: 'rpc' | 'indexer', input: PresetInput): string {
  // Unreachable through the catalog, which asks `supports` first.
  if (!Object.hasOwn(HOSTS, input.network)) {
    throw new Error(`no toncenter host for ${input.network}`);
  }
  return `${HOSTS[input.network]}${API[kind]}`;
}

/** The revealed key; the error names the preset and network, never the key. */
function apiKeyOf(input: PresetInput): string {
  const key: unknown = input.apiKey === undefined ? undefined : reveal(input.apiKey);
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ConfigError(
      'CONFIG_INVALID',
      `provider preset 'toncenter' requires a non-empty apiKey for ${input.chain}:${input.network}`,
    );
  }
  return key;
}

function keyless(kind: 'rpc' | 'indexer'): ProviderPreset {
  return {
    name: 'public',
    kind,
    production: false,
    supports,
    endpoints: (input): readonly EndpointConfig[] => [
      {
        name: 'toncenter',
        url: baseUrl(kind, input),
        // Half of the keyless 1 request per second, shared with the other API (X2).
        rateLimit: { rps: 0.5 },
      },
    ],
  };
}

function keyed(kind: 'rpc' | 'indexer'): ProviderPreset {
  return {
    name: 'toncenter',
    kind,
    requiresApiKey: true,
    supports,
    endpoints: (input): readonly EndpointConfig[] => [
      {
        name: 'toncenter',
        url: baseUrl(kind, input),
        headers: { 'X-API-Key': secret(apiKeyOf(input)) },
        // Half of the free-key limit of 10 requests per second (docs.ton.org/api/rate-limit,
        // M16), shared with the other API (X2), with a burst of one (F6-R3) rather than the
        // default of five; a paid key overrides it with a custom endpoint config.
        rateLimit: { rps: 5, burst: 1 },
      },
    ],
  };
}

/** Built once at module level, so the plugin's functions keep their identity (X6). */
export const TON_PRESETS: readonly ProviderPreset[] = deepFreeze([
  keyless('rpc'),
  keyless('indexer'),
  keyed('rpc'),
  keyed('indexer'),
]);
