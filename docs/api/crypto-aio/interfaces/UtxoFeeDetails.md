[crypto-aio](../../index.md) / [crypto-aio](../index.md) / UtxoFeeDetails

# Interface: UtxoFeeDetails

Defined in: [src/adapters/utxo/types.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L51)

`FeeEstimate.details` of the `utxo` fee kind.

## Properties

<a id="change"></a>

### change

> `readonly` **change**: `bigint`

Defined in: [src/adapters/utxo/types.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L60)

The change amount; `0n` when there is no change output.

***

<a id="changeindex"></a>

### changeIndex

> `readonly` **changeIndex**: `number`

Defined in: [src/adapters/utxo/types.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L62)

Index of the change output, or `-1` when there is none.

***

<a id="inputs"></a>

### inputs

> `readonly` **inputs**: `number`

Defined in: [src/adapters/utxo/types.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L56)

***

<a id="outputs"></a>

### outputs

> `readonly` **outputs**: `number`

Defined in: [src/adapters/utxo/types.ts:58](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L58)

Outputs including change.

***

<a id="satperkvb"></a>

### satPerKvB

> `readonly` **satPerKvB**: `bigint`

Defined in: [src/adapters/utxo/types.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L53)

The fee rate in satoshis per 1,000 virtual bytes (Bitcoin Core's unit).

***

<a id="vsize"></a>

### vsize

> `readonly` **vsize**: `number`

Defined in: [src/adapters/utxo/types.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L55)

Virtual size of the transaction, counting worst-case (72-byte) ECDSA signatures.
