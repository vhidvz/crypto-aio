[crypto-aio](../../index.md) / [crypto-aio](../index.md) / CursorStore

# Interface: CursorStore

Defined in: [src/core/store/types.ts:513](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L513)

Scanner cursors. A refusal leaves the stored cursor unchanged and never names the key,
which can name a watched wallet.

## Methods

<a id="get"></a>

### get()

> **get**(`key`): `Promise`\<[`StoredCursor`](StoredCursor.md) \| `null`\>

Defined in: [src/core/store/types.ts:515](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L515)

The stored cursor with its version, or `null` for an unknown key.

#### Parameters

##### key

`string`

#### Returns

`Promise`\<[`StoredCursor`](StoredCursor.md) \| `null`\>

***

<a id="put"></a>

### put()

> **put**(`key`, `cursor`, `expectedVersion`): `Promise`\<`number`\>

Defined in: [src/core/store/types.ts:520](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L520)

Compare-and-set, as `SequenceStore.put`: `expectedVersion` `null` creates the key
(version 1) and fails with `VERSION_CONFLICT` if it exists. Returns the new version.

#### Parameters

##### key

`string`

##### cursor

[`ScanCursor`](ScanCursor.md)

##### expectedVersion

`number` \| `null`

#### Returns

`Promise`\<`number`\>
