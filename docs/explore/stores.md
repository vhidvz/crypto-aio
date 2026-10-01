---
title: Write a durable store
parent: Explore
nav_order: 4
description: The store ports, their contract suites, data classification and what every store must preserve.
---

# Write a durable store

crypto-aio keeps all of its state in four stores, and ships only in-memory ones. They work in
one process and lose everything on restart, which is right for tests and wrong for money. In
production you implement the four ports on your own database (Postgres, Redis, DynamoDB, …)
and pass them to the container as `stores`. [Persistence and crash
recovery](../learn/engineering/persistence.md) and [Concurrency: locks, leases and
fencing](../learn/engineering/concurrency.md) explain the ideas these ports rest on.

```ts
const aio = new CryptoAio({
  namespace: 'payments', // prefixes every store key: one namespace per tenant
  stores: { operations, locks, sequences, cursors }, // your implementations
  // …
});
```

## The four ports

| Port | Holds | Methods |
| --- | --- | --- |
| `OperationStore` | Operations, their Attempts, each Attempt's latest observation, and worker claims | `create`, `get`, `getByKey`, `findByRef`, `update`, `appendAttempt`, `getObservation`, `putObservation`, `claimDue`, `releaseClaim`, `list`, and optionally `purge` |
| `LockManager` | Leases: short, renewable locks, each with a fencing token that grows on every acquisition | `acquire`, `renew`, `release` |
| `SequenceStore` | The next nonce per address, and nonces released for reuse | `get`, `put` |
| `CursorStore` | Scanner positions | `get`, `put` |

Every write that can race carries the version it expects (`expectedVersion`), and the
Operation writes of a worker carry its claim's `Fence`. A write against an older version or
fence must fail with `VERSION_CONFLICT` or `FENCING`, so that a process that paused, lost its
lease and woke up later can never overwrite newer work. The type definitions, with the exact
contract of each method in their JSDoc, are in `src/core/store/types.ts`.

## The contract suites

Every store must pass the contract suites. They take your framework's `describe` and `it`,
so they run under Jest, Vitest or `node:test`. Each `create()` must return a fresh, empty
store, such as a new schema or key prefix per test:

```ts
import {
  describeCursorStoreContract, describeLockManagerContract,
  describeOperationStoreContract, describeSequenceStoreContract,
} from 'crypto-aio/testing';

const api = { describe, it };
describeOperationStoreContract(api, async () => ({ operations: await pgOperations(), advance: sleep }));
describeLockManagerContract(api, async () => ({ locks: await redisLocks(), advance: sleep }));
describeSequenceStoreContract(api, async () => ({ sequences: await redisSequences() }));
describeCursorStoreContract(api, async () => ({ cursors: await pgCursors() }));
```

`advance(ms)` moves the store's notion of time forward: a fake clock, or a real sleep. The
suites include stale-worker cases. A worker pauses, its lease expires, another takes over,
and the stale write must fail with `FENCING` or `VERSION_CONFLICT`. crypto-aio ships only the
store ports, the in-memory stores and these suites. Durable stores, such as Redis or
Postgres, are yours to write, and the suites define what they must do.

One expectation reaches beyond the suites, which test one store instance: `findByRef` is
read-your-writes consistent across every process that shares the store. It sees any
`appendAttempt` another instance committed before the call, so no read replica or
eventually consistent index may serve it. The guard that stops two Operations from
recording the same transaction relies on it. Its guarantee also assumes that `appendAttempt`
completes within `lifecycle.leaseMs`, since the ref lease is not renewed. A slower store
weakens it.

