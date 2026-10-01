/**
 * Type-level registries. Users and plugins augment them through the package entry, e.g.
 * `declare module 'crypto-aio' { interface ChainRegistry { ethereum: {...} } }`, and plugins
 * inside this package augment the entry module (`declare module '../index'`). Never augment
 * this file directly: an augmentation here and one through the entry are then merged in file
 * order, and a user's chains can be lost.
 */
export interface ChainRegistry {}
export interface FamilyRegistry {}
export interface NativeClientMap {}

export type ChainId = Extract<keyof ChainRegistry, string>;

type ChainEntry<C extends ChainId> = ChainRegistry[C] extends {
  family: string;
  network: string;
}
  ? ChainRegistry[C]
  : never;

export type NetworkOf<C extends ChainId> = ChainEntry<C>['network'];
export type FamilyOf<C extends ChainId> = ChainEntry<C>['family'];
export type LibraryOf<C extends ChainId> =
  FamilyOf<C> extends keyof FamilyRegistry
    ? FamilyRegistry[FamilyOf<C>] extends { library: infer L }
      ? L
      : string
    : string;
export type ExtOf<C extends ChainId> =
  FamilyOf<C> extends keyof FamilyRegistry
    ? FamilyRegistry[FamilyOf<C>] extends { ext: infer E }
      ? E
      : unknown
    : unknown;

export const Library = Object.freeze({
  ETHERS: 'ethers',
  WEB3: 'web3',
  TRONWEB: 'tronweb',
  BITCOINJS_LIB: 'bitcoinjs-lib',
  SOLANA_WEB3_JS: '@solana/web3.js',
  TON: '@ton/ton',
  AVALANCHEJS: '@avalabs/avalanchejs',
} as const);

export type KnownLibrary = (typeof Library)[keyof typeof Library];
