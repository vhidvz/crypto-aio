[crypto-aio](../../index.md) / [crypto-aio](../index.md) / MemoryOperationStore

# Class: MemoryOperationStore

Defined in: [src/core/store/memory.ts:184](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L184)

An `OperationStore` in this process's memory: for tests and one-process use only. What it
holds is lost when the process ends, so it cannot make a payment crash-safe.

## Implements

- [`OperationStore`](../interfaces/OperationStore.md)

## Constructors

<a id="constructor"></a>

### Constructor

> **new MemoryOperationStore**(`clock?`): `MemoryOperationStore`

Defined in: [src/core/store/memory.ts:190](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L190)

#### Parameters

##### clock?

[`Clock`](../interfaces/Clock.md) = `systemClock`

#### Returns

`MemoryOperationStore`

## Methods

<a id="appendattempt"></a>

### appendAttempt()

> **appendAttempt**(`namespace`, `id`, `attempt`, `patch`, `expectedVersion`, `fence?`): `Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md)\>

Defined in: [src/core/store/memory.ts:278](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L278)

Appends `attempt` after the earlier ones and applies `patch`, in one atomic write that
bumps the version and makes `attempt` the `activeAttemptId`. Checked and fenced as
`update`; a duplicate attempt id fails with `INVALID_TRANSITION`.

#### Parameters

##### namespace

`string`

##### id

`string`

##### attempt

[`AttemptRecord`](../interfaces/AttemptRecord.md)

##### patch

[`OperationPatch`](../interfaces/OperationPatch.md)

##### expectedVersion

`number`

##### fence?

[`Fence`](../interfaces/Fence.md)

#### Returns

`Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md)\>

#### Implementation of

[`OperationStore`](../interfaces/OperationStore.md).[`appendAttempt`](../interfaces/OperationStore.md#appendattempt)

***

<a id="claimdue"></a>

### claimDue()

> **claimDue**(`namespace`, `workerId`, `now`, `leaseMs`, `limit`): `Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md)[]\>

Defined in: [src/core/store/memory.ts:327](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L327)

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

`Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md)[]\>

#### Implementation of

