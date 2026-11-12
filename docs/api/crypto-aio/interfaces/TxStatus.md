[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TxStatus

# Interface: TxStatus

Defined in: [src/core/model/transaction.ts:64](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L64)

A transaction's status. Complete a withdrawal only on `final` with `proven` evidence.

## Properties

<a id="blockhash"></a>

### blockHash?

> `readonly` `optional` **blockHash?**: `string`

Defined in: [src/core/model/transaction.ts:70](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L70)

***

<a id="blockheight"></a>

### blockHeight?

> `readonly` `optional` **blockHeight?**: `bigint`

Defined in: [src/core/model/transaction.ts:71](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L71)

***

<a id="confirmations"></a>

### confirmations

> `readonly` **confirmations**: `number`

Defined in: [src/core/model/transaction.ts:67](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L67)

***

<a id="evidence"></a>

### evidence

> `readonly` **evidence**: [`Evidence`](../type-aliases/Evidence.md)

Defined in: [src/core/model/transaction.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L66)

***

<a id="finality"></a>

### finality

> `readonly` **finality**: [`Finality`](../type-aliases/Finality.md)

Defined in: [src/core/model/transaction.ts:72](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L72)

***

<a id="reason"></a>

### reason?

> `readonly` `optional` **reason?**: `string`

Defined in: [src/core/model/transaction.ts:80](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L80)

Why the transaction did not go through. Present only with `failed`, `refused` or
`rejected`. It is either a broadcast's refusal or rejection text, or the chain
driver's text for an on-chain failure. It is a short, fixed text with no addresses,
amounts or node detail. It is `sensitive` data, so it never appears in events
or logs.

***

<a id="replacedby"></a>

### replacedBy?

> `readonly` `optional` **replacedBy?**: `string`

Defined in: [src/core/model/transaction.ts:82](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L82)

With `replaced`: the transaction that took its slot.

***

<a id="state"></a>

### state

> `readonly` **state**: [`TxState`](../type-aliases/TxState.md)

Defined in: [src/core/model/transaction.ts:65](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L65)

***

<a id="txhash"></a>

### txHash?

> `readonly` `optional` **txHash?**: `string`

Defined in: [src/core/model/transaction.ts:69](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/transaction.ts#L69)

The canonical transaction hash, once seen.
