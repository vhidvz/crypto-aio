# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The Avalanche family: the X-Chain (`avalanche-x`) and the P-Chain (`avalanche-p`) on
  mainnet and Fuji, through `@avalabs/avalanchejs` 5 (an optional peer dependency, loaded
  lazily) and the Avalanche Data API as the indexer. AVAX transfers and batches, X-Chain
  memos, the P-Chain's dynamic gas fees, proofs, block scanning, address history,
  `ext.avalanche.listUnspent`, xpub deposit addresses and the `crypto-aio/avalanche` entry.
  The C-Chain stays in the EVM family (`avalanche`).
- `ChainInfo.xpubNetworkClass`: a UTXO chain whose wallets export `xpub` on every network
  (Avalanche) opts out of the SLIP-0132 network-class check of `deriveAddress`.
- The store contract suites pin more of the port: no store error names a sequence key, a
  cursor key, an idempotency key or a wallet address; a `clear` that is not an array is
  refused; and a store that implements `purge` removes what the filter matches and nothing
  else, at most `limit` records (the oldest first), and frees each purged idempotency key. A
  durable store may need changes to pass them.

### Changed

- The documentation is now a site, published from `docs/` at
  <https://vhidvz.github.io/crypto-aio/>: a quick start and a 10-minute mental model, a learning
  path from first principles (blockchain foundations, then the engineering of payments), a
  developer tour of the library, task guides with examples, and a reference (API, configuration,
  errors, capabilities, networks, glossary). The guides' content moved into it; `docs/guides/`
  keeps redirects from the old pages. Code samples marked runnable are executed and type-checked
  by the test suite, and the API and capability pages are checked against the library.
- A watch-only wallet's `publicKey` must be hex of exactly its scheme's key length (33 bytes
  for secp256k1, 32 for ed25519), or the handle fails with `CONFIG_INVALID`. An uncompressed
  secp256k1 key used to derive an address, but no signature ever verified against it.
- `configure()` merges by the same rules as scopes: an `undefined` value no longer removes a
  signer, wallet, provider or lifecycle setting an earlier call set, and a `__proto__` chain
  id is skipped.
- The memory store's `purge` honours the filter's `limit`, the oldest records first, as `list`
  does.

### Fixed

- The memory store refuses a patch whose `clear` is not an array (`INVALID_TRANSITION`)
  instead of reading it as an empty list.
- A configuration that holds a reference cycle fails with `CONFIG_INVALID` instead of
  overflowing the stack.
- A signer whose `schemes` is missing, is not a list of strings or throws fails handle
  resolution with `SIGNER_UNAVAILABLE` and a sanitized cause, not with a `TypeError`.
- A signing failure rethrown after the signer tickets of the same call are cancelled keeps its
  class and its stack.
- A lease release that throws synchronously, or an async `onReleaseError` observer that
  rejects, no longer escapes the lease or goes unhandled.

## [0.1.0] - 2026-10-01

### Added

- initial release 🎉​🎊​.

[Unreleased]: https://github.com/vhidvz/crypto-aio/compare/0.1.0...HEAD
[0.1.0]: https://github.com/vhidvz/crypto-aio/releases/tag/0.1.0
