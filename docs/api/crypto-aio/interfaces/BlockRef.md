[crypto-aio](../../index.md) / [crypto-aio](../index.md) / BlockRef

# Interface: BlockRef

Defined in: [src/core/model/transaction.ts:89](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L89)

The block a transaction is in. `timestamp` is the block's time as the chain records it,
in Unix seconds on every family (Tron's milliseconds are converted).

## Properties

<a id="hash"></a>

### hash

> `readonly` **hash**: `string`

Defined in: [src/core/model/transaction.ts:91](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L91)

***

<a id="height"></a>

### height

> `readonly` **height**: `bigint`

Defined in: [src/core/model/transaction.ts:90](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L90)

***

<a id="timestamp"></a>

### timestamp?

> `readonly` `optional` **timestamp?**: `number`

Defined in: [src/core/model/transaction.ts:92](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L92)
