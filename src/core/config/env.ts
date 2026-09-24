import { secret } from '../secret/secret';
import type { ChainDefaults, ProviderRef } from './types';

const PREFIX = 'CRYPTO_AIO';

export function envChainKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Reads routing-only configuration: `CRYPTO_AIO_[<PROFILE>_]<CHAIN>_{NETWORK|LIBRARY|PROVIDER|
 * RPC_URL|INDEXER_URL}`. A profiled key wins over the unprofiled one. `PROVIDER` wins over
 * `RPC_URL`. URLs are wrapped as secrets. Private keys are never read from the environment.
 */
export function readEnvChains(
  env: Readonly<Record<string, string | undefined>>,
  chainIds: readonly string[],
  profile?: string,
): Record<string, ChainDefaults> {
  const active = (profile ?? env[`${PREFIX}_ENV`])?.trim();
  const prefixes = active
    ? [`${PREFIX}_${envChainKey(active)}_`, `${PREFIX}_`]
    : [`${PREFIX}_`];
  const read = (chain: string, key: string): string | undefined => {
    for (const prefix of prefixes) {
      const value = env[`${prefix}${envChainKey(chain)}_${key}`]?.trim();
      if (value) return value;
    }
    return undefined;
  };
  const out: Record<string, ChainDefaults> = {};
  for (const chain of chainIds) {
    const network = read(chain, 'NETWORK');
    const library = read(chain, 'LIBRARY');
    const providerName = read(chain, 'PROVIDER');
    const rpcUrl = read(chain, 'RPC_URL');
    const indexerUrl = read(chain, 'INDEXER_URL');
    const provider: ProviderRef | undefined =
      providerName ??
      (rpcUrl ? { endpoints: [{ name: 'env-rpc', url: secret(rpcUrl) }] } : undefined);
    const defaults: ChainDefaults = {
      ...(network ? { network } : {}),
      ...(library ? { library } : {}),
      ...(provider ? { provider } : {}),
      ...(indexerUrl
        ? {
            indexer: {
              endpoints: [
                {
                  name: 'env-indexer',
                  kind: 'indexer' as const,
                  url: secret(indexerUrl),
                },
              ],
            },
          }
        : {}),
    };
    if (Object.keys(defaults).length > 0) out[chain] = defaults;
  }
  return out;
}
