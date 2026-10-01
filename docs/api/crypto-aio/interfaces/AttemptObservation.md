[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AttemptObservation

# Interface: AttemptObservation

Defined in: [src/core/store/types.ts:82](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L82)

Mutable, versioned view of what the chain says about an Attempt.

## Properties

<a id="attemptid"></a>

### attemptId

> `readonly` **attemptId**: `string`

Defined in: [src/core/store/types.ts:83](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L83)

***

<a id="blockhash"></a>

### blockHash?

> `readonly` `optional` **blockHash?**: `string`

Defined in: [src/core/store/types.ts:88](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L88)

***

<a id="blockheight"></a>

### blockHeight?

> `readonly` `optional` **blockHeight?**: `bigint`

Defined in: [src/core/store/types.ts:89](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L89)

***

<a id="confirmations"></a>

### confirmations

> `readonly` **confirmations**: `number`

Defined in: [src/core/store/types.ts:90](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L90)

***

<a id="evidence"></a>

### evidence

> `readonly` **evidence**: [`Evidence`](../type-aliases/Evidence.md)

Defined in: [src/core/store/types.ts:86](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L86)

***

<a id="firstseenat"></a>

### firstSeenAt?

> `readonly` `optional` **firstSeenAt?**: `number`

Defined in: [src/core/store/types.ts:91](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L91)

***

<a id="lastbroadcastat"></a>

### lastBroadcastAt?

> `readonly` `optional` **lastBroadcastAt?**: `number`

Defined in: [src/core/store/types.ts:93](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L93)

***

<a id="lastseenat"></a>

### lastSeenAt?

> `readonly` `optional` **lastSeenAt?**: `number`

Defined in: [src/core/store/types.ts:92](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L92)

***

<a id="operationid"></a>

### operationId

> `readonly` **operationId**: `string`

Defined in: [src/core/store/types.ts:84](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L84)

***

<a id="reason"></a>

### reason?

> `readonly` `optional` **reason?**: `string`

Defined in: [src/core/store/types.ts:94](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L94)

***

<a id="replacedby"></a>

### replacedBy?

> `readonly` `optional` **replacedBy?**: `string`

Defined in: [src/core/store/types.ts:95](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L95)

***

<a id="state"></a>

### state

> `readonly` **state**: [`TxState`](../type-aliases/TxState.md)

Defined in: [src/core/store/types.ts:85](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L85)

***

<a id="txhash"></a>

### txHash?

> `readonly` `optional` **txHash?**: `string`

Defined in: [src/core/store/types.ts:87](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L87)

***

<a id="version"></a>

### version

> `readonly` **version**: `number`

Defined in: [src/core/store/types.ts:96](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L96)
