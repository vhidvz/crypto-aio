import type { AdapterManifest } from '../driver/types';
import { ConfigError } from '../errors/error';
import type { Logger } from '../events/logger';
import type { Capability } from '../model/capability';
import type { ChainInfo, NetworkInfo } from '../model/chain';
import type { Catalogs } from '../registry/plugin';
import { redactDeep, redactHeaders, redactUrl } from '../secret/redact';
import { reveal } from '../secret/secret';
import { signerSchemes } from '../signing/guard';
import type { EndpointConfig } from '../transport/types';
import { deepFreeze } from '../util/freeze';
import { canonicalJson, sha256Hex } from '../util/json';
import { unknownName } from '../util/names';
import { mergeChainDefaults } from './merge';
import type {
  EffectiveOptions,
  HandleOptions,
  ProviderConfig,
  ProviderRef,
  ResolvedProvider,
  ResolvedSelection,
} from './types';

export interface ResolveInput {
  readonly handle: HandleOptions;
  readonly effective: EffectiveOptions;
  readonly catalogs: Catalogs;
  readonly log?: Logger;
}

function toList(
  value: ProviderRef | readonly ProviderRef[] | undefined,
): readonly ProviderRef[] {
  if (value === undefined) return [];
  return Array.isArray(value)
    ? (value as readonly ProviderRef[])
    : [value as ProviderRef];
}

/** Own-key lookup in a named map, so an inherited name (`constructor`, `toString`,
 * `__proto__`, ...) is unknown rather than resolving to an `Object.prototype` member. */
function own<T>(map: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(map, name) ? map[name] : undefined;
}

function inlineName(config: ProviderConfig): string {
  return `inline:${sha256Hex(canonicalJson(config)).slice(0, 8)}`;
}

/** Hash input for credentials: revealed values never leave this function. */
function fingerprint(providers: readonly ResolvedProvider[]): string {
  return sha256Hex(
    canonicalJson(
      providers.map((p) =>
        p.endpoints.map((e) => ({
          name: e.name ?? null,
          kind: e.kind ?? 'rpc',
          url: reveal(e.url),
          headers: Object.fromEntries(
            Object.entries(e.headers ?? {}).map(([k, v]) => [k, reveal(v)]),
          ),
          priority: e.priority ?? 0,
          rateLimit: e.rateLimit ?? null,
          timeoutMs: e.timeoutMs ?? null,
        })),
      ),
    ),
  );
}

function resolveProviders(
  refs: readonly ProviderRef[],
  kind: 'rpc' | 'indexer',
  chain: ChainInfo,
  network: NetworkInfo,
  effective: EffectiveOptions,
  catalogs: Catalogs,
): ResolvedProvider[] {
  return refs.map((ref) => {
    let name: string;
    let config: ProviderConfig;
    if (typeof ref === 'string') {
      name = ref;
      const configured = own(effective.providers, ref);
      if (configured) config = configured;
      else if (catalogs.presets.has(ref, kind)) config = { preset: ref };
      else {
        throw new ConfigError(
          'CONFIG_INVALID',
          unknownName(`${kind} provider`, [
            ...Object.keys(effective.providers),
            ...catalogs.presets.names(kind),
          ]),
        );
      }
    } else {
      name = inlineName(ref);
      config = ref;
    }
    let endpoints: readonly EndpointConfig[];
    let production = true;
    if ('endpoints' in config) {
      endpoints = config.endpoints;
    } else {
      const resolved = catalogs.presets.resolve(
        config.preset,
        {
          chain: chain.id,
          network: network.id,
          ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
          ...(config.options !== undefined ? { options: config.options } : {}),
        },
        kind,
      );
      endpoints = resolved.endpoints;
      production = resolved.preset.production !== false;
    }
    if (endpoints.length === 0)
      throw new ConfigError('CONFIG_INVALID', `provider '${name}' has no endpoints`);
    return {
      name,
      production,
      endpoints: endpoints.map((endpoint, index) => {
        if ((endpoint.kind ?? kind) !== kind) {
          throw new ConfigError(
            'CONFIG_INVALID',
            `provider '${name}' has a ${endpoint.kind} endpoint where ${kind} is required`,
          );
        }
        return { ...endpoint, kind, name: `${name}/${endpoint.name ?? index}` };
      }),
    };
  });
}

function fallbackToPublic(
  kind: 'rpc' | 'indexer',
  chain: ChainInfo,
  network: NetworkInfo,
  effective: EffectiveOptions,
  catalogs: Catalogs,
  log: Logger | undefined,
): ResolvedProvider[] {
  if (!catalogs.presets.has('public', kind)) return [];
  try {
    const resolved = resolveProviders(
      ['public'],
      kind,
      chain,
      network,
      effective,
      catalogs,
    );
    log?.warn(
      `no ${kind} provider configured; using the public provider (not for production)`,
      {
        chain: chain.id,
        network: network.id,
      },
    );
    return resolved;
  } catch {
    return [];
  }
}

