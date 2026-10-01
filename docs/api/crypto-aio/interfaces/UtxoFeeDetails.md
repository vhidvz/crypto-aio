[crypto-aio](../../index.md) / [crypto-aio](../index.md) / UtxoFeeDetails

# Interface: UtxoFeeDetails

Defined in: [src/adapters/utxo/types.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L52)

`FeeEstimate.details` of the `utxo` fee kind.

## Properties

<a id="change"></a>

### change

> `readonly` **change**: `bigint`

Defined in: [src/adapters/utxo/types.ts:61](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L61)

The change amount; `0n` when there is no change output.

***

<a id="changeindex"></a>

### changeIndex

> `readonly` **changeIndex**: `number`

Defined in: [src/adapters/utxo/types.ts:63](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L63)

Index of the change output, or `-1` when there is none.

***

<a id="inputs"></a>

### inputs

> `readonly` **inputs**: `number`

Defined in: [src/adapters/utxo/types.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L57)

***

<a id="outputs"></a>

### outputs

> `readonly` **outputs**: `number`

Defined in: [src/adapters/utxo/types.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L59)

Outputs including change.

***

<a id="satperkvb"></a>

### satPerKvB

> `readonly` **satPerKvB**: `bigint`

Defined in: [src/adapters/utxo/types.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L54)

The fee rate in satoshis per 1,000 virtual bytes (Bitcoin Core's unit).

***

<a id="vsize"></a>

### vsize

> `readonly` **vsize**: `number`

Defined in: [src/adapters/utxo/types.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L56)

Virtual size of the transaction, counting worst-case (72-byte) ECDSA signatures.
