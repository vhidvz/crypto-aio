[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AvalancheUnspent

# Interface: AvalancheUnspent

Defined in: [src/adapters/avalanche/types.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L56)

An output an address owns, as `ext.avalanche.listUnspent` reports it.

## Properties

<a id="amount"></a>

### amount

> `readonly` **amount**: `bigint`

Defined in: [src/adapters/avalanche/types.ts:63](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L63)

***

<a id="assetid"></a>

### assetId

> `readonly` **assetId**: `string`

Defined in: [src/adapters/avalanche/types.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L62)

The asset's id (cb58); AVAX is the network's `avaxAssetId`.

***

<a id="locktime"></a>

### locktime

> `readonly` **locktime**: `bigint`

Defined in: [src/adapters/avalanche/types.ts:65](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L65)

Unix seconds before which the output cannot be spent; `0n` for none.

***

<a id="outputindex"></a>

### outputIndex

> `readonly` **outputIndex**: `number`

Defined in: [src/adapters/avalanche/types.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L60)

***

<a id="spendable"></a>

### spendable

> `readonly` **spendable**: `boolean`

Defined in: [src/adapters/avalanche/types.ts:72](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L72)

Whether a transfer from this address may spend it: AVAX in a plain transfer output,
not locked, that this address can sign alone (threshold 1).

***

<a id="threshold"></a>

### threshold

> `readonly` **threshold**: `number`

Defined in: [src/adapters/avalanche/types.ts:67](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L67)

How many of the output's owners must sign.

***

<a id="txid"></a>

### txId

> `readonly` **txId**: `string`

Defined in: [src/adapters/avalanche/types.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L59)

***

<a id="utxoid"></a>

### utxoId

> `readonly` **utxoId**: `string`

Defined in: [src/adapters/avalanche/types.ts:58](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L58)

`txID:outputIndex`, the reservation key of this output.
