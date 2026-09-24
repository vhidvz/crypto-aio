import { setDefaultBlockchainFactory } from '../blockchain/default-ref';
import { mergeChainDefaults } from '../config/merge';
import type { AioOptions, ChainDefaults, HandleOptions } from '../config/types';
import type { Stores } from '../store/types';
import { CryptoAio } from './container';
import { containerOf } from './internals';

let instance: CryptoAio | undefined;
let accumulated: AioOptions = {};

function mergeAioOptions(base: AioOptions, next: AioOptions): AioOptions {
  const chains: Record<string, ChainDefaults> = { ...base.chains };
  for (const [id, defaults] of Object.entries(next.chains ?? {})) {
    chains[id] = mergeChainDefaults(chains[id], defaults);
  }
  const defined = Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  ) as AioOptions;
  return {
    ...base,
    ...defined,
    chains,
    providers: { ...base.providers, ...next.providers },
    signers: { ...base.signers, ...next.signers },
    wallets: { ...base.wallets, ...next.wallets },
    hooks: { ...base.hooks, ...next.hooks },
    lifecycle: { ...base.lifecycle, ...next.lifecycle },
    transport: { ...base.transport, ...next.transport },
    plugins: [...(base.plugins ?? []), ...(next.plugins ?? [])],
  };
}

/** The container behind `Blockchain.create`. Prefer explicit containers for multi-tenant use. */
export function defaultContainer(): CryptoAio {
  instance ??= new CryptoAio(accumulated);
  return instance;
}

function definedStores(stores: Partial<Stores> | undefined): Partial<Stores> {
  return Object.fromEntries(
    Object.entries(stores ?? {}).filter(([, store]) => store !== undefined),
  ) as Partial<Stores>;
}

/**
 * Merges options into the default container. Existing handles keep their frozen config; the
 * stores are carried over key by key (not wholesale) so Operations stay visible even across
 * a `configure()` call that names only some of them. Intended for application startup.
 *
 * Each call starts a new generation of the default container (a new event bus, owner id and
 * driver pool); it never closes the previous one.
 */
export function configure(options: AioOptions): CryptoAio {
  const previousStores = instance ? containerOf(instance).runtime.stores : undefined;
  const stores: Partial<Stores> = { ...previousStores, ...definedStores(options.stores) };
  accumulated = mergeAioOptions(accumulated, options);
  instance = new CryptoAio({ ...accumulated, stores });
  return instance;
}

/** Forgets the default container (tests). */
export function resetDefaultContainer(): void {
  instance = undefined;
  accumulated = {};
}

setDefaultBlockchainFactory((config: HandleOptions) =>
  defaultContainer().blockchain(config as never),
);
