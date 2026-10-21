[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TxStatus

# Interface: TxStatus

Defined in: [src/core/model/transaction.ts:49](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L49)

## Properties

<a id="blockhash"></a>

### blockHash?

> `readonly` `optional` **blockHash?**: `string`

Defined in: [src/core/model/transaction.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L54)

***

<a id="blockheight"></a>

### blockHeight?

> `readonly` `optional` **blockHeight?**: `bigint`

Defined in: [src/core/model/transaction.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L55)

***

<a id="confirmations"></a>

### confirmations

> `readonly` **confirmations**: `number`

Defined in: [src/core/model/transaction.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L52)

***

<a id="evidence"></a>

### evidence

> `readonly` **evidence**: [`Evidence`](../type-aliases/Evidence.md)

Defined in: [src/core/model/transaction.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L51)

***

<a id="finality"></a>

### finality

> `readonly` **finality**: [`Finality`](../type-aliases/Finality.md)

Defined in: [src/core/model/transaction.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L56)

***

<a id="reason"></a>

### reason?

> `readonly` `optional` **reason?**: `string`

Defined in: [src/core/model/transaction.ts:64](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L64)

Why the transaction did not go through. Present only with `failed`, `refused` or
`rejected`. It is either a broadcast's refusal or rejection text, or the chain
driver's text for an on-chain failure. It is a short, fixed text with no addresses,
amounts or node detail. It is `sensitive` data, so it never appears in events
or logs.

***

<a id="replacedby"></a>

### replacedBy?

> `readonly` `optional` **replacedBy?**: `string`

Defined in: [src/core/model/transaction.ts:65](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L65)

***

<a id="state"></a>

### state

> `readonly` **state**: [`TxState`](../type-aliases/TxState.md)

Defined in: [src/core/model/transaction.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L50)

***

<a id="txhash"></a>

### txHash?

> `readonly` `optional` **txHash?**: `string`

Defined in: [src/core/model/transaction.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L53)
