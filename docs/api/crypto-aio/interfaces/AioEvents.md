[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AioEvents

# Interface: AioEvents

Defined in: [src/core/events/types.ts:8](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L8)

Every event and its payload. Every payload is operational-class data only (no addresses,
amounts, raw txs or URLs). A minor release may add events and optional payload fields.

## Properties

<a id="attemptstate"></a>

### attempt.state

> **attempt.state**: `object`

Defined in: [src/core/events/types.ts:71](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L71)

An Attempt's observed state or evidence changed.

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

Defined in: [src/core/events/types.ts:86](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L86)

A nonce or seqno was reserved for an Operation.

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

Defined in: [src/core/events/types.ts:100](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L100)

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

Defined in: [src/core/events/types.ts:69](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L69)

An Operation stalled and waits for its caller's remedy; `code` says why.

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

Defined in: [src/core/events/types.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L59)

An Operation moved from one state to another (`from` is `null` when it was created).

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

Defined in: [src/core/events/types.ts:38](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L38)

After every completed health refresh, once per endpoint, with its state: a periodic
gauge, not a change event. Never emitted for an endpoint whose state is `unknown` or
`half-open`.

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

Defined in: [src/core/events/types.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L53)

Endpoints of a quorum read disagreed; the read decided nothing.

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

Defined in: [src/core/events/types.ts:46](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L46)

An endpoint answered another network's identity than expected; it is disabled.

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

Defined in: [src/core/events/types.ts:134](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L134)

`recover()` left an Operation that needs its caller; `reason` is a code.

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

Defined in: [src/core/events/types.ts:25](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L25)

A request to an endpoint failed.

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

Defined in: [src/core/events/types.ts:10](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L10)

A request is about to go to an endpoint; `method` is an RPC method or a route template.

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

Defined in: [src/core/events/types.ts:17](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L17)

An endpoint answered.

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

Defined in: [src/core/events/types.ts:125](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L125)

A scanner delivered a block.

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

Defined in: [src/core/events/types.ts:127](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L127)

A scanner rolled back to `toHeight` after a reorg, removing `removed` blocks.

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

Defined in: [src/core/events/types.ts:117](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L117)

A signer answered: signed, pending (with a ticket), or with an error.

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

Defined in: [src/core/events/types.ts:110](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L110)

A signer was asked for `requests` signatures.

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

Defined in: [src/core/events/types.ts:79](https://github.com/vhidvz/crypto-aio/blob/main/src/core/events/types.ts#L79)

A block that held a transfer's transaction left the chain.

#### attemptId?

> `optional` **attemptId?**: `string`

#### namespace

> **namespace**: `string`

#### operationId?

> `optional` **operationId?**: `string`

#### previousBlockHash

> **previousBlockHash**: `string`
