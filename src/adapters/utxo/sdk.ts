/**
 * The one place that loads bitcoinjs-lib. Its 7.x package is an ES module with a CommonJS
 * build (`require` condition), so this CommonJS library `require()`s it at run time and
 * takes its types with `resolution-mode: 'import'` (TypeScript refuses a plain CommonJS
 * import of an ES module's types, TS1479). Loaded only through the manifest's `load()`.
 */
import type * as Bitcoin from 'bitcoinjs-lib' with { 'resolution-mode': 'import' };
import { nobleEcc } from './ecc';

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const bitcoin = require('bitcoinjs-lib') as typeof Bitcoin;

export type Network = Bitcoin.Network;
export type Psbt = Bitcoin.Psbt;
export type Transaction = Bitcoin.Transaction;

/**
 * Installs the `@noble/curves` backend (no WASM, no tiny-secp256k1). bitcoinjs
 * verifies it against its own test vectors the first time, and skips a repeat install of
 * the same object, so calling this before every taproot use is cheap and undoes a
 * `native()` caller who swapped the library-global backend.
 */
export function useNobleEcc(): void {
  bitcoin.initEccLib(nobleEcc);
}
