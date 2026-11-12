[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverTransaction

# Interface: DriverTransaction

Defined in: [src/core/driver/types.ts:126](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L126)

A transaction as a driver decodes it.

## Properties

<a id="decoding"></a>

### decoding

> `readonly` **decoding**: [`Decoding`](../type-aliases/Decoding.md)

Defined in: [src/core/driver/types.ts:133](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L133)

Whether `transfers` lists every movement the transaction makes.

***

<a id="details"></a>

### details

> `readonly` **details**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/driver/types.ts:138](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L138)

Family-specific fields, passed through to `Transaction.details`.

***

<a id="fee"></a>

### fee?

> `readonly` `optional` **fee?**: readonly `object`[]

Defined in: [src/core/driver/types.ts:130](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L130)

What the transaction paid, per asset; absent while unknown.

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/driver/types.ts:127](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L127)

***

<a id="observation"></a>

### observation

> `readonly` **observation**: [`DriverTxObservation`](DriverTxObservation.md)

Defined in: [src/core/driver/types.ts:128](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L128)

***

<a id="raw"></a>

### raw?

> `readonly` `optional` **raw?**: [`RawTx`](RawTx.md)

Defined in: [src/core/driver/types.ts:134](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L134)

***

<a id="timestamp"></a>

### timestamp?

> `readonly` `optional` **timestamp?**: `number`

Defined in: [src/core/driver/types.ts:136](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L136)

The block's time in Unix seconds, whatever unit the chain reports it in.

***

<a id="transfers"></a>

### transfers

> `readonly` **transfers**: readonly [`DriverTransfer`](DriverTransfer.md)[]

Defined in: [src/core/driver/types.ts:131](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L131)
