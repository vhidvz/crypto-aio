# PostgreSQL reference store

A durable implementation of crypto-aio's four store ports (`OperationStore`, `LockManager`,
`SequenceStore`, `CursorStore`) on PostgreSQL 13 or later, with the [`pg`](https://node-postgres.com)
driver. It passes every contract suite of `crypto-aio/testing` against a real server, and runs
the engine end to end: a transfer to proven finality, then a crash, a restart on the same
stores and a recovery that never signs twice. CI runs it on PostgreSQL 16.

It is an example, not part of the package: copy `schema.sql` and `src/` into your project and
adapt them. [Write a durable store](../../docs/explore/stores.md) explains what every store
must do; this page explains how this one does it, and why.

## Use it

```sh
npm install crypto-aio pg
npm install --save-dev @types/pg
```

```ts
import { CryptoAio } from 'crypto-aio';
import { Pool } from 'pg';
import { createPostgresStores, migrate } from './postgres-store';

const pool = new Pool({ connectionString: process.env.DATABASE_URL }); // the primary
await migrate(pool); // creates schema `crypto_aio` and its tables if they do not exist

const aio = new CryptoAio({
  namespace: 'payments',
  stores: createPostgresStores({ pool }),
  // …
});
```

`createPostgresStores({ pool, schema, clock })` takes an optional schema name (default
`crypto_aio`) and an optional clock: pass the same `clock` you give the container, if you
give it one (see [Time](#time)).

To run the tests in this repository, point `CRYPTO_AIO_PG_URL` at a database where the test
may create and drop schemas:

```sh
CRYPTO_AIO_PG_URL=postgres://postgres:postgres@localhost:5432/postgres \
  pnpm exec jest test/examples --coverage=false
```

Without the variable, the test is skipped.

## Files

| File | Holds |
| --- | --- |
| `schema.sql` | The tables, indexes and the claim-token sequence, every statement `IF NOT EXISTS` |
| `src/schema.ts` | `migrate(pool, schema?)`: runs `schema.sql` in one transaction, under an advisory lock |
| `src/db.ts` | The pool wrapper: schema-qualified names, transactions, tagged JSON, sanitized errors |
| `src/operations.ts` | `PostgresOperationStore` |
| `src/locks.ts` | `PostgresLockManager` |
| `src/sequences.ts` | `PostgresSequenceStore` |
| `src/cursors.ts` | `PostgresCursorStore` |
| `src/index.ts` | `createPostgresStores` and the exports |

## Design

### Tables

| Table | One row per | Key |
| --- | --- | --- |
| `operations` | Operation | `(namespace, id)`, and unique `(namespace, idempotency_key)` |
| `attempts` | Attempt, inserted once and never updated | `(namespace, operation_id, position)`, and unique `(namespace, operation_id, id)` |
| `observations` | Attempt's latest observation | `attempt_id` |
| `leases` | lock key | `key` |
| `sequences` | nonce sequence (one per address) | `key` |
| `cursors` | scanner | `key` |

An Operation's fields each have a column; the nested ones (`context`, `intent`, `unsigned`,
`reservation`, `signerTickets`, `partialSignatures`, `error`) hold tagged JSON text. The
fields the store filters, orders or checks on are plain columns: `state`, `next_check_at`,
`version`, the claim, and `chain`, `network` and `from_address`, which are copied out of
`context` and `intent` once, at `create`, since neither ever changes. Attempts live in their
own table, so that `appendAttempt` inserts a row instead of rewriting the Operation's list,
and `findByRef` finds a ref through an index.

Attempt ids are unique per Operation here, not across the store. The port says they are
unique across every Operation and namespace, and the core makes them so (96 random bits), but
the contract suite appends Attempts with the same id to several Operations of one store
("keeps every ordering whole"), so a store-wide unique index on `attempts.id` fails it.

In `src/operations.ts`, the map from fields to columns is typed over `keyof OperationRecord`.
A field the port gains in a later version fails this example's type check until it has a
column.

### Transactions and isolation

Every transaction runs at `READ COMMITTED`, set explicitly in `BEGIN`, so that a server whose
default is `SERIALIZABLE` cannot add serialization failures that this code would have to
retry. Correctness comes from row locks, not from the isolation level:

- **Check, then write, under a lock.** `update`, `appendAttempt`, `releaseClaim` and the
  sequence `put` each run one transaction that first locks the row (`SELECT … FOR UPDATE`),
  then checks it as the memory store does (missing: `NOT_FOUND`; another version:
  `VERSION_CONFLICT`; another claim or a lower fence: `FENCING`), and only then writes. With
  the row locked, nothing can land between the check and the write, and each refusal has its
  exact code. A plain `UPDATE … WHERE version = $n` would be atomic too, but when it matched
  no row, a second read would have to guess whether the version or the fence was wrong.
- **One code, one statement.** `putObservation` and the cursor `put` can only fail with
  `VERSION_CONFLICT`, so each is a single compare-and-set statement: `INSERT … ON CONFLICT
  DO NOTHING` for an expected version of `null`, `UPDATE … WHERE version = $n` otherwise.
  No row back means a conflict.
- **Every successful write bumps `version`**, even a patch that changes nothing: the engine
  fences a stale writer with such a write.
- **Reads are one statement.** A record and its Attempts come from one `SELECT` (the Attempts
  through a subquery), so from one snapshot: a record never pairs one version with another
  version's Attempts. After a write, the record is read back by a statement that starts after
  the lock was taken, so it sees every Attempt, the transaction's own included.
- **`appendAttempt` is atomic with its patch**: the Attempt insert and the Operation update
  are one transaction. A duplicate Attempt id in the Operation inserts nothing (`ON CONFLICT
  DO NOTHING`), and the call fails with `INVALID_TRANSITION`, rolling back.
- **`create` is create-if-absent**: `INSERT … ON CONFLICT DO NOTHING`. When two creates race
  on one idempotency key, Postgres makes the second wait for the first to commit, then
  inserts nothing; it then reads and returns the winner's record unchanged.

A write whose `COMMIT` reached the server but whose reply was lost (a dropped connection)
fails although it happened. The engine is built for that: its next write carries the old
version and fails with `VERSION_CONFLICT`, and recovery reads what was stored. The
`FaultyOperationStore` of `crypto-aio/testing` simulates it (`timing: 'after'`).

### Claims: `FOR UPDATE SKIP LOCKED`

`claimDue` claims with one statement: a CTE selects the due, unfinished, unclaimed Operations
of the namespace in `(next_check_at, created_at, seq)` order with `LIMIT` and `FOR UPDATE SKIP
LOCKED`, and an `UPDATE` claims them. `SKIP LOCKED` passes over rows that another
`claimDue` is claiming at that moment, so concurrent workers take disjoint sets without
waiting for each other. A row another worker claimed and committed in the meantime is
checked again on its new version, and its fresh claim excludes it. A second statement in the
same transaction reads the claimed records back, with their Attempts.

The partial index `operations_due` covers only rows with `next_check_at` set and a state
outside `TERMINAL_STATES`, so the claim query never scans finished Operations, however many
accumulate. The planner uses a partial index only when the query names the same states, so
the query writes `TERMINAL_STATES` out as literals, and a test checks that `schema.sql` lists
the same ones.

`seq` (an identity column, the insertion order) breaks ties between equal `created_at`
values, as insertion order does in the memory store. `list` and `purge` order by
`(created_at, seq)` too.

### Monotonic tokens and fencing

- **Claim tokens** come from the sequence `claim_tokens`. A sequence never hands out a value
  twice, even to a transaction that rolls back, so tokens increase strictly across the whole
  store. A takeover claims a row only after the earlier claim committed, so it always draws a
  larger token. A fenced write compares the stored token with the caller's, under the row
  lock.
- **Lease tokens** increase per key: a lease row is never deleted. `acquire` is one `INSERT …
  ON CONFLICT (key) DO UPDATE … WHERE` the lease is released or expired, which sets `token =
  token + 1`. Concurrent acquirers of a key queue on its row and see the winner's lease, so
  exactly one wins. `release` clears the owner but keeps the row and its token, so the next
  acquisition continues from it; with a deleted row, the key would start again at 1.
- **Sequence fences** are lease tokens: the engine writes a nonce sequence with the token of
  the lease on the same key, and `put` refuses a lower one with `FENCING`.

### Records, absent fields and `undefined`

A NULL column is an absent field: a read leaves its key out. No field of an
`OperationRecord` may hold `null`, so nothing is lost. In a patch, an `undefined` value writes
nothing (the stored value stays), and `clear` writes NULL, after the values. Patches are
validated before any statement runs, from one read of their own keys (so a getter or a Proxy
cannot show one key to the check and another to the write): a key outside
`OPERATION_PATCH_KEYS`, or a `clear` that is not an array of `CLEARABLE_FIELDS`, refuses the
whole call with `INVALID_TRANSITION`.

`create` refuses the store-owned fields (`claim`, `version`, `createdAt`, `updatedAt`). A
top-level key the schema has no column for, such as a field of a newer record format, goes
into the `extra` column as one tagged JSON object, so a record never loses a field it was
created with.

### Observations are replaced whole

An observation is one row: `record` holds the whole observation (without its version) as
tagged JSON, and `tx_hash` is copied out for `findByRef`. `putObservation` overwrites
`record`; it never merges with the old one. JSON leaves out a key whose value is
`undefined`, so a field the core cleared, such as a stale `reason`, `failure`, `blockHash` or
`blockHeight`, reads back `undefined`, never `null`.

Observations are keyed by Attempt id alone, as the port keys them (`getObservation` and
`putObservation` take no namespace). `findByRef` by tx hash joins an observation to its
Attempt in the namespace, so that an Operation of another namespace with the same id is never
returned.

### JSON: bigints, bytes and text

Nested values are stored as the exact text `stringifyTagged` writes: a bigint becomes
`{"$bigint":"…"}` and a `Uint8Array` `{"$bytes":"…"}`, and `parseTagged` reads them back, so
an ordering's bigints beyond 2^53 and an unsigned transaction's signing payloads come back
exact and with their types. The columns are `text`, not `jsonb`: `jsonb` reorders keys and
refuses the escape `\u0000`, which any string can carry, and nothing here queries inside
them.

Scalars keep their JavaScript types: times are `double precision`, which holds every finite
JavaScript number exactly (a `bigint` column would refuse a fraction), and nonce values are
`numeric`, because an EVM nonce is a u64, beyond `bigint`'s signed 64 bits. They cross the
wire as decimal text, never as a JavaScript number.

Plain `text` columns hold strings as they are, with two exceptions: Postgres refuses U+0000,
and the driver would turn a lone surrogate (half of a UTF-16 pair) into U+FFFD, so that two
different idempotency keys, `'k\uD800'` and `'k\uDC00'`, would become one. The store refuses
both before the statement runs, with `PostgresStoreError` and SQLSTATE `22021`, rather than
store a different key. JSON text never holds either, since `stringifyTagged` escapes them.

### The `format` column

`format` holds the record format the Operation was created in (`OPERATION_FORMAT`). It is
written once, by `create`, and never updated, and it is NULL for a record of 0.1.0, which has
none (format 1). The store never interprets it: the core reads a record of a format it knows
and refuses a newer one (`RECORD_FORMAT_UNSUPPORTED`). As a column, it also answers an
upgrade question directly: `SELECT format, count(*) FROM operations GROUP BY format`.

### Namespaces

Operations and Attempts are keyed by namespace, and every Operation query names one, so
`claimDue`, `list` and `purge` never cross namespaces, even between Operations with the same
id. Lease, sequence and cursor keys already embed the namespace (the core builds them), so
those tables need no column for it. One schema can hold many namespaces; give a tenant its
own schema (`createPostgresStores({ schema })`) to separate its data at the database level.

### Time

The ports leave the clock to the store, except `claimDue`, which takes the worker's `now`.
This store reads one clock for `createdAt`, `updatedAt` and lease expiry: pass the
container's clock (default `Date.now`), as the memory stores take it. The engine compares an
Operation's `createdAt` with its own clock, so both must keep the same time. Every time is
computed in JavaScript and passed to SQL as a parameter; the database clock is never read,
which also lets the contract suites move this store's time with a fake clock.

With several hosts, keep their clocks synchronized (NTP). A lease or claim judged by a fast
clock can end early; another worker may then take it over, and the fencing token, not the
expiry, is what stops the stale holder.

### Purge

`purge(filter)` removes what `list(filter)` would return, at most `limit` records and the
oldest first, in one statement, so all or nothing: a CTE locks the matching Operations,
another deletes their observations, and a third deletes the Operations, whose Attempts go
with them (`ON DELETE CASCADE`), freeing their idempotency keys. It returns how many
Operations it removed. The core never calls it; retention is your decision, for example:

```ts
await stores.operations.purge?.({ namespace: 'payments', states: ['final'], limit: 1_000 });
```

### Errors and what they leave out

The refusals the ports define are `StateError`s with their codes: `VERSION_CONFLICT`,
`FENCING`, `INVALID_TRANSITION` and `NOT_FOUND`. Their messages name an Operation or Attempt
id, which is operational, and never a store key, an idempotency key or an address: sequence
and lease keys embed wallet addresses, and error messages reach logs.

Every other database error is rethrown as `PostgresStoreError` with its SQLSTATE and the
table, column and constraint it names, but without the driver's error: Postgres puts the
failing row's values in `detail` (a not-null violation lists every column, idempotency key
and address included), and a data exception (SQLSTATE class 22) quotes the value in its
message.

## Data classification and encryption

`DATA_CLASSIFICATION` classifies every field the core stores. This store keeps each class in
its own columns, so that you can encrypt the sensitive ones:

| Class | Columns |
| --- | --- |
| `sensitive` | `operations`: `idempotency_key`, `context`, `intent`, `unsigned`, `reservation`, `signer_tickets`, `partial_signatures`, `error`, `from_address` (a copy of `intent.from`), `extra` (unclassified, so treat it as sensitive); `attempts.record` (its `ordering`, `fee` and `unsigned`); `observations.record` (its `reason`) |
| `sensitive-until-broadcast` | `attempts.record` (its `raw` and `ref`) and `attempts.ref_id` |
| `operational` | everything else: ids, `format`, `namespace`, `intent_hash`, `kind`, `state`, `outcome`, `active_attempt_id`, `ambiguous`, versions, claims, times, `next_check_at`, `tx_hash`; `chain` and `network` (copies from `context`, naming no wallet) |
| (keys) | `leases.key`, `sequences.key` and `cursors.key` embed wallet addresses |

To encrypt at rest field by field, seal each sensitive value in the application before it is
written (for example AES-256-GCM, with a data key wrapped by your KMS) and store the
ciphertext in a `bytea` column. Columns used for lookups (`idempotency_key`, `from_address`,
`ref_id` and the lease, sequence and cursor keys) cannot be sealed with a random nonce and
still be found: store a keyed hash (HMAC-SHA-256, under its own key) as a blind index next to
the ciphertext, and look up by it. An Attempt's `raw` bytes and `ref` are public once
broadcast, but before that they reveal pending treasury activity, so seal `attempts.record`
whole. Prefer sealing in the application to `pgcrypto`, which would send the key to the
server inside your SQL.

## Operating it

- **Primary only.** `findByRef` must see every `appendAttempt` another process committed
  before it, so never point the pool at a read replica.
- **Pool size.** Each store call holds one connection for one statement or one short
  transaction. Size the pool for your workers' concurrency.
- **Timeouts.** A transaction never waits on anything but its own statements, but a stuck
  client holding a row lock would block that Operation. Consider `idle_in_transaction_session_timeout`
  and `lock_timeout` on the role.
- **Migrations.** `migrate` is idempotent and safe to run at every start; with a migration
  tool, run `schema.sql` there instead. The tables are the store's format: a change to them is
  a migration of your own, apart from the record `format`, which the core manages.
- **Retention.** Finished Operations stay until you `purge` them.
