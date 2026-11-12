[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverBlock

# Interface: DriverBlock

Defined in: [src/core/driver/types.ts:142](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L142)

A block header as a driver reads it, with its transaction ids when the read has them.

## Properties

<a id="hash"></a>

### hash

> `readonly` **hash**: `string`

Defined in: [src/core/driver/types.ts:144](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L144)

***

<a id="height"></a>

### height

> `readonly` **height**: `bigint`

Defined in: [src/core/driver/types.ts:143](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L143)

***

<a id="parenthash"></a>

### parentHash

> `readonly` **parentHash**: `string`

Defined in: [src/core/driver/types.ts:145](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L145)

***

<a id="timestamp"></a>

### timestamp?

> `readonly` `optional` **timestamp?**: `number`

Defined in: [src/core/driver/types.ts:147](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L147)

The block's time in Unix seconds, whatever unit the chain reports it in.

***

<a id="transactionids"></a>

### transactionIds?

> `readonly` `optional` **transactionIds?**: readonly `string`[]

Defined in: [src/core/driver/types.ts:148](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L148)
