[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Broadcaster

# Interface: Broadcaster

Defined in: [src/core/driver/types.ts:173](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L173)

## Methods

<a id="broadcast"></a>

### broadcast()

> **broadcast**(`signed`, `options?`): `Promise`\<[`BroadcastResult`](../type-aliases/BroadcastResult.md)\>

Defined in: [src/core/driver/types.ts:178](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L178)

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
