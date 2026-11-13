[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OperationStore

# Interface: OperationStore

Defined in: [src/core/store/types.ts:343](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L343)

Durable Operation storage. Required guarantees (verified by the contract suite),
binding on every implementation (memory, Redis, Postgres, ...):
- `create` is create-if-absent on `(namespace, idempotencyKey)`: a second `create`
  for an existing key returns the stored record unchanged, regardless of
  `intentHash` — this store never performs the idempotency-conflict check itself;
  the calling engine does.
- `update`/`appendAttempt` are version-checked (compare-and-set on
  `expectedVersion`) and optionally fenced by a claim token. Both are restricted to
  the same runtime patch whitelist (`OPERATION_PATCH_KEYS`), and `clear` may only
  name `CLEARABLE_FIELDS`; any other key anywhere in the patch rejects the whole
  call with `INVALID_TRANSITION` before any mutation. An explicit `undefined` value
  for a writable field is a no-op (the stored value survives); only `clear` removes
  a field.
- `appendAttempt` is atomic with its accompanying patch, never rewrites a
  previously stored `AttemptRecord`, and rejects a duplicate attempt id. Attempt ids
  are globally unique across every Operation and namespace: the core makes each one
  random, and observations are keyed by attempt id alone, so a store may also refuse
  (`INVALID_TRANSITION`) an id that another Operation holds.
- Time: `createdAt`, `updatedAt` and claim expiry are stamped with the store's clock,
  which the core compares with its own (`claimDue` gets the worker's `now`). Give a
  durable store the container's clock, or a wall clock the processes share, as the
  memory stores take theirs.
- `claimDue` and `list` are scoped by namespace: they never return a record of another
  namespace, even one with the same id.
- `claimDue` returns only non-terminal operations with `nextCheckAt` set and `<=
  now`, ordered by `(nextCheckAt, createdAt)` with a stable tie-break for equal
  values, and returns `[]` for `limit <= 0`. A claimed Operation is excluded until
  its `claim.until <= now`; then another worker may take it over. Claim tokens are
  strictly increasing per store; fenced writes are rejected after a takeover.
- `list` returns matches in creation order.
- `ClearableField` is restricted on purpose: `clear` can never remove store-owned or
  identity fields (`attempts`, `claim`, `version`, `id`, ...) or `state`. An
  implementation reads the caller's `clear` list once, so the list it validates is
  the list it applies.
- A key set to `undefined`, in an observation or a patch, is never persisted as a value
  such as `null`. In a patch, the stored field keeps its value. In an
  observation, which replaces the whole record, the field reads back `undefined` (never
  `null`).
- Every record and observation returned is a copy: mutating it, or the caller's input
  after a write, never changes what is stored. Values keep their types (`bigint`,
  `Uint8Array`), and orderings are kept whole.
- A refusal (`VERSION_CONFLICT`, `FENCING`, `INVALID_TRANSITION`) leaves the stored
  record unchanged, and no error names an idempotency key or an address.

## Methods

<a id="appendattempt"></a>

### appendAttempt()

> **appendAttempt**(`namespace`, `id`, `attempt`, `patch`, `expectedVersion`, `fence?`): `Promise`\<[`OperationRecord`](OperationRecord.md)\>

Defined in: [src/core/store/types.ts:388](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L388)

Appends `attempt` after the earlier ones and applies `patch`, in one atomic write that
bumps the version and makes `attempt` the `activeAttemptId`. Checked and fenced as
`update`; a duplicate attempt id fails with `INVALID_TRANSITION`.

#### Parameters

##### namespace

`string`

##### id

`string`

##### attempt

[`AttemptRecord`](AttemptRecord.md)

##### patch

[`OperationPatch`](OperationPatch.md)

##### expectedVersion

`number`

##### fence?

[`Fence`](Fence.md)

#### Returns

`Promise`\<[`OperationRecord`](OperationRecord.md)\>

***

<a id="claimdue"></a>

### claimDue()

> **claimDue**(`namespace`, `workerId`, `now`, `leaseMs`, `limit`): `Promise`\<[`OperationRecord`](OperationRecord.md)[]\>

Defined in: [src/core/store/types.ts:412](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L412)

Claims non-terminal operations whose `nextCheckAt` is set and <= now (unscheduled ones are never due).

#### Parameters

##### namespace

`string`

##### workerId

`string`

##### now

`number`

##### leaseMs

`number`

##### limit

`number`

#### Returns

`Promise`\<[`OperationRecord`](OperationRecord.md)[]\>

***

<a id="create"></a>

### create()

> **create**(`operation`): `Promise`\<[`CreateResult`](CreateResult.md)\>

Defined in: [src/core/store/types.ts:351](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L351)

Stores `operation` unless its `(namespace, idempotencyKey)` is taken, in which case it
returns the stored record (`created: false`). The new record has version 1. Refuses
with `INVALID_TRANSITION`, storing nothing, an input carrying a store-owned field
(`version`, `createdAt`, `updatedAt`, `claim`) or an id another Operation of the
namespace holds.

#### Parameters

##### operation

[`NewOperation`](../type-aliases/NewOperation.md)

#### Returns

`Promise`\<[`CreateResult`](CreateResult.md)\>

***

<a id="findbyref"></a>

### findByRef()

> **findByRef**(`namespace`, `refOrTxHash`): `Promise`\<[`OperationRecord`](OperationRecord.md) \| `null`\>

Defined in: [src/core/store/types.ts:368](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L368)

Finds by an Attempt ref id or by an observed canonical tx hash. The engine's
AttemptRef guard, which refuses an Attempt whose ref another Operation of the
namespace holds, relies on this read being read-your-writes consistent across every
process that shares the store: it must see any `appendAttempt` that another store
instance committed before it was called (no read replica, no eventually consistent
index).

At most one Operation of a namespace holds a ref: that guard refuses an Attempt whose
ref another Operation holds. Should several hold it anyway (records written outside
the core), a store may return any one of them.

#### Parameters

##### namespace

`string`

##### refOrTxHash

`string`

#### Returns

`Promise`\<[`OperationRecord`](OperationRecord.md) \| `null`\>

***

<a id="get"></a>

### get()

> **get**(`namespace`, `id`): `Promise`\<[`OperationRecord`](OperationRecord.md) \| `null`\>

Defined in: [src/core/store/types.ts:353](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L353)

The Operation with this id in the namespace, or `null`.

#### Parameters

##### namespace

`string`

##### id

`string`

#### Returns

`Promise`\<[`OperationRecord`](OperationRecord.md) \| `null`\>

***

<a id="getbykey"></a>

### getByKey()

> **getByKey**(`namespace`, `idempotencyKey`): `Promise`\<[`OperationRecord`](OperationRecord.md) \| `null`\>

Defined in: [src/core/store/types.ts:355](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L355)

The Operation holding this idempotency key in the namespace, or `null`.

#### Parameters

##### namespace

`string`

##### idempotencyKey

`string`

#### Returns

`Promise`\<[`OperationRecord`](OperationRecord.md) \| `null`\>

***

<a id="getobservation"></a>

### getObservation()

> **getObservation**(`attemptId`): `Promise`\<[`AttemptObservation`](AttemptObservation.md) \| `null`\>

Defined in: [src/core/store/types.ts:397](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L397)

The latest observation of the Attempt, or `null`.

#### Parameters

##### attemptId

`string`

#### Returns

`Promise`\<[`AttemptObservation`](AttemptObservation.md) \| `null`\>

***

<a id="list"></a>

### list()

> **list**(`filter`): `Promise`\<[`OperationRecord`](OperationRecord.md)[]\>

Defined in: [src/core/store/types.ts:422](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L422)

The Operations `filter` matches, in creation order, at most `filter.limit` of them.

#### Parameters

##### filter

[`OperationFilter`](OperationFilter.md)

#### Returns

`Promise`\<[`OperationRecord`](OperationRecord.md)[]\>

***

<a id="purge"></a>

### purge()?

> `optional` **purge**(`filter`): `Promise`\<`number`\>

Defined in: [src/core/store/types.ts:430](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L430)

Optional: deletes what `filter` matches, as `list` reads it (the oldest first, at most
`limit`), with their Attempts' observations and their idempotency keys, and returns
how many it deleted. The core never calls it. It deletes live Operations too, and a
purged key creates a new Operation that pays again: purge only terminal Operations
older than any time a caller could still repeat their key.

#### Parameters

##### filter

[`OperationFilter`](OperationFilter.md)

#### Returns

`Promise`\<`number`\>

***

<a id="putobservation"></a>

### putObservation()

> **putObservation**(`observation`, `expectedVersion`): `Promise`\<[`AttemptObservation`](AttemptObservation.md)\>

Defined in: [src/core/store/types.ts:407](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L407)

Stores `observation` as the whole new record, version-checked. An optional field left
out of it or set to `undefined` (a cleared `reason`, `blockHash` or `blockHeight`)
reads back `undefined` (never `null`) afterwards. A store must replace the record, never
merge fields into the old one. The monitor relies on this to clear stale values.
`expectedVersion` `null` creates the first observation (version 1) and fails with
`VERSION_CONFLICT` if one exists; otherwise it must be the stored version. It never
changes the Operation's version.

#### Parameters

##### observation

`Omit`\<[`AttemptObservation`](AttemptObservation.md), `"version"`\>

##### expectedVersion

`number` \| `null`

#### Returns

`Promise`\<[`AttemptObservation`](AttemptObservation.md)\>

***

<a id="releaseclaim"></a>

### releaseClaim()

> **releaseClaim**(`namespace`, `id`, `fence`): `Promise`\<`void`\>

Defined in: [src/core/store/types.ts:420](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L420)

Removes the claim `fence` holds; a claim taken over since fails with `FENCING`.

#### Parameters

##### namespace

`string`

##### id

`string`

##### fence

[`Fence`](Fence.md)

#### Returns

`Promise`\<`void`\>

***

<a id="update"></a>

### update()

> **update**(`namespace`, `id`, `patch`, `expectedVersion`, `fence?`): `Promise`\<[`OperationRecord`](OperationRecord.md)\>

Defined in: [src/core/store/types.ts:376](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L376)

Compare-and-set on `expectedVersion`, optionally fenced. Every successful update bumps
version, even when the patch changes no field (the engine fences stale writers
with such a no-effect update). Fails with `NOT_FOUND`, `VERSION_CONFLICT`, `FENCING`, or
`INVALID_TRANSITION` for a patch key outside the whitelist or a `clear` that is not
an array of `CLEARABLE_FIELDS`.

#### Parameters

##### namespace

`string`

##### id

`string`

##### patch

[`OperationPatch`](OperationPatch.md)

##### expectedVersion

`number`

##### fence?

[`Fence`](Fence.md)

#### Returns

`Promise`\<[`OperationRecord`](OperationRecord.md)\>
