import type { Signer } from '../signing/types';
import type {
  ChainDefaults,
  EffectiveOptions,
  Hooks,
  LifecycleOptions,
  ProviderConfig,
  ScopeOptions,
  WalletConfig,
} from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Recursive merge of plain objects; arrays, class instances and Secrets are atomic. */
export function deepMerge(
  base: Readonly<Record<string, unknown>> | undefined,
  over: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over ?? {})) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] =
      isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

/** Shallow merge where `undefined` never overrides. */
function shallow<T extends object>(base: T | undefined, over: T | undefined): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over ?? {}))
    if (value !== undefined) out[key] = value;
  return out as T;
}

/** Chain defaults: fields are atomic (provider lists are replaced), `options` deep-merges. */
export function mergeChainDefaults(
  base: ChainDefaults | undefined,
  over: ChainDefaults | undefined,
): ChainDefaults {
  const merged = shallow(base, over);
  const options = deepMerge(base?.options, over?.options);
  return Object.keys(options).length > 0 ? { ...merged, options } : merged;
}

/** Merges configuration layers from least to most specific. */
export function mergeScopes(
  layers: readonly (ScopeOptions | undefined)[],
): EffectiveOptions {
  const chains: Record<string, ChainDefaults> = {};
  let providers: Readonly<Record<string, ProviderConfig>> = {};
  let signers: Readonly<Record<string, Signer>> = {};
  let wallets: Readonly<Record<string, WalletConfig>> = {};
  let hooks: Hooks = {};
  let lifecycle: LifecycleOptions = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [id, defaults] of Object.entries(layer.chains ?? {})) {
      chains[id] = mergeChainDefaults(chains[id], defaults);
    }
    providers = shallow(providers, layer.providers);
    signers = shallow(signers, layer.signers);
    wallets = shallow(wallets, layer.wallets);
    hooks = shallow(hooks, layer.hooks);
    lifecycle = shallow(lifecycle, layer.lifecycle);
  }
  return { chains, providers, signers, wallets, hooks, lifecycle };
}
