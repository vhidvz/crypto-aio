import type { AdapterManifest } from '../driver/types';
import type { ChainInfo } from '../model/chain';
import { AdapterCatalog } from './adapters';
import { AssetCatalog, type AssetRegistration } from './assets';
import { ChainCatalog } from './chains';
import { PresetCatalog, type ProviderPreset } from './providers';
import { BUILTIN_SCHEMES, SchemeCatalog, type SignatureScheme } from './schemes';

/** Everything a chain family contributes. Plugin modules must not import SDKs. */
export interface Plugin {
  readonly name: string;
  readonly chains?: readonly ChainInfo[];
  readonly adapters?: readonly AdapterManifest[];
  readonly presets?: readonly ProviderPreset[];
  readonly assets?: readonly AssetRegistration[];
  readonly schemes?: readonly SignatureScheme[];
}

export interface Catalogs {
  readonly chains: ChainCatalog;
  readonly assets: AssetCatalog;
  readonly adapters: AdapterCatalog;
  readonly presets: PresetCatalog;
  readonly schemes: SchemeCatalog;
  readonly plugins: Set<string>;
}

export function createCatalogs(): Catalogs {
  return {
    chains: new ChainCatalog(),
    assets: new AssetCatalog(),
    adapters: new AdapterCatalog(),
    presets: new PresetCatalog(),
    schemes: new SchemeCatalog(BUILTIN_SCHEMES),
    plugins: new Set(),
  };
}

export function cloneCatalogs(catalogs: Catalogs): Catalogs {
  return {
    chains: catalogs.chains.clone(),
    assets: catalogs.assets.clone(),
    adapters: catalogs.adapters.clone(),
    presets: catalogs.presets.clone(),
    schemes: catalogs.schemes.clone(),
    plugins: new Set(catalogs.plugins),
  };
}

/** Registers a plugin; applying the same plugin name twice is a no-op. */
export function applyPlugin(catalogs: Catalogs, plugin: Plugin): void {
  if (catalogs.plugins.has(plugin.name)) return;
  for (const scheme of plugin.schemes ?? []) catalogs.schemes.register(scheme);
  for (const chain of plugin.chains ?? []) {
    for (const scheme of chain.schemes) catalogs.schemes.get(scheme);
    catalogs.chains.register(chain);
    catalogs.assets.registerNative(chain);
  }
  for (const manifest of plugin.adapters ?? []) {
    for (const chainId of manifest.chains) catalogs.chains.get(chainId);
    catalogs.adapters.register(manifest);
  }
  for (const preset of plugin.presets ?? []) catalogs.presets.register(preset);
  for (const asset of plugin.assets ?? []) {
    catalogs.chains.network(asset.chain, asset.network);
    catalogs.assets.register(asset);
  }
  catalogs.plugins.add(plugin.name);
}