export function resolveSelection(input: ResolveInput): ResolvedSelection {
  const { catalogs, effective, log } = input;
  const chain = catalogs.chains.get(input.handle.chain);
  const { chain: _chainId, ...handleRest } = input.handle;
  const merged = mergeChainDefaults(effective.chains[chain.id], handleRest);
  const network = catalogs.chains.network(
    chain.id,
    merged.network ?? chain.defaultNetwork,
  );

  const manifests = catalogs.adapters.forChain(chain.id);
  const defaultManifest = manifests[0];
  if (!defaultManifest) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `no adapter is registered for chain '${chain.id}'; register its plugin`,
    );
  }
  const library = merged.library ?? defaultManifest.library;
  const manifest: AdapterManifest | undefined = catalogs.adapters.get(chain.id, library);
  if (!manifest) {
    throw new ConfigError(
      'INCOMPATIBLE_SELECTION',
      unknownName(
        `library for chain '${chain.id}'`,
        manifests.map((m) => m.library),
      ),
    );
  }

  let providers = resolveProviders(
    toList(merged.provider),
    'rpc',
    chain,
    network,
    effective,
    catalogs,
  );
  if (providers.length === 0)
    providers = fallbackToPublic('rpc', chain, network, effective, catalogs, log);
  if (providers.length === 0) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `no provider configured for ${chain.id}:${network.id}`,
    );
  }
  let indexers = resolveProviders(
    toList(merged.indexer),
    'indexer',
    chain,
    network,
    effective,
    catalogs,
  );
  if (indexers.length === 0 && manifest.requiresIndexer) {
    indexers = fallbackToPublic('indexer', chain, network, effective, catalogs, log);
  }
  if (indexers.length === 0 && manifest.requiresIndexer) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `library '${library}' requires an indexer provider for ${chain.id}:${network.id}`,
    );
  }

  let wallet: ResolvedSelection['wallet'];
  if (merged.wallet !== undefined) {
    const config = own(effective.wallets, merged.wallet);
    if (!config) {
      throw new ConfigError(
        'CONFIG_INVALID',
        unknownName('wallet', Object.keys(effective.wallets)),
      );
    }
    if (config.chains && !config.chains.includes(chain.id)) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `wallet '${merged.wallet}' is not enabled for chain '${chain.id}'`,
      );
    }
    for (const signerId of Object.values(config.signers ?? {})) {
      if (!own(effective.signers, signerId)) {
        throw new ConfigError(
          'CONFIG_INVALID',
          unknownName('signer', Object.keys(effective.signers)),
        );
      }
    }
    wallet = { name: merged.wallet, config };
  }

  let signer: ResolvedSelection['signer'];
  const signerId = merged.signer ?? wallet?.config.signer;
  if (signerId !== undefined) {
    const instance = own(effective.signers, signerId);
    if (!instance) {
      throw new ConfigError(
        'CONFIG_INVALID',
        unknownName('signer', Object.keys(effective.signers)),
      );
    }
    // `Signer` is an interface, so its scheme list is read once and checked.
    const schemes = signerSchemes(signerId, instance);
    if (!chain.schemes.some((scheme) => schemes.includes(scheme))) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `signer '${signerId}' supports ${schemes.join(', ')} but chain '${chain.id}' needs one of ${chain.schemes.join(', ')}`,
      );
    }
    signer = { id: signerId, instance };
  }

  const capabilities = new Set<Capability>(manifest.capabilities);
  if (indexers.length > 0)
    for (const c of manifest.indexerCapabilities ?? []) capabilities.add(c);
  for (const c of network.capabilities?.add ?? []) capabilities.add(c);
  for (const c of network.capabilities?.remove ?? []) capabilities.delete(c);

  const confirmations = merged.confirmations ?? network.defaultConfirmations;
  if (!Number.isInteger(confirmations) || confirmations < 1) {
    throw new ConfigError('CONFIG_INVALID', 'confirmations must be a positive integer');
  }
  const { maxLagBlocks } = merged;
  if (
    maxLagBlocks !== undefined &&
    (!Number.isSafeInteger(maxLagBlocks) || maxLagBlocks < 0)
  ) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'maxLagBlocks must be a non-negative integer',
    );
  }
  const options = deepFreeze(merged.options ?? {});
  const providerNames = providers.map((p) => p.name);
  const indexerNames = indexers.map((p) => p.name);
  const poolKey = sha256Hex(
    canonicalJson({
      chain: chain.id,
      network: network.id,
      library,
      rpc: fingerprint(providers),
      idx: fingerprint(indexers),
      options,
      // The transport's lag tolerance depends on it; omitted when unset.
      maxLagBlocks,
    }),
  );
  const configHash = sha256Hex(
    canonicalJson({
      chain: chain.id,
      network: network.id,
      library,
      providers: providerNames,
      indexers: indexerNames,
      wallet: wallet?.name ?? null,
      signer: signer?.id ?? null,
      options,
      confirmations,
    }),
  );
  return Object.freeze({
    chain,
    network,
    library,
    manifest,
    providers: deepFreeze(providers),
    indexers: deepFreeze(indexers),
    ...(wallet ? { wallet } : {}),
    ...(signer ? { signer } : {}),
    options,
    confirmations,
    ...(maxLagBlocks !== undefined ? { maxLagBlocks } : {}),
    capabilities,
    providerNames,
    indexerNames,
    poolKey,
    configHash,
    handle: { ...handleRest, chain: chain.id, network: network.id, library },
  });
}

/** Redacted, JSON-friendly snapshot for `Blockchain.config`. */
export function describeSelection(
  selection: ResolvedSelection,
): Readonly<Record<string, unknown>> {
  const describeProvider = (p: ResolvedProvider) => ({
    name: p.name,
    production: p.production,
    endpoints: p.endpoints.map((e) => ({
      name: e.name,
      kind: e.kind,
      url: redactUrl(e.url),
      headers: redactHeaders(e.headers),
    })),
  });
  return Object.freeze({
    chain: selection.chain.id,
    network: selection.network.id,
    library: selection.library,
    providers: selection.providers.map(describeProvider),
    indexers: selection.indexers.map(describeProvider),
    wallet: selection.wallet?.name ?? null,
    signer: selection.signer?.id ?? null,
    capabilities: [...selection.capabilities].sort(),
    confirmations: selection.confirmations,
    options: redactDeep(selection.options),
  });
}
