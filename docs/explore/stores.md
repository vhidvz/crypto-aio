---
title: Write a durable store
description: The store ports, their contract suites, data classification and what every store must preserve.
---

# Write a durable store

crypto-aio keeps all of its state in four stores, and ships only in-memory ones. They work in
one process and lose everything on restart, which is right for tests and wrong for money. In
production you implement the four ports on your own database (Postgres, Redis, DynamoDB, …)
and pass them to the container as `stores`. [Persistence and crash
recovery](../learn/engineering/persistence.md) and [Concurrency: locks, leases and
fencing](../learn/engineering/concurrency.md) explain the ideas these ports rest on.

<!-- typecheck -->
```ts
import {
  CryptoAio, type CursorStore, type LockManager, type OperationStore, type SequenceStore,
} from 'crypto-aio';
// Your implementations, on your database:
declare const operations: OperationStore, locks: LockManager;
declare const sequences: SequenceStore, cursors: CursorStore;

const aio = new CryptoAio({
  namespace: 'payments', // prefixes every store key: one namespace per tenant
  stores: { operations, locks, sequences, cursors }, // all four: one left out is a memory store
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
lease and woke up later can never overwrite newer work. The type definitions are in
`src/core/store/types.ts`, each method's rules in its JSDoc; [What the suites
check](#what-the-suites-check) lists them.

## The contract suites

Every store must pass the contract suites. They take your framework's `describe` and `it`,
so they run under Jest, Vitest or `node:test`. Each `create()` must return a fresh, empty
store, such as a new schema or key prefix per test:

<!-- typecheck -->
```ts
import type { CursorStore, LockManager, OperationStore, SequenceStore } from 'crypto-aio';
import {
  describeCursorStoreContract, describeLockManagerContract,
  describeOperationStoreContract, describeSequenceStoreContract, type ContractTestApi,
} from 'crypto-aio/testing';
// Yours: your test framework's functions, a fresh store per call, and a real sleep.
declare const describe: ContractTestApi['describe'], it: ContractTestApi['it'];
declare function pgOperations(): Promise<OperationStore>;
declare function redisLocks(): Promise<LockManager>;
declare function redisSequences(): Promise<SequenceStore>;
declare function pgCursors(): Promise<CursorStore>;
declare function sleep(ms: number): Promise<void>;

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

### What the suites check

- **Every port.** A store never puts a key, an idempotency key or a wallet address in an
  error message. A value it returns is a copy: changing it never changes what is stored.
  Bigints and bytes read back exactly.
- **`LockManager`.** `acquire` grants one holder per key and returns `null` to everyone
  else, the holder included: leases are not reentrant. Of concurrent acquirers, exactly one
  wins. Every acquisition's token is larger than any before it on that key, after an expiry
  or a release too. `renew` before expiry keeps the token; after expiry, or once another
  holder took the key, it returns `null`. A `release` with a lease that expired and was
  taken over changes nothing.
- **`SequenceStore` and `CursorStore`.** `get` of an unknown key returns `null`. `put` with
  `expectedVersion: null` creates the key at version 1, and each write raises the version
  by one. A `put` with a stale version, or with `null` on a key that exists, fails with
  `VERSION_CONFLICT` and leaves the stored value unchanged. A sequence write whose `fence`
  is below the stored one fails with `FENCING`.
- **`OperationStore`.** `create` creates only when `(namespace, idempotencyKey)` is absent;
  otherwise it returns the stored record unchanged, even for another `intentHash`, and of
  concurrent creates exactly one wins. It refuses input that carries a field the store owns
  (`version`, `claim`, …), storing nothing. `update` and `appendAttempt` are compare-and-set
  on `expectedVersion`, fenced by a worker's claim, and each success raises the version,
  even one that changes nothing; a patch field outside the writable ones is refused, a
  patch value of `undefined` changes nothing, and `clear` removes a field. `appendAttempt`
  stores the Attempt and the state change together, refuses an Attempt id the Operation
  already holds, and never rewrites earlier Attempts. Observations are versioned and
  replaced whole, and `putObservation` never changes the Operation's version. `claimDue`
  claims each due Operation for one worker only, in `(nextCheckAt, createdAt)` order, up to
  `limit`, within its namespace. `list` returns records in creation order, and `purge`
  removes at most `limit` of what the filter matches, the oldest first. A record of any
  `format` reads back unchanged.

For a starting point, the repository has a reference implementation of all four ports on
PostgreSQL, with the `pg` driver:
[examples/postgres-store](https://github.com/vhidvz/crypto-aio/tree/main/examples/postgres-store).
It passes every suite against a real server in CI, and its README explains each choice:
transactions and row locks, `FOR UPDATE SKIP LOCKED` claims, tokens from sequences, tagged
JSON, the `format` column, and which columns to encrypt. It is an example to copy, not part
of the package.

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

## Upgrades and the record format

Every Operation record carries `format`, the record format it was stored in
(`OPERATION_FORMAT`, 1 today; records of 0.1.0 have none and are format 1). Store it as you
store every other field, and never rewrite it: the contract suite checks that a record of
any format reads back unchanged.

A release that changes how an Operation, its intent, its unsigned transaction, its
ordering data or its Attempts are stored raises `OPERATION_FORMAT` and still reads every
earlier format, so you never migrate records yourself. Nothing else the core stores carries a
format, so its shape is fixed for 1.x: an Attempt's observation, a sequence's `next`,
`released` and `fence`, and a scanner cursor's `height`, `hash` and `recent`. The keys the
core gives the other stores never change in a 1.x release:
`seq:<namespace>:<chain>:<network>:<address>` for nonce state and its lease,
`ref:<namespace>:<refId>` for the lease that keeps two Operations from recording one
transaction, and `<namespace>:<chain>:<network>:<cursorKey>` for a scanner. Neither does the
intent hash behind idempotency keys.

During a rolling upgrade, processes of two versions can share a store. A process never
reads a record of a format newer than it knows: a read of one by id, key or ref throws
`RECORD_FORMAT_UNSUPPORTED`; `aio.operations.list()` and `recover()` leave it out, and its
workers release the claim on one at once, each with a logged warning, and leave it to a
newer process. Upgrade every process before you rely on what the new version stores, and
never run a 0.1.0 process beside a newer one: 0.1.0 has no format check.

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
  `Uint8Array`. `stringifyTagged` and `parseTagged` round-trip bigint and bytes through JSON,
  as `{ "$bigint": "…" }` and `{ "$bytes": "<hex>" }`. `stringifyTagged` refuses, with a
  `TypeError`, a plain object of that shape in the data itself, which would read back
  changed; the core never stores one.
- Keep keys out of store error messages. Sequence keys contain wallet addresses, and error
  messages reach logs. The contract suites check it for sequence and cursor keys, idempotency
  keys and wallet addresses.
- The core never deletes records, and never calls `OperationStore.purge?(filter)`: it is
  optional, for your own retention. When you implement it, it removes what the filter
  matches, as `list` reads it (at most `limit` records, the oldest first), with their
  observations and idempotency keys, live Operations included. So purge only terminal
  Operations (`states: TERMINAL_STATES`), and only once no caller can still retry their
  keys: a key used again after its Operation was purged creates a new Operation and pays
  again, and a purged live Operation loses its signed bytes.
- Prove your stores with the contract suites from `crypto-aio/testing`. See
  [The contract suites](#the-contract-suites) above.
