[crypto-aio](../../index.md) / [crypto-aio](../index.md) / CursorStore

# Interface: CursorStore

Defined in: [src/core/store/types.ts:350](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L350)

## Methods

<a id="get"></a>

### get()

> **get**(`key`): `Promise`\<[`StoredCursor`](StoredCursor.md) \| `null`\>

Defined in: [src/core/store/types.ts:351](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L351)

#### Parameters

##### key

`string`

#### Returns

`Promise`\<[`StoredCursor`](StoredCursor.md) \| `null`\>

***

<a id="put"></a>

### put()

> **put**(`key`, `cursor`, `expectedVersion`): `Promise`\<`number`\>

Defined in: [src/core/store/types.ts:353](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L353)

Returns the new version.

#### Parameters

##### key

`string`

##### cursor

[`ScanCursor`](ScanCursor.md)

##### expectedVersion

`number` \| `null`

#### Returns

`Promise`\<`number`\>
