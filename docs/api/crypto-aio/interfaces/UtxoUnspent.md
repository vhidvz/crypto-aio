[crypto-aio](../../index.md) / [crypto-aio](../index.md) / UtxoUnspent

# Interface: UtxoUnspent

Defined in: [src/adapters/utxo/types.ts:73](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L73)

An unspent output of an address, as `ext.utxo.listUnspent` reports it.

## Properties

<a id="blockheight"></a>

### blockHeight?

> `readonly` `optional` **blockHeight?**: `bigint`

Defined in: [src/adapters/utxo/types.ts:80](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L80)

***

<a id="confirmed"></a>

### confirmed

> `readonly` **confirmed**: `boolean`

Defined in: [src/adapters/utxo/types.ts:79](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L79)

***

<a id="outpoint"></a>

### outpoint

> `readonly` **outpoint**: `string`

Defined in: [src/adapters/utxo/types.ts:75](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L75)

`txid:vout`, the reservation key of this output.

***

<a id="txid"></a>

### txid

> `readonly` **txid**: `string`

Defined in: [src/adapters/utxo/types.ts:76](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L76)

***

<a id="value"></a>

### value

> `readonly` **value**: `bigint`

Defined in: [src/adapters/utxo/types.ts:78](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L78)

***

<a id="vout"></a>

### vout

> `readonly` **vout**: `number`

Defined in: [src/adapters/utxo/types.ts:77](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L77)
