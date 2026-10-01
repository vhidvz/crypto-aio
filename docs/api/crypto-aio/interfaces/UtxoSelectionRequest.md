[crypto-aio](../../index.md) / [crypto-aio](../index.md) / UtxoSelectionRequest

# Interface: UtxoSelectionRequest

Defined in: [src/adapters/utxo/types.ts:83](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L83)

## Properties

<a id="exclude"></a>

### exclude?

> `readonly` `optional` **exclude?**: readonly `string`[]

Defined in: [src/adapters/utxo/types.ts:88](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L88)

Outpoints to leave out (e.g. those held by live Operations).

***

<a id="fee"></a>

### fee?

> `readonly` `optional` **fee?**: [`FeeSpeed`](../type-aliases/FeeSpeed.md) \| [`UtxoFeeOverride`](../type-aliases/UtxoFeeOverride.md)

Defined in: [src/adapters/utxo/types.ts:86](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L86)

***

<a id="from"></a>

### from

> `readonly` **from**: `string`

Defined in: [src/adapters/utxo/types.ts:84](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L84)

***

<a id="outputs"></a>

### outputs

> `readonly` **outputs**: readonly `object`[]

Defined in: [src/adapters/utxo/types.ts:85](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L85)
