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
from finalized chain data.

## Status

Plan 1 (the core) is complete. **The only chain family that ships today is the fake family**
from `crypto-aio/testing`. It is a deterministic, in-memory chain for learning and testing.
Real chain families are planned:

| Area | Status |
| --- | --- |
| Core: container, handles, configuration, Operations, idempotency, crash recovery, background workers, scanner, transport, signers, stores | Works today |
| Fake chain family (`fakechain`, `fakeexpiry`, `fakeseqno`) from `crypto-aio/testing` | Works today |
| EVM: Ethereum, BSC, Polygon, Avalanche C-Chain, Arbitrum, Optimism, Base (ethers, web3) | Planned, Plan 2 |
| UTXO / Bitcoin (bitcoinjs-lib with an Esplora indexer) | Planned, Plan 3 |
| Tron (tronweb) | Planned, Plan 4 |
| Solana (@solana/web3.js) | Planned, Plan 5 |
| TON (@ton/ton) | Planned, Plan 6 |

Today, `Blockchain.create({ chain: 'ethereum' })` fails with `ConfigError` (`CONFIG_INVALID`,
"unknown chain"). No family plugin is registered for it yet. In these guides, every example
for a real network is marked **"shape of the API once the adapter ships (planned)"**.

## Map of the guides

| Guide | Read it when you want to… |
| --- | --- |
| [Quick start](./quick-start.md) | Install the package and run a first transfer in 5 minutes |
| [Core concepts](./concepts.md) | Learn the vocabulary: handle, Operation, Attempt, evidence, and the rest |
| [Tutorial](./tutorial.md) | Check your understanding with 10 hands-on steps on the fake chain, about 20 minutes |
| [Sending and receiving](./transactions.md) | Build withdrawals and deposit scanning, and handle errors |
| [Keys, signers and secrets](./security.md) | Choose a signer, add a policy hook, protect secrets, go to production |
| [Using any blockchain network](./networks.md) | Understand how networks are supported, and write a chain family plugin |

## API reference

The API reference is generated from the source with TypeDoc:

```sh
pnpm doc
```

Then open `docs/api/index.html` in a browser. The reference covers the three entry points:
`crypto-aio`, `crypto-aio/testing` and `crypto-aio/native`. It also includes these guides.
