[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OperationStore

# Interface: OperationStore

Defined in: [src/core/store/types.ts:251](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L251)

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

## Methods

<a id="appendattempt"></a>

### appendAttempt()

> **appendAttempt**(`namespace`, `id`, `attempt`, `patch`, `expectedVersion`, `fence?`): `Promise`\<[`OperationRecord`](OperationRecord.md)\>

Defined in: [src/core/store/types.ts:276](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L276)

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

Defined in: [src/core/store/types.ts:296](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L296)

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

Defined in: [src/core/store/types.ts:252](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L252)

#### Parameters

##### operation

[`NewOperation`](../type-aliases/NewOperation.md)

#### Returns

`Promise`\<[`CreateResult`](CreateResult.md)\>

***

<a id="findbyref"></a>

### findByRef()

> **findByRef**(`namespace`, `refOrTxHash`): `Promise`\<[`OperationRecord`](OperationRecord.md) \| `null`\>

Defined in: [src/core/store/types.ts:263](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L263)

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

`Promise`\<[`OperationRecord`](OperationRecord.md) \| `null`\>

***

<a id="get"></a>

### get()

> **get**(`namespace`, `id`): `Promise`\<[`OperationRecord`](OperationRecord.md) \| `null`\>

Defined in: [src/core/store/types.ts:253](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L253)

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

Defined in: [src/core/store/types.ts:254](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L254)

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

Defined in: [src/core/store/types.ts:284](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L284)

#### Parameters

##### attemptId

`string`

#### Returns

`Promise`\<[`AttemptObservation`](AttemptObservation.md) \| `null`\>

***

<a id="list"></a>

### list()

> **list**(`filter`): `Promise`\<[`OperationRecord`](OperationRecord.md)[]\>

Defined in: [src/core/store/types.ts:304](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L304)

#### Parameters

##### filter

[`OperationFilter`](OperationFilter.md)

#### Returns

`Promise`\<[`OperationRecord`](OperationRecord.md)[]\>

***

<a id="purge"></a>

### purge()?

> `optional` **purge**(`filter`): `Promise`\<`number`\>

Defined in: [src/core/store/types.ts:305](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L305)

#### Parameters

##### filter

[`OperationFilter`](OperationFilter.md)

#### Returns

`Promise`\<`number`\>

***

<a id="putobservation"></a>

### putObservation()

> **putObservation**(`observation`, `expectedVersion`): `Promise`\<[`AttemptObservation`](AttemptObservation.md)\>

Defined in: [src/core/store/types.ts:291](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L291)

Stores `observation` as the whole new record, version-checked. An optional field left
out of it or set to `undefined` (a cleared `reason`, `blockHash` or `blockHeight`)
reads back `undefined` (never `null`) afterwards. A store must replace the record, never
merge fields into the old one. The monitor relies on this to clear stale values.

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

Defined in: [src/core/store/types.ts:303](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L303)

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

Defined in: [src/core/store/types.ts:269](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L269)

Compare-and-set on `expectedVersion`, optionally fenced. Every successful update bumps
version, even when the patch changes no field (the engine fences stale writers
with such a no-effect update).

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
