[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Transaction

# Interface: Transaction

Defined in: [src/core/model/transaction.ts:117](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L117)

## Properties

<a id="block"></a>

### block?

> `readonly` `optional` **block?**: [`BlockRef`](BlockRef.md)

Defined in: [src/core/model/transaction.ts:122](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L122)

***

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/model/transaction.ts:119](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L119)

***

<a id="decoding"></a>

### decoding

> `readonly` **decoding**: [`Decoding`](../type-aliases/Decoding.md)

Defined in: [src/core/model/transaction.ts:125](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L125)

***

<a id="details"></a>

### details

> `readonly` **details**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/model/transaction.ts:127](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L127)

***

<a id="fee"></a>

### fee?

> `readonly` `optional` **fee?**: readonly [`Amount`](../classes/Amount.md)[]

Defined in: [src/core/model/transaction.ts:123](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L123)

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/model/transaction.ts:118](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L118)

***

<a id="network"></a>

### network

> `readonly` **network**: `string`

Defined in: [src/core/model/transaction.ts:120](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L120)

***

<a id="raw"></a>

### raw?

> `readonly` `optional` **raw?**: [`RawTx`](RawTx.md)

Defined in: [src/core/model/transaction.ts:126](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L126)

***

<a id="status"></a>

### status

> `readonly` **status**: [`TxStatus`](TxStatus.md)

Defined in: [src/core/model/transaction.ts:121](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L121)

***

<a id="transfers"></a>

### transfers

> `readonly` **transfers**: readonly [`Transfer`](../type-aliases/Transfer.md)[]

Defined in: [src/core/model/transaction.ts:124](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L124)
