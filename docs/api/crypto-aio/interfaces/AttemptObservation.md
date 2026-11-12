[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AttemptObservation

# Interface: AttemptObservation

Defined in: [src/core/store/types.ts:114](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L114)

Mutable, versioned view of what the chain says about an Attempt.

## Properties

<a id="attemptid"></a>

### attemptId

> `readonly` **attemptId**: `string`

Defined in: [src/core/store/types.ts:115](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L115)

***

<a id="blockhash"></a>

### blockHash?

> `readonly` `optional` **blockHash?**: `string`

Defined in: [src/core/store/types.ts:123](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L123)

***

<a id="blockheight"></a>

### blockHeight?

> `readonly` `optional` **blockHeight?**: `bigint`

Defined in: [src/core/store/types.ts:124](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L124)

***

<a id="confirmations"></a>

### confirmations

> `readonly` **confirmations**: `number`

Defined in: [src/core/store/types.ts:125](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L125)

***

<a id="evidence"></a>

### evidence

> `readonly` **evidence**: [`Evidence`](../type-aliases/Evidence.md)

Defined in: [src/core/store/types.ts:120](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L120)

How the state was established: one endpoint's read, or a proof under the quorum.

***

<a id="failure"></a>

### failure?

> `readonly` `optional` **failure?**: [`TxFailure`](../type-aliases/TxFailure.md)

Defined in: [src/core/store/types.ts:134](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L134)

With `state: 'failed'`: what failed (absent: `'reverted'`).

***

<a id="firstseenat"></a>

### firstSeenAt?

> `readonly` `optional` **firstSeenAt?**: `number`

Defined in: [src/core/store/types.ts:127](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L127)

When the transaction was first and last seen, by the core's clock.

***

<a id="lastbroadcastat"></a>

### lastBroadcastAt?

> `readonly` `optional` **lastBroadcastAt?**: `number`

Defined in: [src/core/store/types.ts:130](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L130)

When the core last sent the bytes.

***

<a id="lastseenat"></a>

### lastSeenAt?

> `readonly` `optional` **lastSeenAt?**: `number`

Defined in: [src/core/store/types.ts:128](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L128)

***

<a id="operationid"></a>

### operationId

> `readonly` **operationId**: `string`

Defined in: [src/core/store/types.ts:116](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L116)

***

<a id="reason"></a>

### reason?

> `readonly` `optional` **reason?**: `string`

Defined in: [src/core/store/types.ts:132](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L132)

A node's refusal text or the driver's failure reason; free text, not covered by semver.

***

<a id="replacedby"></a>

### replacedBy?

> `readonly` `optional` **replacedBy?**: `string`

Defined in: [src/core/store/types.ts:136](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L136)

The Attempt whose transaction took this one's slot.

***

<a id="state"></a>

### state

> `readonly` **state**: [`TxState`](../type-aliases/TxState.md)

Defined in: [src/core/store/types.ts:118](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L118)

What the chain shows for the transaction.

***

<a id="txhash"></a>

### txHash?

> `readonly` `optional` **txHash?**: `string`

Defined in: [src/core/store/types.ts:122](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L122)

The canonical transaction hash the chain reports, once seen.

***

<a id="version"></a>

### version

> `readonly` **version**: `number`

Defined in: [src/core/store/types.ts:138](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L138)

Starts at 1 and grows by one on each `putObservation`.
