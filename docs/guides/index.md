---
title: crypto-aio guides
summary: What crypto-aio is, what works today, and a map of the guides.
children:
  Quick start: ./quick-start.md
  Core concepts: ./concepts.md
  'Tutorial: review the concepts in 20 minutes': ./tutorial.md
  Sending and receiving: ./transactions.md
  Keys, signers and secrets: ./security.md
  Using any blockchain network: ./networks.md
---

<!-- markdownlint-disable-next-line MD025 -->
# crypto-aio guides

crypto-aio is a TypeScript blockchain adapter layer for exchanges, wallets and payment
systems. It gives you one API for balances, transfers, confirmations and deposit scanning. A
chain-specific driver sits under that API. The library makes transfers idempotent and
crash-safe. It persists every signed transaction before it broadcasts it. Once a transaction
is signed, the library reports a terminal state, such as final or failed, only with proof
from finalized chain data. The one exception is a transaction that nodes reject as never
valid (`TX_REJECTED`): such bytes can never land, so that verdict needs no chain proof.

## Status

The library ships in roadmap milestones called plans. Plan 1, the core, and Plan 2, the
**EVM family**, are complete: Ethereum, BNB Smart Chain, Polygon, Avalanche C-Chain,
Arbitrum, Optimism and Base, through ethers (the default) or web3. The fake family from
`crypto-aio/testing` is a deterministic, in-memory chain for learning and testing. Plan 3,
the **UTXO family**, Plan 4, the **Tron family**, Plan 5, the **Solana family**, and Plan 6,
the **TON family**, are complete too: Bitcoin (mainnet, testnet, testnet4, signet, regtest)
through bitcoinjs-lib and an Esplora indexer, Tron through tronweb, Solana (mainnet, devnet
and testnet) through `@solana/web3.js`, and TON (mainnet and testnet) through `@ton/ton`.

**Only in-memory stores ship.** They work in one process and lose everything on restart.
In production you supply your own `OperationStore`, `LockManager`, `SequenceStore` and
`CursorStore` (for example on Postgres or Redis), and validate them with the contract suites
in `crypto-aio/testing`; see [Testing an adapter or a store](./networks.md#testing-an-adapter-or-a-store).

| Area | Status |
| --- | --- |
| Core: container, handles, configuration, Operations, idempotency, crash recovery, background workers, scanner, transport, signers | Works today |
| Store interfaces, in-memory stores and the store contract suites | Works today |
| Durable stores (Postgres, Redis, …) | Not shipped: bring your own |
| Fake chain family (`fakechain`, `fakeexpiry`, `fakeseqno`) from `crypto-aio/testing` | Works today |
| EVM: Ethereum, BSC, Polygon, Avalanche C-Chain, Arbitrum, Optimism, Base (ethers, web3) | Works today; no address history yet (it needs an indexer) |
| UTXO / Bitcoin (bitcoinjs-lib with an Esplora indexer) | Works today; no tokens, no OP_RETURN memo |
| Tron (tronweb) | Works today; address history needs an indexer provider (`trongrid` or `public`) |
| Solana (@solana/web3.js) | Works today: SOL, classic SPL tokens, memos, scanning and history without an indexer; needs Node.js 22.12 or later |
| TON (@ton/ton): Gram and jettons, v4r2 and v5r1 wallets | Works today; needs an indexer (toncenter API v3); one output per transfer; no block scan (TON is sharded) |

`Blockchain.create({ chain: 'ethereum', provider: … })` works once the SDK is installed:
`npm install ethers`, or `npm install web3` and `library: 'web3'` on the handle, since ethers
is the default; see
[Configuring a real network](./quick-start.md#configuring-a-real-network-evm).
`chain: 'bitcoin'` needs `npm install bitcoinjs-lib`; see
[Configuring a real network (Bitcoin)](./quick-start.md#configuring-a-real-network-bitcoin).
`Blockchain.create({ chain: 'tron', provider: … })` works once tronweb is installed
(`npm install tronweb`); mainnet needs a TronGrid key or another provider, see
[Tron networks](./networks.md#tron-networks).
`Blockchain.create({ chain: 'solana', provider: … })` works once `@solana/web3.js` is
installed (`npm install @solana/web3.js`), on Node.js 22.12 or later; see
[Configuring a real network (Solana)](./quick-start.md#configuring-a-real-network-solana).
`Blockchain.create({ chain: 'ton', provider: …, indexer: … })` works once the TON SDKs are
installed (`npm install @ton/ton @ton/core @ton/crypto`), with toncenter's API v3 as the
`indexer`; see
[Configuring a real network (TON)](./quick-start.md#configuring-a-real-network-ton).

## Map of the guides

| Guide | Read it when you want to… |
| --- | --- |
| [Quick start](./quick-start.md) | Install the package and run a first transfer in 5 minutes |
| [Core concepts](./concepts.md) | Learn the vocabulary: handle, Operation, Attempt, evidence, and the rest |
| [Tutorial](./tutorial.md) | Check your understanding with 10 hands-on steps on the fake chain, about 20 minutes |
| [Sending and receiving](./transactions.md) | Build withdrawals and deposit scanning, and handle errors |
| [Keys, signers and secrets](./security.md) | Choose a signer, add a policy hook, protect secrets, go to production |
| [Using any blockchain network](./networks.md) | See what each EVM, Bitcoin, Tron, Solana and TON network supports, add your own, or write a chain family plugin |

## API reference

The API reference is generated from the source with TypeDoc:

```sh
pnpm doc
```

Then open `docs/api/index.html` in a browser. The reference covers the eight entry points:
`crypto-aio`, `crypto-aio/evm`, `crypto-aio/utxo`, `crypto-aio/tron`, `crypto-aio/solana`,
`crypto-aio/ton`, `crypto-aio/testing` and `crypto-aio/native`. It also includes these
guides.
