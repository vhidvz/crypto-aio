import { ConfigError } from '../errors/error';
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

/** Keys that can repoint an object's prototype chain; a merge never copies these. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Whether a merge must skip `key` (`__proto__`, `constructor` or `prototype`). */
export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * B116: config is plain data, so a plain object or array that contains itself is a mistake;
 * it is refused at startup instead of overflowing the stack. `ancestors` holds the path
 * being copied, so one object shared by two branches is still copied, once per branch.
 */
export function assertNoCycle(value: object, ancestors: ReadonlySet<object>): void {
  if (ancestors.has(value)) {
    throw new ConfigError('CONFIG_INVALID', 'the configuration holds a reference cycle');
  }
}

/**
 * Deep-clones plain objects and arrays so a merge result never aliases the caller's input.
 * Class instances (Signer, Secret, ...) and other non-plain values keep their identity.
 */
function cloneValue(value: unknown, ancestors: Set<object> = new Set()): unknown {
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  assertNoCycle(value, ancestors);
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item: unknown) => cloneValue(item, ancestors));
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = cloneValue(v, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Recursive merge of plain objects; arrays, class instances and Secrets are atomic (cloned
 * whole, never merged element by element). Skips `__proto__`/`constructor`/`prototype` keys.
 */
export function deepMerge(
  base: Readonly<Record<string, unknown>> | undefined,
  over: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    if (UNSAFE_KEYS.has(key)) continue;
    out[key] = cloneValue(value);
  }
  for (const [key, value] of Object.entries(over ?? {})) {
    if (value === undefined || UNSAFE_KEYS.has(key)) continue;
    const current = out[key];
    out[key] =
      isPlainObject(current) && isPlainObject(value)
        ? deepMerge(current, value)
        : cloneValue(value);
  }
  return out;
}

/**
 * Shallow merge where `undefined` never overrides. Values are cloned (see `cloneValue`) so a
 * named-map entry replaced whole never aliases the caller's input; class instances keep their
 * identity (`signers` never goes through here — see `byReference`). Skips `__proto__`/`constructor`/`prototype` keys.
 */
function shallow<T extends object>(base: T | undefined, over: T | undefined): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    if (UNSAFE_KEYS.has(key)) continue;
    out[key] = cloneValue(value);
  }
  for (const [key, value] of Object.entries(over ?? {})) {
    if (value === undefined || UNSAFE_KEYS.has(key)) continue;
    out[key] = cloneValue(value);
  }
  return out as T;
}

/**
 * Merges a map of opaque values by name, taking every value by reference (never cloned). Used
 * for `signers`: `Signer` is an interface, so a plain-object signer is legitimate and must keep
 * its identity and its own-property state. `undefined` never overrides. Skips
 * `__proto__`/`constructor`/`prototype` keys.
 */
export function byReference<T>(
  base: Readonly<Record<string, T>> | undefined,
  over: Readonly<Record<string, T>> | undefined,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const layer of [base ?? {}, over ?? {}]) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined && !UNSAFE_KEYS.has(key)) out[key] = value;
    }
  }
  return out;
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
      if (UNSAFE_KEYS.has(id)) continue;
      chains[id] = mergeChainDefaults(chains[id], defaults);
    }
    providers = shallow(providers, layer.providers);
    signers = byReference(signers, layer.signers);
    wallets = shallow(wallets, layer.wallets);
    hooks = shallow(hooks, layer.hooks);
    lifecycle = shallow(lifecycle, layer.lifecycle);
  }
  return { chains, providers, signers, wallets, hooks, lifecycle };
}
