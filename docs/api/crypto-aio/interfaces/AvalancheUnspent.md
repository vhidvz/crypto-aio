[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AvalancheUnspent

# Interface: AvalancheUnspent

Defined in: [src/adapters/avalanche/types.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L55)

An output an address owns, as `ext.avalanche.listUnspent` reports it.

## Properties

<a id="amount"></a>

### amount

> `readonly` **amount**: `bigint`

Defined in: [src/adapters/avalanche/types.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L62)

***

<a id="assetid"></a>

### assetId

> `readonly` **assetId**: `string`

Defined in: [src/adapters/avalanche/types.ts:61](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L61)

The asset's id (cb58); AVAX is the network's `avaxAssetId`.

***

<a id="locktime"></a>

### locktime

> `readonly` **locktime**: `bigint`

Defined in: [src/adapters/avalanche/types.ts:64](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L64)

Unix seconds before which the output cannot be spent; `0n` for none.

***

<a id="outputindex"></a>

### outputIndex

> `readonly` **outputIndex**: `number`

Defined in: [src/adapters/avalanche/types.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L59)

***

<a id="spendable"></a>

### spendable

> `readonly` **spendable**: `boolean`

Defined in: [src/adapters/avalanche/types.ts:71](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L71)

Whether a transfer from this address may spend it: AVAX in a plain transfer output,
not locked, that this address can sign alone (threshold 1).

***

<a id="threshold"></a>

### threshold

> `readonly` **threshold**: `number`

Defined in: [src/adapters/avalanche/types.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L66)

How many of the output's owners must sign.

***

<a id="txid"></a>

### txId

> `readonly` **txId**: `string`

Defined in: [src/adapters/avalanche/types.ts:58](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L58)

***

<a id="utxoid"></a>

### utxoId

> `readonly` **utxoId**: `string`

Defined in: [src/adapters/avalanche/types.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L57)

`txID:outputIndex`, the reservation key of this output.
