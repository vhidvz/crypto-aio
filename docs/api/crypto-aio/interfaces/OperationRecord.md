[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OperationRecord

# Interface: OperationRecord

Defined in: [src/core/store/types.ts:109](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L109)

## Properties

<a id="activeattemptid"></a>

### activeAttemptId?

> `readonly` `optional` **activeAttemptId?**: `string`

Defined in: [src/core/store/types.ts:129](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L129)

***

<a id="ambiguous"></a>

### ambiguous?

> `readonly` `optional` **ambiguous?**: `boolean`

Defined in: [src/core/store/types.ts:130](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L130)

***

<a id="attempts"></a>

### attempts

> `readonly` **attempts**: readonly [`AttemptRecord`](AttemptRecord.md)[]

Defined in: [src/core/store/types.ts:128](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L128)

***

<a id="claim"></a>

### claim?

> `readonly` `optional` **claim?**: [`OperationClaim`](OperationClaim.md)

Defined in: [src/core/store/types.ts:132](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L132)

***

<a id="context"></a>

### context

> `readonly` **context**: [`ExecutionContext`](ExecutionContext.md)

Defined in: [src/core/store/types.ts:119](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L119)

***

<a id="createdat"></a>

### createdAt

> `readonly` **createdAt**: `number`

Defined in: [src/core/store/types.ts:134](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L134)

***

<a id="error"></a>

### error?

> `readonly` `optional` **error?**: [`SerializedError`](SerializedError.md)

Defined in: [src/core/store/types.ts:133](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L133)

***

<a id="format"></a>

### format

> `readonly` **format**: `number`

Defined in: [src/core/store/types.ts:115](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L115)

The record format the Operation was stored in (`OPERATION_FORMAT` when it was created).
A store keeps it as it keeps every other field. Records of 0.1.0 have none: format 1.

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/store/types.ts:110](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L110)

***

<a id="idempotencykey"></a>

### idempotencyKey

> `readonly` **idempotencyKey**: `string`

Defined in: [src/core/store/types.ts:117](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L117)

***

<a id="intent"></a>

### intent

> `readonly` **intent**: [`StoredIntent`](StoredIntent.md)

Defined in: [src/core/store/types.ts:123](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L123)

***

<a id="intenthash"></a>

### intentHash

> `readonly` **intentHash**: `string`

Defined in: [src/core/store/types.ts:118](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L118)

***

<a id="kind"></a>

### kind

> `readonly` **kind**: `"transfer"`

Defined in: [src/core/store/types.ts:120](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L120)

***

<a id="namespace"></a>

### namespace

> `readonly` **namespace**: `string`

Defined in: [src/core/store/types.ts:116](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L116)

***

<a id="nextcheckat"></a>

### nextCheckAt?

> `readonly` `optional` **nextCheckAt?**: `number`

Defined in: [src/core/store/types.ts:136](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L136)

***

<a id="outcome"></a>

### outcome?

> `readonly` `optional` **outcome?**: `"executed"` \| `"cancelled"`

Defined in: [src/core/store/types.ts:122](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L122)

***

<a id="partialsignatures"></a>

### partialSignatures?

> `readonly` `optional` **partialSignatures?**: readonly [`SignatureBundle`](SignatureBundle.md)[]

Defined in: [src/core/store/types.ts:127](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L127)

***

<a id="reservation"></a>

### reservation?

> `readonly` `optional` **reservation?**: [`OrderingData`](../type-aliases/OrderingData.md)

Defined in: [src/core/store/types.ts:125](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L125)

***

<a id="signertickets"></a>

### signerTickets?

> `readonly` `optional` **signerTickets?**: readonly [`SignerTicket`](SignerTicket.md)[]

Defined in: [src/core/store/types.ts:126](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L126)

***

<a id="state"></a>

### state

> `readonly` **state**: [`OperationState`](../type-aliases/OperationState.md)

Defined in: [src/core/store/types.ts:121](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L121)

***

<a id="unsigned"></a>

### unsigned?

> `readonly` `optional` **unsigned?**: [`UnsignedTx`](UnsignedTx.md)

Defined in: [src/core/store/types.ts:124](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L124)

***

<a id="updatedat"></a>

### updatedAt

> `readonly` **updatedAt**: `number`

Defined in: [src/core/store/types.ts:135](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L135)

***

<a id="version"></a>

### version

> `readonly` **version**: `number`

Defined in: [src/core/store/types.ts:131](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L131)
