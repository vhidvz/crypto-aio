[crypto-aio](../../index.md) / [crypto-aio](../index.md) / UtxoSelectionRequest

# Interface: UtxoSelectionRequest

Defined in: [src/adapters/utxo/types.ts:84](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L84)

What `ext.utxo.coinSelection()` previews: a transfer of `outputs` from `from`.

## Properties

<a id="exclude"></a>

### exclude?

> `readonly` `optional` **exclude?**: readonly `string`[]

Defined in: [src/adapters/utxo/types.ts:89](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L89)

Outpoints to leave out (e.g. those held by live Operations).

***

<a id="fee"></a>

### fee?

> `readonly` `optional` **fee?**: [`FeeSpeed`](../type-aliases/FeeSpeed.md) \| [`UtxoFeeOverride`](../type-aliases/UtxoFeeOverride.md)

Defined in: [src/adapters/utxo/types.ts:87](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L87)

***

<a id="from"></a>

### from

> `readonly` **from**: `string`

Defined in: [src/adapters/utxo/types.ts:85](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L85)

***

<a id="outputs"></a>

### outputs

> `readonly` **outputs**: readonly `object`[]

Defined in: [src/adapters/utxo/types.ts:86](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L86)
