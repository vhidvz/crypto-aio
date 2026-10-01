[crypto-aio](../../index.md) / [crypto-aio](../index.md) / MemoryCursorStore

# Class: MemoryCursorStore

Defined in: [src/core/store/memory.ts:87](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L87)

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

Defined in: [src/core/store/memory.ts:90](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L90)

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

Defined in: [src/core/store/memory.ts:95](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/memory.ts#L95)

Returns the new version.

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
