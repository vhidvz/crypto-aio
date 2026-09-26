import type { AdapterManifest } from '../driver/types';
import { ConfigError } from '../errors/error';
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
  /** A18: every registered plugin by name, to tell a repeat from a different plugin. */
  readonly plugins: Map<string, Plugin>;
}

export function createCatalogs(): Catalogs {
  return {
    chains: new ChainCatalog(),
    assets: new AssetCatalog(),
    adapters: new AdapterCatalog(),
    presets: new PresetCatalog(),
    schemes: new SchemeCatalog(BUILTIN_SCHEMES),
    plugins: new Map(),
  };
}

export function cloneCatalogs(catalogs: Catalogs): Catalogs {
  return {
    chains: catalogs.chains.clone(),
    assets: catalogs.assets.clone(),
    adapters: catalogs.adapters.clone(),
    presets: catalogs.presets.clone(),
    schemes: catalogs.schemes.clone(),
    plugins: new Map(catalogs.plugins),
  };
}

/**
 * Registers a plugin. A18: registering the same plugin again (`samePlugin`) is a no-op, so
 * `use()` stays idempotent; a different plugin under a registered name is `CONFIG_INVALID`.
 */
export function applyPlugin(catalogs: Catalogs, plugin: Plugin): void {
  const registered = catalogs.plugins.get(plugin.name);
  if (registered) {
    if (samePlugin(registered, plugin)) return;
    throw new ConfigError(
      'CONFIG_INVALID',
      `plugin '${plugin.name}' is already registered with a different definition`,
    );
  }
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
  catalogs.plugins.set(plugin.name, plugin);
}

/**
 * A18/A25 (D6): whether two plugins are the same: the same object, or structurally equal
 * data around the same functions. Functions and class instances match only themselves (a
 * closure over other values, or a bound function, is another function), so a factory
 * such as `evmPlugin()` keeps its functions at module level to stay idempotent. Data is
 * every own enumerable key, symbols included, and every array index: a hole matches only
 * a hole (P25-R17).
 */
export function samePlugin(a: Plugin, b: Plugin): boolean {
  return sameShape(a, b, 0);
}

function sameShape(a: unknown, b: unknown, depth: number): boolean {
  if (Object.is(a, b)) return true;
  if (depth > 64) return false;
  if (typeof a === 'function' || typeof b === 'function') return false;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      // Every index: `every` would skip a's holes.
      [...a.keys()].every((i) => i in a === i in b && sameShape(a[i], b[i], depth + 1))
    );
  }
  const proto = Object.getPrototypeOf(a) as unknown;
  if (
    (proto !== Object.prototype && proto !== null) ||
    Object.getPrototypeOf(b) !== proto
  ) {
    return false;
  }
  const left = a as Record<PropertyKey, unknown>;
  const right = b as Record<PropertyKey, unknown>;
  const keys = dataKeys(left);
  return (
    keys.length === dataKeys(right).length &&
    keys.every(
      (key) =>
        Object.prototype.propertyIsEnumerable.call(right, key) &&
        sameShape(left[key], right[key], depth + 1),
    )
  );
}

/** An object's own enumerable keys, symbols included. */
function dataKeys(value: object): (string | symbol)[] {
  return Reflect.ownKeys(value).filter((key) =>
    Object.prototype.propertyIsEnumerable.call(value, key),
  );
}
