[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AioEvents

# Interface: AioEvents

Defined in: [src/core/events/types.ts:5](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L5)

Every payload is operational-class data only (no addresses, amounts, raw txs or URLs).

## Properties

<a id="attemptstate"></a>

### attempt.state

> **attempt.state**: `object`

Defined in: [src/core/events/types.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L55)

#### attemptId

> **attemptId**: `string`

#### evidence

> **evidence**: [`Evidence`](../type-aliases/Evidence.md)

#### namespace

> **namespace**: `string`

#### operationId

> **operationId**: `string`

#### state

> **state**: [`TxState`](../type-aliases/TxState.md)

***

<a id="nonceallocated"></a>

### nonce.allocated

> **nonce.allocated**: `object`

Defined in: [src/core/events/types.ts:68](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L68)

#### chain

> **chain**: `string`

#### namespace

> **namespace**: `string`

#### network

> **network**: `string`

#### operationId

> **operationId**: `string`

#### value

> **value**: `string`

The nonce or seqno: an operational identifier, never UTXO inputs.

***

<a id="noncegap"></a>

### nonce.gap

> **nonce.gap**: `object`

Defined in: [src/core/events/types.ts:82](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L82)

A submitted Operation has waited past the grace period while the chain's pending nonce
(`expected`) is below its own. At-least-once: a monitor reports each (Operation,
expected) once, but that memory is per process and bounded, so the same gap is reported
again after a restart, by another process, or once it was forgotten.

#### blockingOperationId?

> `optional` **blockingOperationId?**: `string`

#### chain

> **chain**: `string`

#### expected

> **expected**: `string`

The chain's pending nonce: an operational identifier.

#### namespace

> **namespace**: `string`

#### network

> **network**: `string`

#### operationId

> **operationId**: `string`

***

<a id="operationstalled"></a>

### operation.stalled

> **operation.stalled**: `object`

Defined in: [src/core/events/types.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L54)

#### code

> **code**: `string`

#### namespace

> **namespace**: `string`

#### operationId

> **operationId**: `string`

***

<a id="operationstate"></a>

### operation.state

> **operation.state**: `object`

Defined in: [src/core/events/types.ts:45](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L45)

#### chain

> **chain**: `string`

#### code?

> `optional` **code?**: `string`

#### from

> **from**: [`OperationState`](../type-aliases/OperationState.md) \| `null`

#### namespace

> **namespace**: `string`

#### network

> **network**: `string`

#### operationId

> **operationId**: `string`

#### to

> **to**: [`OperationState`](../type-aliases/OperationState.md)

***

<a id="providerhealth"></a>

### provider.health

> **provider.health**: `object`

Defined in: [src/core/events/types.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L27)

#### endpointId

> **endpointId**: `string`

#### height?

> `optional` **height?**: `string`

#### lag?

> `optional` **lag?**: `string`

#### state

> **state**: `"healthy"` \| `"lagging"` \| `"open"` \| `"disabled"`

#### transportId

> **transportId**: `string`

***

<a id="providerinconsistent"></a>

### provider.inconsistent

> **provider.inconsistent**: `object`

Defined in: [src/core/events/types.ts:40](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L40)

#### endpointIds

> **endpointIds**: readonly `string`[]

#### method

> **method**: `string`

#### transportId

> **transportId**: `string`

***

<a id="providermisconfigured"></a>

### provider.misconfigured

> **provider.misconfigured**: `object`

Defined in: [src/core/events/types.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L34)

#### actual

> **actual**: `string`

#### endpointId

> **endpointId**: `string`

#### expected

> **expected**: `string`

#### transportId

> **transportId**: `string`

***

<a id="recoveryskipped"></a>

### recovery.skipped

> **recovery.skipped**: `object`

Defined in: [src/core/events/types.ts:111](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L111)

#### namespace

> **namespace**: `string`

#### operationId

> **operationId**: `string`

#### reason

> **reason**: `string`

#### state

> **state**: [`OperationState`](../type-aliases/OperationState.md)

***

<a id="rpcerror"></a>

### rpc.error

> **rpc.error**: `object`

Defined in: [src/core/events/types.ts:19](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L19)

#### code

> **code**: `string`

#### endpointId

> **endpointId**: `string`

#### latencyMs

> **latencyMs**: `number`

#### method

> **method**: `string`

#### retryable

> **retryable**: `boolean`

#### transportId

> **transportId**: `string`

***

<a id="rpcrequest"></a>

### rpc.request

> **rpc.request**: `object`

Defined in: [src/core/events/types.ts:6](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L6)

#### attempt

> **attempt**: `number`

#### endpointId

> **endpointId**: `string`

#### method

> **method**: `string`

#### transportId

> **transportId**: `string`

***

<a id="rpcresponse"></a>

### rpc.response

> **rpc.response**: `object`

Defined in: [src/core/events/types.ts:12](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L12)

#### bytes

> **bytes**: `number`

#### endpointId

> **endpointId**: `string`

#### latencyMs

> **latencyMs**: `number`

#### method

> **method**: `string`

#### transportId

> **transportId**: `string`

***

<a id="scannerblock"></a>

### scanner.block

> **scanner.block**: `object`

Defined in: [src/core/events/types.ts:104](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L104)

#### cursorKey

> **cursorKey**: `string`

#### height

> **height**: `string`

#### namespace

> **namespace**: `string`

***

<a id="scannerrollback"></a>

### scanner.rollback

> **scanner.rollback**: `object`

Defined in: [src/core/events/types.ts:105](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L105)

#### cursorKey

> **cursorKey**: `string`

#### namespace

> **namespace**: `string`

#### removed

> **removed**: `number`

#### toHeight

> **toHeight**: `string`

***

<a id="signercompleted"></a>

### signer.completed

> **signer.completed**: `object`

Defined in: [src/core/events/types.ts:97](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L97)

#### latencyMs

> **latencyMs**: `number`

#### namespace

> **namespace**: `string`

#### operationId

> **operationId**: `string`

#### signerId

> **signerId**: `string`

#### status

> **status**: `"error"` \| `"signed"` \| `"pending"`

***

<a id="signerrequested"></a>

### signer.requested

> **signer.requested**: `object`

Defined in: [src/core/events/types.ts:91](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L91)

#### namespace

> **namespace**: `string`

#### operationId

> **operationId**: `string`

#### requests

> **requests**: `number`

#### signerId

> **signerId**: `string`

***

<a id="txreorged"></a>

### tx.reorged

> **tx.reorged**: `object`

Defined in: [src/core/events/types.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L62)

#### attemptId?

> `optional` **attemptId?**: `string`

#### namespace

> **namespace**: `string`

#### operationId?

> `optional` **operationId?**: `string`

#### previousBlockHash

> **previousBlockHash**: `string`
