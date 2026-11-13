[crypto-aio](../../index.md) / [crypto-aio](../index.md) / SequenceStore

# Interface: SequenceStore

Defined in: [src/core/store/types.ts:481](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L481)

Nonce state per sending address. Values keep their types exactly (nonces past 2^64),
returned states are copies, and a refusal leaves the stored state unchanged and never
names the key, which embeds a wallet address.

## Methods

<a id="get"></a>

### get()

> **get**(`key`): `Promise`\<[`SequenceState`](SequenceState.md) \| `null`\>

Defined in: [src/core/store/types.ts:483](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L483)

The stored state, or `null` for an unknown key.

#### Parameters

##### key

`string`

#### Returns

`Promise`\<[`SequenceState`](SequenceState.md) \| `null`\>

***

<a id="put"></a>

### put()

> **put**(`key`, `state`, `expectedVersion`): `Promise`\<`void`\>

Defined in: [src/core/store/types.ts:489](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L489)

Compare-and-set: `expectedVersion` `null` creates the key (version 1) and fails with
`VERSION_CONFLICT` if it exists; otherwise it must be the stored version. Rejects on
version mismatch (`VERSION_CONFLICT`) or when `fence` < stored fence (`FENCING`).

#### Parameters

##### key

`string`

##### state

`Omit`\<[`SequenceState`](SequenceState.md), `"version"`\>

##### expectedVersion

`number` \| `null`

#### Returns

`Promise`\<`void`\>
