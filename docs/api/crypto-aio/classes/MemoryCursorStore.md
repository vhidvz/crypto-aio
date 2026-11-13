[crypto-aio](../../index.md) / [crypto-aio](../index.md) / MemoryCursorStore

# Class: MemoryCursorStore

Defined in: [src/core/store/memory.ts:90](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L90)

A `CursorStore` in this process's memory: for tests and one-process use only.

## Implements

- [`CursorStore`](../interfaces/CursorStore.md)

## Constructors

<a id="constructor"></a>

### Constructor

> **new MemoryCursorStore**(): `MemoryCursorStore`

#### Returns

`MemoryCursorStore`

## Methods

<a id="get"></a>

### get()

> **get**(`key`): `Promise`\<[`StoredCursor`](../interfaces/StoredCursor.md) \| `null`\>

Defined in: [src/core/store/memory.ts:93](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L93)

The stored cursor with its version, or `null` for an unknown key.

#### Parameters

##### key

`string`

#### Returns

`Promise`\<[`StoredCursor`](../interfaces/StoredCursor.md) \| `null`\>

#### Implementation of

[`CursorStore`](../interfaces/CursorStore.md).[`get`](../interfaces/CursorStore.md#get)

***

<a id="put"></a>

### put()

> **put**(`key`, `cursor`, `expectedVersion`): `Promise`\<`number`\>

Defined in: [src/core/store/memory.ts:98](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L98)

Compare-and-set, as `SequenceStore.put`: `expectedVersion` `null` creates the key
(version 1) and fails with `VERSION_CONFLICT` if it exists. Returns the new version.

#### Parameters

##### key

`string`

##### cursor

[`ScanCursor`](../interfaces/ScanCursor.md)

##### expectedVersion

`number` \| `null`

#### Returns

`Promise`\<`number`\>

#### Implementation of

[`CursorStore`](../interfaces/CursorStore.md).[`put`](../interfaces/CursorStore.md#put)
