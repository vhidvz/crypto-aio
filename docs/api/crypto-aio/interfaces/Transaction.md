[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Transaction

# Interface: Transaction

Defined in: [src/core/model/transaction.ts:125](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L125)

## Properties

<a id="block"></a>

### block?

> `readonly` `optional` **block?**: [`BlockRef`](BlockRef.md)

Defined in: [src/core/model/transaction.ts:130](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L130)

***

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/model/transaction.ts:127](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L127)

***

<a id="decoding"></a>

### decoding

> `readonly` **decoding**: [`Decoding`](../type-aliases/Decoding.md)

Defined in: [src/core/model/transaction.ts:133](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L133)

***

<a id="details"></a>

### details

> `readonly` **details**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/transaction.ts:135](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L135)

***

<a id="fee"></a>

### fee?

> `readonly` `optional` **fee?**: readonly [`Amount`](../classes/Amount.md)[]

Defined in: [src/core/model/transaction.ts:131](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L131)

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/model/transaction.ts:126](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L126)

***

<a id="network"></a>

### network

> `readonly` **network**: `string`

Defined in: [src/core/model/transaction.ts:128](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L128)

***

<a id="raw"></a>

### raw?

> `readonly` `optional` **raw?**: [`RawTx`](RawTx.md)

Defined in: [src/core/model/transaction.ts:134](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L134)

***

<a id="status"></a>

### status

> `readonly` **status**: [`TxStatus`](TxStatus.md)

Defined in: [src/core/model/transaction.ts:129](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L129)

***

<a id="transfers"></a>

### transfers

> `readonly` **transfers**: readonly [`Transfer`](../type-aliases/Transfer.md)[]

Defined in: [src/core/model/transaction.ts:132](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L132)
