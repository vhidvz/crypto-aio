[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Broadcaster

# Interface: Broadcaster

Defined in: [src/core/driver/types.ts:171](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L171)

## Methods

<a id="broadcast"></a>

### broadcast()

> **broadcast**(`signed`, `options?`): `Promise`\<[`BroadcastResult`](../type-aliases/BroadcastResult.md)\>

Defined in: [src/core/driver/types.ts:176](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L176)

Throws (ambiguous) on transport failure; returns a classified result otherwise.
`signed.ref.id` is empty for bare broadcasts (`Blockchain.broadcast`); never rely on it.

#### Parameters

##### signed

[`SignedTx`](SignedTx.md)

##### options?

###### fanout?

`number`

###### signal?

`AbortSignal`

#### Returns

`Promise`\<[`BroadcastResult`](../type-aliases/BroadcastResult.md)\>
