---
title: Design records
description: Where the reasoning behind crypto-aio's design lives now, and the open work inside the library.
---

# Design records

crypto-aio 0.1.0 was designed in a written specification and built in a series of planned
stages, each reviewed against the code. What those reviews established now lives next to what it
explains:

- **In the code.** A comment states each rule's reason where the rule is enforced: the attack it
  stops, the node behavior it works around, the trade-off it makes. Tests say in their names what
  they pin.
- **In these pages.** The guides and reference describe the behavior you can rely on, and
  [Stability before 1.0](../reference/stability.md#known-gaps) lists what the library does not do
  yet.

The original documents, with the full history of each decision, are in the repository's history:
[`docs/superpowers/` at commit `694cf12`](https://github.com/vhidvz/crypto-aio/tree/694cf12a864b03f42fff6489be9ab3c94c225fb1/docs/superpowers).
Where they and these pages disagree, these pages, and the code, are right.

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

## Open work inside the library

The gaps a user can meet are in [Stability before 1.0](../reference/stability.md#known-gaps).
These are the ones a contributor meets: none changes what a caller sees today, and each says why
it waited.

**Broadcasting and verdicts**

- A first-broadcast `rejected` could need a second endpoint's agreement, in the core, as defence
  in depth. Every family already keeps `rejected` only when the claimed reason holds for its own
  bytes, so this needs a `Broadcaster` port change for little gain; the same holds for a
  must-conflict set in the core, and for the broadcast fanout taking the first HTTP 200 answer
  (a lying 200 refusal is only a transient `TX_REFUSED`).
- The resend guard could move to the `Broadcaster` (it gets the ordering, or a veto hook), so
  every family whose ordering can repeat guards its resends. TON guards in its broadcaster today.
- `recover()` skips its checks when the write target cannot be resolved; rebroadcast still
  requires the wallet's ownership check. The first inclusion is recorded from one endpoint's
  observation (the verdict stays under the proof quorum). Wallet resolution for the all-rejected
  verdict is bounded by neither the caller's signal nor a per-pass cache.
- Reconciliation scans from the chain's pending count, and a refusal can hide behind `dropped`
  after an ambiguous resend.

**EVM**

- `cancelBase` ranks a replacement by total charges and needs a price comparator; the other
  families compare prices.
- The nonce search behind a verdict repeats on every pass; a cache per sender and nonce would
  save the reads.
- An endpoint-set change between "slot consumed" and "included final" decides nothing.
- The proof keys were never audited for raw-text differences between honest endpoints (the other
  families were): a difference stalls, never decides.
- `crypto-aio/evm` could split its typings per library (ethers, web3).

**Bitcoin**

- On replace or cancel the own-transaction record is not cleared; a double-spent parent is not
  proven dead with its child; authenticated parents could be embedded with `updateInput`, and a
  p2pkh finalize could skip a quadratic decode.

**Tron, Solana and TON**

- Tron reads `getForbidTransferToContract` from one endpoint, not under the proof quorum; the
  scripted test node's genesis timestamp is not Nile's.
- Solana caches a mint that every endpoint calls absent for the container's life, and could skip
  a slot read while the finalized slot is still below the blockhash's.
- TON's read path could retry asset failures (keep the junk-jetton tests); a bounce could be
  authenticated from the chain itself.

**Transport**

- A trial request to a recovering proof endpoint has no bounded wait for a rate-limit token, so a
  burst of one can keep it out. A half-open endpoint can admit a second request.
- Rate limits could be per method, proof reads could wait out a short `429`, and one bucket per
  host could cover every handle's transports; this needs measurements on live endpoints.

**Structure and tests**

- The families' ordering fields have no typed home in the core (a store contract pins them
  instead); `engine.ts` and TON's `proofs.ts`, `reader.ts` and `api.ts` are long, as are the TON
  and UTXO end-to-end tests.
- The only-native guard is text-based, and the pooled driver is reachable through
  TypeScript-protected handle methods, which could become module functions.
- No test watches `require.cache` across families; the packaging check proves today that every
  entry point loads with no SDK.
- `CRYPTO_AIO_INTEGRATION_WRITE=1` enables no test yet: funded write tests need testnet keys in
  CI. Determinism in tests could improve with a container option for the transport id and the
  random source, a store clock, and one shared end-to-end environment.