Every Attempt's `ordering` must also read back whole and unchanged, whatever its kind, with
every property the driver put in it and its type, and so must an Operation's `reservation`.
The operation-store suite checks one ordering of each built-in family, with bigints beyond
2^53 (`SAMPLE_ORDERINGS` in `crypto-aio/testing`), after the append and after a later
write. A Tron Attempt's ordering is a `TronExpiryOrdering`: the core `expiry` ordering,
with `expiresAtMs` and its optional `lastValidHeight` (a bigint), which Tron always sets to
the reference block's height plus 65,536, plus `refBlockHash`, the reference block bytes the
transaction signs. The expiry proof reads them from the store, not from the signed bytes, to
find every block that could hold the transaction, so keeping them exact is a safety
precondition, not only a liveness one. A lost `refBlockHash` or `lastValidHeight` only stalls
the proof, but a changed one of either (a `lastValidHeight` with other low 16 bits makes the
proof search the wrong heights), or an `expiresAtMs` rounded down (to whole seconds, say),
can prove a transaction `expired` although a block holds it, and `rebuild` then pays twice.
A prepared transfer whose stored ordering changed cannot be signed (`SIGNING_FAILED`).

A Solana Attempt's ordering is a `SolanaExpiryOrdering`: `kind: 'expiry'` and
`lastValidHeight` (a bigint), plus `blockhash` (base58 text) and `blockhashSlot` (a
bigint), all recorded by the build. The expiry proof reads them from the store, not from
the signed bytes, to find every block that could hold the transaction, so keeping them
exact is a safety precondition, not only a liveness one. A lost or unreadable property at
worst leaves the Attempt undecided, never `expired`, so `rebuild` stays refused. But a
changed `blockhash` misplaces the window: the proof can then find the transaction absent
from blocks that could never hold it and prove it `expired` although it landed, and
`rebuild` then pays twice.

A TON Attempt's ordering is a `TonSeqnoOrdering`: `kind: 'seqno'` and `seqno` (a bigint),
plus `validUntil`, the chain time in seconds at which the message expires, and `validFrom`,
the chain time the build ran at, both numbers. The proofs read all three from the store,
not from the signed bytes, so keeping them exact is a safety precondition, not only a
liveness one. A lost `validFrom` only costs time, but a changed seqno, or a `validUntil`
changed or rounded down, can prove a transfer that landed `expired` or `replaced`, and a
`validFrom` moved later hides a wallet reset that happened before it; either way `rebuild`
then pays twice ([TON networks](../reference/networks/ton.md)).

Never store a key set to `undefined` as a value, such as `NULL`, whether it is in an
`OperationStore` patch or in an observation:

- In an `update` or `appendAttempt` patch, the stored field keeps its value. Only `clear`
  removes a field.
- `putObservation` replaces the whole observation, so a field that is left out or set to
  `undefined` reads back `undefined` (never `null`). The core relies on this to clear a
  stale failure reason or an orphaned block.

## Data classification (for store implementers)

The core never hands key material to a store. It classifies everything else it persists in
`DATA_CLASSIFICATION`, field by field, for Operations, Attempts and observations. Backing
stores can then encrypt and retain data per field.

| Class | Examples | Handling |
| --- | --- | --- |
| `secret` | none; the core never persists secrets | n/a |
| `sensitive` | intent (addresses, amounts, memo, output variants), unsigned payload, context, idempotency key, reservation and Attempt ordering, signer tickets, partial signatures, fees, errors, an observation's `reason` (a node's refusal text or the driver's on-chain failure reason) | Encrypt at rest |
| `sensitive-until-broadcast` | Attempt `raw` bytes and `ref` | Public once broadcast; before that they reveal pending treasury activity |
| `operational` | ids, states, versions, claims, timestamps, heights, hashes | Safe for telemetry |

An Operation's `reservation` and an Attempt's `ordering` are `sensitive`, because an `inputs`
ordering lists UTXO outpoints, which tie a wallet to its coins. A nonce or seqno value on its
own is operational, and the `nonce.allocated` and `nonce.gap` events carry it.

- Store plain data only: objects, arrays, strings, numbers, booleans, `bigint` and
  `Uint8Array`. `stringifyTagged` and `parseTagged` round-trip bigint and bytes through JSON.
- Keep keys out of store error messages. Sequence keys contain wallet addresses, and error
  messages reach logs.
- The core never deletes records. `OperationStore.purge?(filter)` is optional, and retention
  is your decision.
- Prove your stores with the contract suites from `crypto-aio/testing`. See
  [The contract suites](#the-contract-suites) above.
