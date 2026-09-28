# Crypto-AIO

All-In-One Crypto-Currency

[![Build, Test and Publish](https://github.com/vhidvz/crypto-aio/actions/workflows/npm-ci.yml/badge.svg)](https://github.com/vhidvz/crypto-aio/actions/workflows/npm-ci.yml)
[![npm](https://img.shields.io/npm/v/crypto-aio)](https://www.npmjs.com/package/crypto-aio)
![npm](https://img.shields.io/npm/dm/crypto-aio)
[![Coverage](https://raw.githubusercontent.com/vhidvz/crypto-aio/main/docs/coverage.svg)](https://htmlpreview.github.io/?https://github.com/vhidvz/crypto-aio/blob/main/docs/coverage/lcov-report/index.html)
[![GitHub](https://img.shields.io/github/license/vhidvz/crypto-aio?style=flat)](https://github.com/vhidvz/crypto-aio/blob/master/LICENSE)
[![documentation](https://img.shields.io/badge/documentation-click_to_read-c27cf4)](docs/guides/index.md)

## Status

`0.1.0` is under active development: the 0.0.x API (`caio.eth.*`) has been removed and the
library is being rebuilt as a blockchain abstraction layer. See [CHANGELOG.md](CHANGELOG.md),
including the security advisory about credentials that were committed to this repository.

Plan 1 is complete: the SDK-free core and the testing kit (`crypto-aio/testing`). Plan 2,
the EVM family (Ethereum, BNB Smart Chain, Polygon, Avalanche C-Chain, Arbitrum, Optimism and
Base, through ethers or web3), Plan 3, the UTXO family (Bitcoin, through bitcoinjs-lib with
an Esplora indexer), and Plan 4, the Tron family (tronweb), are complete on `main` and ship
in the next release. Solana and TON arrive in Plans 5 and 6.

## Documentation

- [Guides](docs/guides/index.md): what works today, the core concepts and how to use them.
- [Quick start](docs/guides/quick-start.md): a first transfer on the fake chain in 5
  minutes, then a real EVM or Bitcoin network. The [tutorial](docs/guides/tutorial.md)
  reviews the main concepts in 10 hands-on steps.
- API reference: run `pnpm doc`, then open `docs/api/index.html`. The generated site
  includes the guides.
