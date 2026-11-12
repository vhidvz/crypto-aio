/*
 * Type-level registries. Users and plugins augment them through the package entry, e.g.
 * `declare module 'crypto-aio' { interface ChainRegistry { ethereum: {...} } }`, and plugins
 * inside this package augment the entry module (`declare module '../index'`). Never augment
 * this file directly: an augmentation here and one through the entry are then merged in file
 * order, and a user's chains can be lost.
 */
/** Chain ids, each with its `family` and its `network` names. */
export interface ChainRegistry {}
/** Families, each with its `library` names and its `ext` API type. */
export interface FamilyRegistry {}
/** For `crypto-aio/native`: the SDK client type each library hands out. */
export interface NativeClientMap {}

/** A registered chain id. */
export type ChainId = Extract<keyof ChainRegistry, string>;

type ChainEntry<C extends ChainId> = ChainRegistry[C] extends {
  family: string;
  network: string;
}
  ? ChainRegistry[C]
  : never;

/** The network names of chain `C`. */
export type NetworkOf<C extends ChainId> = ChainEntry<C>['network'];
/** The family of chain `C`. */
export type FamilyOf<C extends ChainId> = ChainEntry<C>['family'];
/** The library names of chain `C`'s family. */
export type LibraryOf<C extends ChainId> =
  FamilyOf<C> extends keyof FamilyRegistry
    ? FamilyRegistry[FamilyOf<C>] extends { library: infer L }
      ? L
      : string
    : string;
/** The `bc.ext` API type of chain `C`'s family. */
export type ExtOf<C extends ChainId> =
  FamilyOf<C> extends keyof FamilyRegistry
    ? FamilyRegistry[FamilyOf<C>] extends { ext: infer E }
      ? E
      : unknown
    : unknown;

/** The built-in SDK library names, for a handle's `library`. */
export const Library = Object.freeze({
  ETHERS: 'ethers',
  /** @deprecated web3.js is no longer maintained: use `ETHERS`. Removed in crypto-aio 2.0. */
  WEB3: 'web3',
  TRONWEB: 'tronweb',
  BITCOINJS_LIB: 'bitcoinjs-lib',
  SOLANA_WEB3_JS: '@solana/web3.js',
  TON: '@ton/ton',
  AVALANCHEJS: '@avalabs/avalanchejs',
} as const);

/** One of the built-in library names. */
export type KnownLibrary = (typeof Library)[keyof typeof Library];
