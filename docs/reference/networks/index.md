---
title: Networks
parent: Reference
nav_order: 6
has_children: true
has_toc: false
description: Every built-in chain family and network, what each supports, and how more networks are added.
---

# Networks

crypto-aio reaches a network through a **chain family plugin**. The plugin contributes data:
chains, networks, native assets, tokens and provider presets. It also contributes one
**adapter manifest** per SDK, whose `load()` pulls in the **driver**. The core holds no chain
data and imports no SDK. [Chains, families and drivers](../../tour/families.md) explains the
design; this page and its children are the reference.

## Built-in families

| Family | Chains (networks) | Ordering | Status |
| --- | --- | --- | --- |
| fake | `fakechain`, `fakeexpiry`, `fakeseqno` (`local`) | nonce, expiry, seqno | **Works today**, from `crypto-aio/testing` (register `fakePlugin()`) |
| EVM (ethers, web3) | Ethereum, BSC, Polygon, Avalanche C-Chain, Arbitrum, Optimism, Base | nonce | **Works today**, built in ([details](./evm.md)) |
| UTXO (bitcoinjs-lib + Esplora) | Bitcoin mainnet, testnet, testnet4, signet, regtest | inputs | **Works today**, built in ([details](./bitcoin.md)) |
| Tron (tronweb) | mainnet, shasta, nile | expiry | **Works today**, built in ([details](./tron.md)) |
| Solana (@solana/web3.js) | mainnet, devnet, testnet | expiry | **Works today**, built in ([details](./solana.md)) |
| TON (@ton/ton) | mainnet, testnet | seqno + expiry | **Works today**, built in; needs an indexer ([details](./ton.md)) |
| Avalanche (@avalabs/avalanchejs) | `avalanche-x`, `avalanche-p` (mainnet, fuji) | inputs | **Works today**, built in; needs an indexer ([details](./avalanche.md)) |

Built-in families register in the package's composition root. Install only the SDK you use
(`npm install crypto-aio ethers`, or `bitcoinjs-lib` for Bitcoin, `tronweb` for Tron,
`@solana/web3.js` for Solana, `@ton/ton @ton/core @ton/crypto` for TON, or
`@avalabs/avalanchejs` for the Avalanche X-Chain and P-Chain); a missing one fails with
`DEPENDENCY_MISSING`. What each network can do is in [Capabilities](../capabilities.md), and
how to configure each family is in [Connect to a real network](../../build/connect.md).

## Libraries

| Library | Status |
| --- | --- |
| `ethers` 6 | Supported, the EVM default |
| `web3` 4 | Supported; sunset upstream (4.16.0 is its last release), so prefer ethers |
| `bitcoinjs-lib` 7 | Supported, over an Esplora indexer |
| `tronweb` 6 | Supported |
| `@solana/web3.js` 1 | Supported |
| `@ton/ton` 16, with `@ton/core` and `@ton/crypto` | Supported, with toncenter API v3 as the indexer |
| `@avalabs/avalanchejs` 5 | Supported, with the Avalanche Data API as the indexer; the C-Chain is served as EVM |
| `@tonconnect/sdk` | Replaced by `@ton/ton`: TonConnect links dApps to user wallets; it is not a node SDK |
| `@bnb-chain/javascript-sdk` | Unsupported: it targets the BNB Beacon Chain, shut down in 2024 (BNB Smart Chain is supported as EVM) |

## What works, and what does not yet

| Area | Status |
| --- | --- |
| Core: container, handles, configuration, Operations, idempotency, crash recovery, background workers, scanner, transport, signers | Works today |
| Store interfaces, in-memory stores and the store contract suites | Works today |
| Durable stores (Postgres, Redis, …) | Not shipped: bring your own ([Write a durable store](../../explore/stores.md)) |
| Fake chain family (`fakechain`, `fakeexpiry`, `fakeseqno`) from `crypto-aio/testing` | Works today |
| EVM: Ethereum, BSC, Polygon, Avalanche C-Chain, Arbitrum, Optimism, Base (ethers, web3) | Works today; no address history yet (it needs an indexer) |
| UTXO / Bitcoin (bitcoinjs-lib with an Esplora indexer) | Works today; no tokens, no OP_RETURN memo |
| Tron (tronweb) | Works today; address history needs an indexer provider (`trongrid` or `public`) |
| Solana (@solana/web3.js) | Works today: SOL, classic SPL tokens, memos, scanning and history without an indexer; needs Node.js 22.12 or later |
| TON (@ton/ton): Gram and jettons, v4r2 and v5r1 wallets | Works today; needs an indexer (toncenter API v3); one output per transfer; no block scan (TON is sharded) |
| Avalanche X-Chain and P-Chain (@avalabs/avalanchejs) | Works today: AVAX, batches, X-Chain memos; needs an indexer (the Avalanche Data API); no replace or cancel; no Avalanche native tokens |

## Provider presets

A preset turns a name and an API key into endpoints. `public` is never for production: it
names free public endpoints, and a handle with no provider configured falls back to it, with
a logged warning, where it serves the network.

| Family | Presets |
| --- | --- |
| EVM | `alchemy`, `infura`, `ankr` (with an `apiKey`), `public` |
| Bitcoin | `mempool` (mempool.space), `blockstream` (blockstream.info), `public` (both); each serves as `provider` and `indexer` |
| Tron | `trongrid` (with an `apiKey`; also the `indexer` for history), `public` |
| Solana | `alchemy`, `infura`, `ankr` (with an `apiKey`), `public` |
| TON | `toncenter` (with an `apiKey`; API v2 as `provider`, v3 as `indexer`), `public` |
| Avalanche X and P | `public` (a public node and the keyless Data API), `glacier` (the Data API, with an `apiKey`, as `indexer`) |

Your own node is a provider too: `{ endpoints: [{ name: 'main', url: secret('https://…') }] }`.

## Three ways a network becomes available

1. **Built in.** The families above, registered by the package.
2. **More networks of an existing family.** A chain of an existing family is data, served by
   the family's driver: any EVM chain is a `ChainInfo` and one call to `evmChainPlugin`. See
   [Add networks to a family](../../explore/custom-networks.md).
3. **A new family.** A plugin with its own adapter and driver. See
   [Write a chain family plugin](../../explore/plugins.md).

## The family pages

- [EVM networks](./evm.md): fees, tokens, presets and the fee ceiling.
- [Bitcoin networks](./bitcoin.md): address types, coin selection, fees, replace and cancel,
  limits, and the Bitcoin safeguards.
- [Tron networks](./tron.md): bandwidth and energy, fee limits, expiry, memos and TronGrid.
- [Solana networks](./solana.md): priority fees, SPL tokens, expiry, scanning and the Solana
  safeguards.
- [TON networks](./ton.md): wallets, jettons, message traces, seqnos and resends.
- [Avalanche X-Chain and P-Chain](./avalanche.md): the two UTXO chains, fees and finality.