[`OperationStore`](../interfaces/OperationStore.md).[`claimDue`](../interfaces/OperationStore.md#claimdue)

***

<a id="create"></a>

### create()

> **create**(`operation`): `Promise`\<[`CreateResult`](../interfaces/CreateResult.md)\>

Defined in: [src/core/store/memory.ts:192](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L192)

Stores `operation` unless its `(namespace, idempotencyKey)` is taken, in which case it
returns the stored record (`created: false`). The new record has version 1. Refuses
with `INVALID_TRANSITION`, storing nothing, an input carrying a store-owned field
(`version`, `createdAt`, `updatedAt`, `claim`) or an id another Operation of the
namespace holds.

#### Parameters

##### operation

[`NewOperation`](../type-aliases/NewOperation.md)

#### Returns

`Promise`\<[`CreateResult`](../interfaces/CreateResult.md)\>

#### Implementation of

[`OperationStore`](../interfaces/OperationStore.md).[`create`](../interfaces/OperationStore.md#create)

***

<a id="findbyref"></a>

### findByRef()

> **findByRef**(`namespace`, `refOrTxHash`): `Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md) \| `null`\>

Defined in: [src/core/store/memory.ts:241](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L241)

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

`Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md) \| `null`\>

#### Implementation of

[`OperationStore`](../interfaces/OperationStore.md).[`findByRef`](../interfaces/OperationStore.md#findbyref)

***

<a id="get"></a>

### get()

> **get**(`namespace`, `id`): `Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md) \| `null`\>

Defined in: [src/core/store/memory.ts:228](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L228)

The Operation with this id in the namespace, or `null`.

#### Parameters

##### namespace

`string`

##### id

`string`

#### Returns

`Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md) \| `null`\>

#### Implementation of

[`OperationStore`](../interfaces/OperationStore.md).[`get`](../interfaces/OperationStore.md#get)

***

<a id="getbykey"></a>

### getByKey()

> **getByKey**(`namespace`, `idempotencyKey`): `Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md) \| `null`\>

Defined in: [src/core/store/memory.ts:233](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L233)

The Operation holding this idempotency key in the namespace, or `null`.

#### Parameters

##### namespace

`string`

##### idempotencyKey

`string`

#### Returns

`Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md) \| `null`\>

#### Implementation of

[`OperationStore`](../interfaces/OperationStore.md).[`getByKey`](../interfaces/OperationStore.md#getbykey)

***

<a id="getobservation"></a>

### getObservation()

> **getObservation**(`attemptId`): `Promise`\<[`AttemptObservation`](../interfaces/AttemptObservation.md) \| `null`\>

Defined in: [src/core/store/memory.ts:303](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L303)

The latest observation of the Attempt, or `null`.

#### Parameters

##### attemptId

`string`

#### Returns

`Promise`\<[`AttemptObservation`](../interfaces/AttemptObservation.md) \| `null`\>

#### Implementation of

[`OperationStore`](../interfaces/OperationStore.md).[`getObservation`](../interfaces/OperationStore.md#getobservation)

***

<a id="list"></a>

### list()

> **list**(`filter`): `Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md)[]\>

Defined in: [src/core/store/memory.ts:376](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L376)

The Operations `filter` matches, in creation order, at most `filter.limit` of them.

#### Parameters

##### filter

[`OperationFilter`](../interfaces/OperationFilter.md)

#### Returns

`Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md)[]\>

#### Implementation of

[`OperationStore`](../interfaces/OperationStore.md).[`list`](../interfaces/OperationStore.md#list)

***

<a id="purge"></a>

### purge()

> **purge**(`filter`): `Promise`\<`number`\>

Defined in: [src/core/store/memory.ts:385](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L385)

Optional: deletes what `filter` matches, as `list` reads it (the oldest first, at most
`limit`), with their Attempts' observations and their idempotency keys, and returns
how many it deleted. The core never calls it. It deletes live Operations too, and a
purged key creates a new Operation that pays again: purge only terminal Operations
older than any time a caller could still repeat their key.

#### Parameters

##### filter

[`OperationFilter`](../interfaces/OperationFilter.md)

#### Returns

`Promise`\<`number`\>

#### Implementation of

[`OperationStore`](../interfaces/OperationStore.md).[`purge`](../interfaces/OperationStore.md#purge)

***

<a id="putobservation"></a>

### putObservation()

> **putObservation**(`observation`, `expectedVersion`): `Promise`\<[`AttemptObservation`](../interfaces/AttemptObservation.md)\>

Defined in: [src/core/store/memory.ts:308](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L308)

Stores `observation` as the whole new record, version-checked. An optional field left
out of it or set to `undefined` (a cleared `reason`, `blockHash` or `blockHeight`)
reads back `undefined` (never `null`) afterwards. A store must replace the record, never
merge fields into the old one. The monitor relies on this to clear stale values.
`expectedVersion` `null` creates the first observation (version 1) and fails with
`VERSION_CONFLICT` if one exists; otherwise it must be the stored version. It never
changes the Operation's version.

#### Parameters

##### observation

`Omit`\<[`AttemptObservation`](../interfaces/AttemptObservation.md), `"version"`\>

##### expectedVersion

`number` \| `null`

#### Returns

`Promise`\<[`AttemptObservation`](../interfaces/AttemptObservation.md)\>

#### Implementation of

[`OperationStore`](../interfaces/OperationStore.md).[`putObservation`](../interfaces/OperationStore.md#putobservation)

***

<a id="releaseclaim"></a>

### releaseClaim()

> **releaseClaim**(`namespace`, `id`, `fence`): `Promise`\<`void`\>

Defined in: [src/core/store/memory.ts:363](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L363)

Removes the claim `fence` holds; a claim taken over since fails with `FENCING`.

#### Parameters

##### namespace

`string`

##### id

`string`

##### fence

[`Fence`](../interfaces/Fence.md)

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`OperationStore`](../interfaces/OperationStore.md).[`releaseClaim`](../interfaces/OperationStore.md#releaseclaim)

***

<a id="update"></a>

### update()

> **update**(`namespace`, `id`, `patch`, `expectedVersion`, `fence?`): `Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md)\>

Defined in: [src/core/store/memory.ts:265](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L265)

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

[`OperationPatch`](../interfaces/OperationPatch.md)

##### expectedVersion

`number`

##### fence?

[`Fence`](../interfaces/Fence.md)

#### Returns

`Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md)\>

#### Implementation of

[`OperationStore`](../interfaces/OperationStore.md).[`update`](../interfaces/OperationStore.md#update)
