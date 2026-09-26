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
`crypto-aio/testing` is a deterministic, in-memory chain for learning and testing. The other
real chain families are planned.

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
| UTXO / Bitcoin (bitcoinjs-lib with an Esplora indexer) | Planned, Plan 3 |
| Tron (tronweb) | Planned, Plan 4 |
| Solana (@solana/web3.js) | Planned, Plan 5 |
| TON (@ton/ton) | Planned, Plan 6 |

`Blockchain.create({ chain: 'ethereum', provider: … })` works once the SDK is installed
(`npm install ethers`, or `web3`); see
[Configuring a real network](./quick-start.md#configuring-a-real-network-evm). A chain of a
planned family, such as `bitcoin`, still fails with `ConfigError` (`CONFIG_INVALID`,
"unknown chain"). In these guides, an example for a planned family is marked **"shape of the
API once the adapter ships (planned)"**.

## Map of the guides

| Guide | Read it when you want to… |
| --- | --- |
| [Quick start](./quick-start.md) | Install the package and run a first transfer in 5 minutes |
| [Core concepts](./concepts.md) | Learn the vocabulary: handle, Operation, Attempt, evidence, and the rest |
| [Tutorial](./tutorial.md) | Check your understanding with 10 hands-on steps on the fake chain, about 20 minutes |
| [Sending and receiving](./transactions.md) | Build withdrawals and deposit scanning, and handle errors |
| [Keys, signers and secrets](./security.md) | Choose a signer, add a policy hook, protect secrets, go to production |
| [Using any blockchain network](./networks.md) | See what each EVM network supports, add your own, or write a chain family plugin |

## API reference

The API reference is generated from the source with TypeDoc:

```sh
pnpm doc
```

Then open `docs/api/index.html` in a browser. The reference covers the four entry points:
`crypto-aio`, `crypto-aio/evm`, `crypto-aio/testing` and `crypto-aio/native`. It also
includes these guides.
