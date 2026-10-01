[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AvalancheExt

# Interface: AvalancheExt

Defined in: [src/adapters/avalanche/types.ts:75](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L75)

`bc.ext.avalanche`: the Avalanche family extension (spec §5.5).

## Properties

<a id="avalanche"></a>

### avalanche

> `readonly` **avalanche**: `object`

Defined in: [src/adapters/avalanche/types.ts:76](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L76)

#### listUnspent()

> **listUnspent**(`address`): `Promise`\<readonly [`AvalancheUnspent`](AvalancheUnspent.md)[]\>

The outputs an address owns on this chain (the node's UTXO set), largest first.

##### Parameters

###### address

`string`

##### Returns

`Promise`\<readonly [`AvalancheUnspent`](AvalancheUnspent.md)[]\>
