[crypto-aio](../../index.md) / [crypto-aio](../index.md) / MemoryOperationStore

# Class: MemoryOperationStore

Defined in: [src/core/store/memory.ts:177](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L177)

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
  are globally unique across every Operation and namespace (observations are keyed
  by attempt id alone).
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

## Implements

- [`OperationStore`](../interfaces/OperationStore.md)

## Constructors

<a id="constructor"></a>

### Constructor

> **new MemoryOperationStore**(`clock?`): `MemoryOperationStore`

Defined in: [src/core/store/memory.ts:183](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L183)

#### Parameters

##### clock?

[`Clock`](../interfaces/Clock.md) = `systemClock`

#### Returns

`MemoryOperationStore`

## Methods

<a id="appendattempt"></a>

### appendAttempt()

> **appendAttempt**(`namespace`, `id`, `attempt`, `patch`, `expectedVersion`, `fence?`): `Promise`\<[`OperationRecord`](../interfaces/OperationRecord.md)\>

Defined in: [src/core/store/memory.ts:271](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L271)

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

Defined in: [src/core/store/memory.ts:320](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L320)

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

Defined in: [src/core/store/memory.ts:185](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L185)

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

Defined in: [src/core/store/memory.ts:234](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L234)

Finds by an Attempt ref id or by an observed canonical tx hash. The engine's
AttemptRef guard, which refuses an Attempt whose ref another Operation of the
namespace holds, relies on this read being read-your-writes consistent across every
process that shares the store: it must see any `appendAttempt` that another store
instance committed before it was called (no read replica, no eventually consistent
index).

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

Defined in: [src/core/store/memory.ts:221](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L221)

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

Defined in: [src/core/store/memory.ts:226](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L226)

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

Defined in: [src/core/store/memory.ts:296](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L296)

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

Defined in: [src/core/store/memory.ts:369](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L369)

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

Defined in: [src/core/store/memory.ts:376](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L376)

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

Defined in: [src/core/store/memory.ts:301](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L301)

Stores `observation` as the whole new record, version-checked. An optional field left
out of it or set to `undefined` (a cleared `reason`, `blockHash` or `blockHeight`)
reads back `undefined` (never `null`) afterwards. A store must replace the record, never
merge fields into the old one. The monitor relies on this to clear stale values.

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

Defined in: [src/core/store/memory.ts:356](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L356)

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

Defined in: [src/core/store/memory.ts:258](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L258)

Compare-and-set on `expectedVersion`, optionally fenced. Every successful update bumps
version, even when the patch changes no field (the engine fences stale writers
with such a no-effect update).

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
