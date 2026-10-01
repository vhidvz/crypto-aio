[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SequenceStore

# Interface: SequenceStore

Defined in: [src/core/store/types.ts:329](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L329)

## Methods

<a id="get"></a>

### get()

> **get**(`key`): `Promise`\<[`SequenceState`](SequenceState.md) \| `null`\>

Defined in: [src/core/store/types.ts:330](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L330)

#### Parameters

##### key

`string`

#### Returns

`Promise`\<[`SequenceState`](SequenceState.md) \| `null`\>

***

<a id="put"></a>

### put()

> **put**(`key`, `state`, `expectedVersion`): `Promise`\<`void`\>

Defined in: [src/core/store/types.ts:332](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L332)

Rejects on version mismatch (`VERSION_CONFLICT`) or when `fence` < stored fence (`FENCING`).

#### Parameters

##### key

`string`

##### state

`Omit`\<[`SequenceState`](SequenceState.md), `"version"`\>

##### expectedVersion

`number` \| `null`

#### Returns

`Promise`\<`void`\>
