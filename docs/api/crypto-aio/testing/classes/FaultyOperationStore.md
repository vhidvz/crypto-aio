[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FaultyOperationStore

# Class: FaultyOperationStore

Defined in: [src/testing/faulty-store.ts:38](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L38)

Wraps a store and throws `CrashError` at chosen write boundaries (one-shot faults).

## Implements

- [`OperationStore`](../../interfaces/OperationStore.md)

## Constructors

<a id="constructor"></a>

### Constructor

> **new FaultyOperationStore**(`inner`): `FaultyOperationStore`

Defined in: [src/testing/faulty-store.ts:44](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L44)

#### Parameters

##### inner

[`OperationStore`](../../interfaces/OperationStore.md)

#### Returns

`FaultyOperationStore`

## Properties

<a id="purge"></a>

### purge?

> `readonly` `optional` **purge?**: (`filter`) => `Promise`\<`number`\>

Defined in: [src/testing/faulty-store.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L42)

The inner store's `purge`, when it has one.

#### Parameters

##### filter

[`OperationFilter`](../../interfaces/OperationFilter.md)

#### Returns

`Promise`\<`number`\>

#### Implementation of

[`OperationStore`](../../interfaces/OperationStore.md).[`purge`](../../interfaces/OperationStore.md#purge)

## Methods

<a id="appendattempt"></a>

### appendAttempt()

> **appendAttempt**(`namespace`, `id`, `attempt`, `patch`, `expectedVersion`, `fence?`): `Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md)\>

Defined in: [src/testing/faulty-store.ts:81](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L81)

Appends `attempt` after the earlier ones and applies `patch`, in one atomic write that
bumps the version and makes `attempt` the `activeAttemptId`. Checked and fenced as
`update`; a duplicate attempt id fails with `INVALID_TRANSITION`.

#### Parameters

##### namespace

`string`

##### id

`string`

##### attempt

[`AttemptRecord`](../../interfaces/AttemptRecord.md)

##### patch

[`OperationPatch`](../../interfaces/OperationPatch.md)

##### expectedVersion

`number`

##### fence?

[`Fence`](../../interfaces/Fence.md)

#### Returns

`Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md)\>

#### Implementation of

[`OperationStore`](../../interfaces/OperationStore.md).[`appendAttempt`](../../interfaces/OperationStore.md#appendattempt)

***

<a id="claimdue"></a>

### claimDue()

> **claimDue**(`namespace`, `workerId`, `now`, `leaseMs`, `limit`): `Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md)[]\>

Defined in: [src/testing/faulty-store.ts:107](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L107)

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

`Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md)[]\>

#### Implementation of

[`OperationStore`](../../interfaces/OperationStore.md).[`claimDue`](../../interfaces/OperationStore.md#claimdue)

***

<a id="crashon"></a>

### crashOn()

> **crashOn**(`fault`): `void`

Defined in: [src/testing/faulty-store.ts:49](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L49)

#### Parameters

##### fault

[`FaultPoint`](../interfaces/FaultPoint.md)

#### Returns

`void`

***

<a id="create"></a>

### create()

> **create**(`operation`): `Promise`\<[`CreateResult`](../../interfaces/CreateResult.md)\>

Defined in: [src/testing/faulty-store.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L53)

Stores `operation` unless its `(namespace, idempotencyKey)` is taken, in which case it
returns the stored record (`created: false`). The new record has version 1. Refuses
with `INVALID_TRANSITION`, storing nothing, an input carrying a store-owned field
(`version`, `createdAt`, `updatedAt`, `claim`) or an id another Operation of the
namespace holds.

#### Parameters

##### operation

[`NewOperation`](../../type-aliases/NewOperation.md)

#### Returns

`Promise`\<[`CreateResult`](../../interfaces/CreateResult.md)\>

#### Implementation of

[`OperationStore`](../../interfaces/OperationStore.md).[`create`](../../interfaces/OperationStore.md#create)

***

<a id="findbyref"></a>

### findByRef()

> **findByRef**(`namespace`, `ref`): `Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md) \| `null`\>

Defined in: [src/testing/faulty-store.ts:65](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L65)

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

##### ref

`string`

#### Returns

`Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md) \| `null`\>

#### Implementation of

[`OperationStore`](../../interfaces/OperationStore.md).[`findByRef`](../../interfaces/OperationStore.md#findbyref)

***

<a id="get"></a>

### get()

> **get**(`namespace`, `id`): `Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md) \| `null`\>

Defined in: [src/testing/faulty-store.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L57)

The Operation with this id in the namespace, or `null`.

#### Parameters

##### namespace

`string`

##### id

`string`

#### Returns

`Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md) \| `null`\>

#### Implementation of

[`OperationStore`](../../interfaces/OperationStore.md).[`get`](../../interfaces/OperationStore.md#get)

***

<a id="getbykey"></a>

### getByKey()

> **getByKey**(`namespace`, `key`): `Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md) \| `null`\>

Defined in: [src/testing/faulty-store.ts:61](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L61)

The Operation holding this idempotency key in the namespace, or `null`.

#### Parameters

##### namespace

`string`

##### key

`string`

#### Returns

`Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md) \| `null`\>

#### Implementation of

[`OperationStore`](../../interfaces/OperationStore.md).[`getByKey`](../../interfaces/OperationStore.md#getbykey)

***

<a id="getobservation"></a>

### getObservation()

> **getObservation**(`attemptId`): `Promise`\<[`AttemptObservation`](../../interfaces/AttemptObservation.md) \| `null`\>

Defined in: [src/testing/faulty-store.ts:94](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L94)

The latest observation of the Attempt, or `null`.

#### Parameters

##### attemptId

`string`

#### Returns

`Promise`\<[`AttemptObservation`](../../interfaces/AttemptObservation.md) \| `null`\>

#### Implementation of

[`OperationStore`](../../interfaces/OperationStore.md).[`getObservation`](../../interfaces/OperationStore.md#getobservation)

***

<a id="list"></a>

### list()

> **list**(`filter`): `Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md)[]\>

Defined in: [src/testing/faulty-store.ts:121](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L121)

The Operations `filter` matches, in creation order, at most `filter.limit` of them.

#### Parameters

##### filter

[`OperationFilter`](../../interfaces/OperationFilter.md)

#### Returns

`Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md)[]\>

#### Implementation of

[`OperationStore`](../../interfaces/OperationStore.md).[`list`](../../interfaces/OperationStore.md#list)

***

<a id="putobservation"></a>

### putObservation()

> **putObservation**(`observation`, `expectedVersion`): `Promise`\<[`AttemptObservation`](../../interfaces/AttemptObservation.md)\>

Defined in: [src/testing/faulty-store.ts:98](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L98)

Stores `observation` as the whole new record, version-checked. An optional field left
out of it or set to `undefined` (a cleared `reason`, `blockHash` or `blockHeight`)
reads back `undefined` (never `null`) afterwards. A store must replace the record, never
merge fields into the old one. The monitor relies on this to clear stale values.
`expectedVersion` `null` creates the first observation (version 1) and fails with
`VERSION_CONFLICT` if one exists; otherwise it must be the stored version. It never
changes the Operation's version.

#### Parameters

##### observation

`Omit`\<[`AttemptObservation`](../../interfaces/AttemptObservation.md), `"version"`\>

##### expectedVersion

`number` \| `null`

#### Returns

`Promise`\<[`AttemptObservation`](../../interfaces/AttemptObservation.md)\>

#### Implementation of

[`OperationStore`](../../interfaces/OperationStore.md).[`putObservation`](../../interfaces/OperationStore.md#putobservation)

***

<a id="releaseclaim"></a>

### releaseClaim()

> **releaseClaim**(`namespace`, `id`, `fence`): `Promise`\<`void`\>

Defined in: [src/testing/faulty-store.ts:117](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L117)

Removes the claim `fence` holds; a claim taken over since fails with `FENCING`.

#### Parameters

##### namespace

`string`

##### id

`string`

##### fence

[`Fence`](../../interfaces/Fence.md)

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`OperationStore`](../../interfaces/OperationStore.md).[`releaseClaim`](../../interfaces/OperationStore.md#releaseclaim)

***

<a id="update"></a>

### update()

> **update**(`namespace`, `id`, `patch`, `expectedVersion`, `fence?`): `Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md)\>

Defined in: [src/testing/faulty-store.ts:69](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L69)

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

[`OperationPatch`](../../interfaces/OperationPatch.md)

##### expectedVersion

`number`

##### fence?

[`Fence`](../../interfaces/Fence.md)

#### Returns

`Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md)\>

#### Implementation of

[`OperationStore`](../../interfaces/OperationStore.md).[`update`](../../interfaces/OperationStore.md#update)
