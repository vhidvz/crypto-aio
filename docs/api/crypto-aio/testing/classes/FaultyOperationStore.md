[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FaultyOperationStore

# Class: FaultyOperationStore

Defined in: [src/testing/faulty-store.ts:36](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L36)

Wraps a store and throws `CrashError` at chosen write boundaries (one-shot faults).

## Implements

- [`OperationStore`](../../interfaces/OperationStore.md)

## Constructors

<a id="constructor"></a>

### Constructor

> **new FaultyOperationStore**(`inner`): `FaultyOperationStore`

Defined in: [src/testing/faulty-store.ts:39](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L39)

#### Parameters

##### inner

[`OperationStore`](../../interfaces/OperationStore.md)

#### Returns

`FaultyOperationStore`

## Methods

<a id="appendattempt"></a>

### appendAttempt()

> **appendAttempt**(`namespace`, `id`, `attempt`, `patch`, `expectedVersion`, `fence?`): `Promise`\<[`OperationRecord`](../../interfaces/OperationRecord.md)\>

Defined in: [src/testing/faulty-store.ts:73](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L73)

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

Defined in: [src/testing/faulty-store.ts:99](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L99)

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

Defined in: [src/testing/faulty-store.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L41)

#### Parameters

##### fault

[`FaultPoint`](../interfaces/FaultPoint.md)

#### Returns

`void`

***

<a id="create"></a>

### create()

> **create**(`operation`): `Promise`\<[`CreateResult`](../../interfaces/CreateResult.md)\>

Defined in: [src/testing/faulty-store.ts:45](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L45)

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

Defined in: [src/testing/faulty-store.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L57)

Finds by an Attempt ref id or by an observed canonical tx hash. The engine's
AttemptRef guard, which refuses an Attempt whose ref another Operation of the
namespace holds, relies on this read being read-your-writes consistent across every
process that shares the store: it must see any `appendAttempt` that another store
instance committed before it was called (no read replica, no eventually consistent
index).

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

Defined in: [src/testing/faulty-store.ts:49](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L49)

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

Defined in: [src/testing/faulty-store.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L53)

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

Defined in: [src/testing/faulty-store.ts:86](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L86)

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

Defined in: [src/testing/faulty-store.ts:113](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L113)

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

Defined in: [src/testing/faulty-store.ts:90](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L90)

Stores `observation` as the whole new record, version-checked. An optional field left
out of it or set to `undefined` (a cleared `reason`, `blockHash` or `blockHeight`)
reads back `undefined` (never `null`) afterwards. A store must replace the record, never
merge fields into the old one. The monitor relies on this to clear stale values.

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

Defined in: [src/testing/faulty-store.ts:109](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L109)

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

Defined in: [src/testing/faulty-store.ts:61](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/faulty-store.ts#L61)

Compare-and-set on `expectedVersion`, optionally fenced. Every successful update bumps
version, even when the patch changes no field (the engine fences stale writers
with such a no-effect update).

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
