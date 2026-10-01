[crypto-aio](../../index.md) / [crypto-aio](../index.md) / MemorySequenceStore

# Class: MemorySequenceStore

Defined in: [src/core/store/memory.ts:63](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L63)

## Implements

- [`SequenceStore`](../interfaces/SequenceStore.md)

## Constructors

<a id="constructor"></a>

### Constructor

> **new MemorySequenceStore**(): `MemorySequenceStore`

#### Returns

`MemorySequenceStore`

## Methods

<a id="get"></a>

### get()

> **get**(`key`): `Promise`\<[`SequenceState`](../interfaces/SequenceState.md) \| `null`\>

Defined in: [src/core/store/memory.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L66)

#### Parameters

##### key

`string`

#### Returns

`Promise`\<[`SequenceState`](../interfaces/SequenceState.md) \| `null`\>

#### Implementation of

[`SequenceStore`](../interfaces/SequenceStore.md).[`get`](../interfaces/SequenceStore.md#get)

***

<a id="put"></a>

### put()

> **put**(`key`, `state`, `expectedVersion`): `Promise`\<`void`\>

Defined in: [src/core/store/memory.ts:71](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L71)

Rejects on version mismatch (`VERSION_CONFLICT`) or when `fence` < stored fence (`FENCING`).

#### Parameters

##### key

`string`

##### state

`Omit`\<[`SequenceState`](../interfaces/SequenceState.md), `"version"`\>

##### expectedVersion

`number` \| `null`

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`SequenceStore`](../interfaces/SequenceStore.md).[`put`](../interfaces/SequenceStore.md#put)
