---
title: Design records
parent: Explore
nav_order: 5
description: The design specification and implementation plans behind crypto-aio 0.1.0, and how they relate to these pages.
---

# Design records

crypto-aio 0.1.0 was designed in a written specification and built in a series of planned
stages, each reviewed against the code. Those working documents are kept in the repository, under
`docs/superpowers/`, for readers who want the reasoning behind a decision.

> [!NOTE]
> These are historical records. They describe what was planned at the time, and some details
> changed while the code was built (the Avalanche X-Chain and P-Chain, for example, were deferred
> in the specification and added after 0.1.0). Where a record and these pages disagree, these
> pages, and the code, are right.

| Record | What it holds |
| --- | --- |
| [The design specification](https://github.com/vhidvz/crypto-aio/blob/main/docs/superpowers/specs/2026-09-23-blockchain-adapter-layer-design.md) | Purpose, architecture, the public API, the domain model, the adapter contract, the transaction lifecycle, signing, observation, transport, stores, errors, testing |
| [The implementation plans](https://github.com/vhidvz/crypto-aio/tree/main/docs/superpowers/plans) | One plan and one handoff per stage: the core, then the EVM, UTXO, Tron, Solana and TON families, and the 0.1.0 release |
| [The backlog after 0.1.0](https://github.com/vhidvz/crypto-aio/blob/main/docs/superpowers/plans/2026-09-30-post-0.1.0-backlog.md) | Known gaps and deferred work, each with the reason it waited |

## Where the specification's topics are now

The specification planned a set of guides; their topics live in these pages:

| Specification topic | Where it is |
| --- | --- |
| Architecture | [The big picture](../tour/architecture.md), [Source map](./source-map.md) |
| Configuration | [Configuration](../reference/configuration.md), [Core concepts](../reference/concepts.md#configuration-precedence) |
| Transactions | [Send a transfer](../build/send.md), [The life of a transfer](../tour/transfer.md) |
| Exchange operations | [Receive deposits](../build/receive.md), [Run workers and recover](../build/workers.md), [Go to production](../build/production.md) |
| Stores | [Write a durable store](./stores.md) |
| Writing adapters | [Write a chain family plugin](./plugins.md) |
| Security | [Keys, signers and secrets](../build/keys.md), [Keys, signers and policy](../tour/keys.md) |
