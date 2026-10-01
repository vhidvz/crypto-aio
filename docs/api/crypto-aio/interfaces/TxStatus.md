[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TxStatus

# Interface: TxStatus

Defined in: [src/core/model/transaction.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L41)

## Properties

<a id="blockhash"></a>

### blockHash?

> `readonly` `optional` **blockHash?**: `string`

Defined in: [src/core/model/transaction.ts:46](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L46)

***

<a id="blockheight"></a>

### blockHeight?

> `readonly` `optional` **blockHeight?**: `bigint`

Defined in: [src/core/model/transaction.ts:47](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L47)

***

<a id="confirmations"></a>

### confirmations

> `readonly` **confirmations**: `number`

Defined in: [src/core/model/transaction.ts:44](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L44)

***

<a id="evidence"></a>

### evidence

> `readonly` **evidence**: [`Evidence`](../type-aliases/Evidence.md)

Defined in: [src/core/model/transaction.ts:43](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L43)

***

<a id="finality"></a>

### finality

> `readonly` **finality**: [`Finality`](../type-aliases/Finality.md)

Defined in: [src/core/model/transaction.ts:48](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L48)

***

<a id="reason"></a>

### reason?

> `readonly` `optional` **reason?**: `string`

Defined in: [src/core/model/transaction.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L56)

Why the transaction did not go through. Present only with `failed`, `refused` or
`rejected`. It is either a broadcast's refusal or rejection text, or the chain
driver's text for an on-chain failure. It is a short, fixed text with no addresses,
amounts or node detail (R24). It is `sensitive` data, so it never appears in events
or logs.

***

<a id="replacedby"></a>

### replacedBy?

> `readonly` `optional` **replacedBy?**: `string`

Defined in: [src/core/model/transaction.ts:57](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L57)

***

<a id="state"></a>

### state

> `readonly` **state**: [`TxState`](../type-aliases/TxState.md)

Defined in: [src/core/model/transaction.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L42)

***

<a id="txhash"></a>

### txHash?

> `readonly` `optional` **txHash?**: `string`

Defined in: [src/core/model/transaction.ts:45](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L45)
