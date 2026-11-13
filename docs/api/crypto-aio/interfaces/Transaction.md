[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Transaction

# Interface: Transaction

Defined in: [src/core/model/transaction.ts:156](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L156)

A transaction as a handle reads it.

## Properties

<a id="block"></a>

### block?

> `readonly` `optional` **block?**: [`BlockRef`](BlockRef.md)

Defined in: [src/core/model/transaction.ts:161](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L161)

***

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/model/transaction.ts:158](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L158)

***

<a id="decoding"></a>

### decoding

> `readonly` **decoding**: [`Decoding`](../type-aliases/Decoding.md)

Defined in: [src/core/model/transaction.ts:165](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L165)

***

<a id="details"></a>

### details

> `readonly` **details**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/transaction.ts:168](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L168)

Family-specific fields; not covered by semver beyond what each network page documents.

***

<a id="fee"></a>

### fee?

> `readonly` `optional` **fee?**: readonly [`Amount`](../classes/Amount.md)[]

Defined in: [src/core/model/transaction.ts:163](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L163)

What it paid, per asset; absent while unknown.

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/model/transaction.ts:157](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L157)

***

<a id="network"></a>

### network

> `readonly` **network**: `string`

Defined in: [src/core/model/transaction.ts:159](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L159)

***

<a id="raw"></a>

### raw?

> `readonly` `optional` **raw?**: [`RawTx`](RawTx.md)

Defined in: [src/core/model/transaction.ts:166](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L166)

***

<a id="status"></a>

### status

> `readonly` **status**: [`TxStatus`](TxStatus.md)

Defined in: [src/core/model/transaction.ts:160](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L160)

***

<a id="transfers"></a>

### transfers

> `readonly` **transfers**: readonly [`Transfer`](../type-aliases/Transfer.md)[]

Defined in: [src/core/model/transaction.ts:164](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L164)
