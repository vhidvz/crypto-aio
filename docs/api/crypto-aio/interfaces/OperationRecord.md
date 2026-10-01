[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OperationRecord

# Interface: OperationRecord

Defined in: [src/core/store/types.ts:106](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L106)

## Properties

<a id="activeattemptid"></a>

### activeAttemptId?

> `readonly` `optional` **activeAttemptId?**: `string`

Defined in: [src/core/store/types.ts:121](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L121)

***

<a id="ambiguous"></a>

### ambiguous?

> `readonly` `optional` **ambiguous?**: `boolean`

Defined in: [src/core/store/types.ts:122](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L122)

***

<a id="attempts"></a>

### attempts

> `readonly` **attempts**: readonly [`AttemptRecord`](AttemptRecord.md)[]

Defined in: [src/core/store/types.ts:120](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L120)

***

<a id="claim"></a>

### claim?

> `readonly` `optional` **claim?**: [`OperationClaim`](OperationClaim.md)

Defined in: [src/core/store/types.ts:124](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L124)

***

<a id="context"></a>

### context

> `readonly` **context**: [`ExecutionContext`](ExecutionContext.md)

Defined in: [src/core/store/types.ts:111](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L111)

***

<a id="createdat"></a>

### createdAt

> `readonly` **createdAt**: `number`

Defined in: [src/core/store/types.ts:126](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L126)

***

<a id="error"></a>

### error?

> `readonly` `optional` **error?**: [`SerializedError`](SerializedError.md)

Defined in: [src/core/store/types.ts:125](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L125)

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/store/types.ts:107](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L107)

***

<a id="idempotencykey"></a>

### idempotencyKey

> `readonly` **idempotencyKey**: `string`

Defined in: [src/core/store/types.ts:109](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L109)

***

<a id="intent"></a>

### intent

> `readonly` **intent**: [`StoredIntent`](StoredIntent.md)

Defined in: [src/core/store/types.ts:115](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L115)

***

<a id="intenthash"></a>

### intentHash

> `readonly` **intentHash**: `string`

Defined in: [src/core/store/types.ts:110](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L110)

***

<a id="kind"></a>

### kind

> `readonly` **kind**: `"transfer"`

Defined in: [src/core/store/types.ts:112](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L112)

***

<a id="namespace"></a>

### namespace

> `readonly` **namespace**: `string`

Defined in: [src/core/store/types.ts:108](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L108)

***

<a id="nextcheckat"></a>

### nextCheckAt?

> `readonly` `optional` **nextCheckAt?**: `number`

Defined in: [src/core/store/types.ts:128](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L128)

***

<a id="outcome"></a>

### outcome?

> `readonly` `optional` **outcome?**: `"executed"` \| `"cancelled"`

Defined in: [src/core/store/types.ts:114](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L114)

***

<a id="partialsignatures"></a>

### partialSignatures?

> `readonly` `optional` **partialSignatures?**: readonly [`SignatureBundle`](SignatureBundle.md)[]

Defined in: [src/core/store/types.ts:119](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L119)

***

<a id="reservation"></a>

### reservation?

> `readonly` `optional` **reservation?**: [`OrderingData`](../type-aliases/OrderingData.md)

Defined in: [src/core/store/types.ts:117](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L117)

***

<a id="signertickets"></a>

### signerTickets?

> `readonly` `optional` **signerTickets?**: readonly [`SignerTicket`](SignerTicket.md)[]

Defined in: [src/core/store/types.ts:118](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L118)

***

<a id="state"></a>

### state

> `readonly` **state**: [`OperationState`](../type-aliases/OperationState.md)

Defined in: [src/core/store/types.ts:113](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L113)

***

<a id="unsigned"></a>

### unsigned?

> `readonly` `optional` **unsigned?**: [`UnsignedTx`](UnsignedTx.md)

Defined in: [src/core/store/types.ts:116](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L116)

***

<a id="updatedat"></a>

### updatedAt

> `readonly` **updatedAt**: `number`

Defined in: [src/core/store/types.ts:127](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L127)

***

<a id="version"></a>

### version

> `readonly` **version**: `number`

Defined in: [src/core/store/types.ts:123](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L123)
