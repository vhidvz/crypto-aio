[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AvalancheExt

# Interface: AvalancheExt

Defined in: [src/adapters/avalanche/types.ts:76](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L76)

`bc.ext.avalanche`: the Avalanche family extension.

## Properties

<a id="avalanche"></a>

### avalanche

> `readonly` **avalanche**: `object`

Defined in: [src/adapters/avalanche/types.ts:77](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L77)

#### listUnspent()

> **listUnspent**(`address`): `Promise`\<readonly [`AvalancheUnspent`](AvalancheUnspent.md)[]\>

The outputs an address owns on this chain (the node's UTXO set), largest first.

##### Parameters

###### address

`string`

##### Returns

`Promise`\<readonly [`AvalancheUnspent`](AvalancheUnspent.md)[]\>
