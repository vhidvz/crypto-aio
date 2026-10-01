[crypto-aio](../../index.md) / [crypto-aio](../index.md) / UtxoSelectionPreview

# Interface: UtxoSelectionPreview

Defined in: [src/adapters/utxo/types.ts:91](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L91)

A dry run of the configured coin selection.

## Properties

<a id="change"></a>

### change

> `readonly` **change**: `bigint`

Defined in: [src/adapters/utxo/types.ts:97](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L97)

***

<a id="fee"></a>

### fee

> `readonly` **fee**: `bigint`

Defined in: [src/adapters/utxo/types.ts:94](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L94)

***

<a id="inputs"></a>

### inputs

> `readonly` **inputs**: readonly `object`[]

Defined in: [src/adapters/utxo/types.ts:93](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L93)

The outputs it would spend (every eligible one when `sufficient` is `false`).

***

<a id="satperkvb"></a>

### satPerKvB

> `readonly` **satPerKvB**: `bigint`

Defined in: [src/adapters/utxo/types.ts:95](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L95)

***

<a id="sufficient"></a>

### sufficient

> `readonly` **sufficient**: `boolean`

Defined in: [src/adapters/utxo/types.ts:99](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L99)

`false` when the eligible outputs cannot pay for the outputs and the fee.

***

<a id="vsize"></a>

### vsize

> `readonly` **vsize**: `number`

Defined in: [src/adapters/utxo/types.ts:96](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L96)
