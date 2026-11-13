[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Block

# Interface: Block

Defined in: [src/core/model/transaction.ts:99](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L99)

A block. `timestamp` is its time as the chain records it, in Unix seconds on every
family (Tron's milliseconds are converted).

## Properties

<a id="hash"></a>

### hash

> `readonly` **hash**: `string`

Defined in: [src/core/model/transaction.ts:101](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L101)

***

<a id="height"></a>

### height

> `readonly` **height**: `bigint`

Defined in: [src/core/model/transaction.ts:100](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L100)

***

<a id="parenthash"></a>

### parentHash

> `readonly` **parentHash**: `string`

Defined in: [src/core/model/transaction.ts:102](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L102)

***

<a id="timestamp"></a>

### timestamp?

> `readonly` `optional` **timestamp?**: `number`

Defined in: [src/core/model/transaction.ts:103](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L103)

***

<a id="transactionids"></a>

### transactionIds?

> `readonly` `optional` **transactionIds?**: readonly `string`[]

Defined in: [src/core/model/transaction.ts:104](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L104)
