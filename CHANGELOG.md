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

## [0.1.0] - 2026-10-01

### Added

- initial release 🎉​🎊​.

[Unreleased]: https://github.com/vhidvz/crypto-aio/compare/0.1.0...HEAD
[0.1.0]: https://github.com/vhidvz/crypto-aio/releases/tag/0.1.0
