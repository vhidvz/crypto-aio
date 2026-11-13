[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OperationRecord

# Interface: OperationRecord

Defined in: [src/core/store/types.ts:150](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L150)

One transfer and everything the core stored about it.

## Properties

<a id="activeattemptid"></a>

### activeAttemptId?

> `readonly` `optional` **activeAttemptId?**: `string`

Defined in: [src/core/store/types.ts:180](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L180)

The Attempt the monitor follows; `appendAttempt` sets it to the Attempt it appends.

***

<a id="ambiguous"></a>

### ambiguous?

> `readonly` `optional` **ambiguous?**: `boolean`

Defined in: [src/core/store/types.ts:182](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L182)

Whether a send may have reached the network without an answer saying so.

***

<a id="attempts"></a>

### attempts

> `readonly` **attempts**: readonly [`AttemptRecord`](AttemptRecord.md)[]

Defined in: [src/core/store/types.ts:178](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L178)

Every signed transaction, in the order appended; never rewritten.

***

<a id="claim"></a>

### claim?

> `readonly` `optional` **claim?**: [`OperationClaim`](OperationClaim.md)

Defined in: [src/core/store/types.ts:186](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L186)

Owned by the store: set by `claimDue`, removed by `releaseClaim`.

***

<a id="context"></a>

### context

> `readonly` **context**: [`ExecutionContext`](ExecutionContext.md)

Defined in: [src/core/store/types.ts:163](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L163)

***

<a id="createdat"></a>

### createdAt

> `readonly` **createdAt**: `number`

Defined in: [src/core/store/types.ts:190](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L190)

Stamped by the store's clock.

***

<a id="error"></a>

### error?

> `readonly` `optional` **error?**: [`SerializedError`](SerializedError.md)

Defined in: [src/core/store/types.ts:188](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L188)

Why the Operation failed or stalled.

***

<a id="format"></a>

### format

> `readonly` **format**: `number`

Defined in: [src/core/store/types.ts:157](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L157)

The record format the Operation was stored in (`OPERATION_FORMAT` when it was created).
A store keeps it as it keeps every other field. Records of 0.1.0 have none: format 1.

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/store/types.ts:152](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L152)

Unique within its namespace.

***

<a id="idempotencykey"></a>

### idempotencyKey

> `readonly` **idempotencyKey**: `string`

Defined in: [src/core/store/types.ts:160](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L160)

The caller's key; unique within the namespace.

***

<a id="intent"></a>

### intent

> `readonly` **intent**: [`StoredIntent`](StoredIntent.md)

Defined in: [src/core/store/types.ts:168](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L168)

***

<a id="intenthash"></a>

### intentHash

> `readonly` **intentHash**: `string`

Defined in: [src/core/store/types.ts:162](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L162)

A hash of the normalized intent: a repeated key with another intent is a conflict.

***

<a id="kind"></a>

### kind

> `readonly` **kind**: `"transfer"`

Defined in: [src/core/store/types.ts:164](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L164)

***

<a id="namespace"></a>

### namespace

> `readonly` **namespace**: `string`

Defined in: [src/core/store/types.ts:158](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L158)

***

<a id="nextcheckat"></a>

### nextCheckAt?

> `readonly` `optional` **nextCheckAt?**: `number`

Defined in: [src/core/store/types.ts:193](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L193)

When a worker should check it next; unset while a caller still builds or signs it.

***

<a id="outcome"></a>

### outcome?

> `readonly` `optional` **outcome?**: `"executed"` \| `"cancelled"`

Defined in: [src/core/store/types.ts:167](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L167)

For a `final` Operation: whether its transfer or a cancel landed.

***

<a id="partialsignatures"></a>

### partialSignatures?

> `readonly` `optional` **partialSignatures?**: readonly [`SignatureBundle`](SignatureBundle.md)[]

Defined in: [src/core/store/types.ts:176](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L176)

Signatures collected so far for a transaction signed in parts.

***

<a id="reservation"></a>

### reservation?

> `readonly` `optional` **reservation?**: [`OrderingData`](../type-aliases/OrderingData.md)

Defined in: [src/core/store/types.ts:172](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L172)

The slot reserved for the transfer, such as a nonce or the inputs it spends.

***

<a id="signertickets"></a>

### signerTickets?

> `readonly` `optional` **signerTickets?**: readonly [`SignerTicket`](SignerTicket.md)[]

Defined in: [src/core/store/types.ts:174](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L174)

Tickets of asynchronous signing requests in flight.

***

<a id="state"></a>

### state

> `readonly` **state**: [`OperationState`](../type-aliases/OperationState.md)

Defined in: [src/core/store/types.ts:165](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L165)

***

<a id="unsigned"></a>

### unsigned?

> `readonly` `optional` **unsigned?**: [`UnsignedTx`](UnsignedTx.md)

Defined in: [src/core/store/types.ts:170](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L170)

The unsigned transaction, from preparation until an Attempt holds it.

***

<a id="updatedat"></a>

### updatedAt

> `readonly` **updatedAt**: `number`

Defined in: [src/core/store/types.ts:191](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L191)

***

<a id="version"></a>

### version

> `readonly` **version**: `number`

Defined in: [src/core/store/types.ts:184](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L184)

Starts at 1 and grows by one on every successful write to the record.
