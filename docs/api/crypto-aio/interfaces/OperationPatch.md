[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OperationPatch

# Interface: OperationPatch

Defined in: [src/core/store/types.ts:151](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L151)

## Properties

<a id="activeattemptid"></a>

### activeAttemptId?

> `readonly` `optional` **activeAttemptId?**: `string`

Defined in: [src/core/store/types.ts:158](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L158)

***

<a id="ambiguous"></a>

### ambiguous?

> `readonly` `optional` **ambiguous?**: `boolean`

Defined in: [src/core/store/types.ts:159](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L159)

***

<a id="clear"></a>

### clear?

> `readonly` `optional` **clear?**: readonly (`"error"` \| `"ambiguous"` \| `"outcome"` \| `"unsigned"` \| `"reservation"` \| `"signerTickets"` \| `"partialSignatures"` \| `"activeAttemptId"` \| `"nextCheckAt"`)[]

Defined in: [src/core/store/types.ts:163](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L163)

Fields to delete; applied after the values above.

***

<a id="error"></a>

### error?

> `readonly` `optional` **error?**: [`SerializedError`](SerializedError.md)

Defined in: [src/core/store/types.ts:160](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L160)

***

<a id="nextcheckat"></a>

### nextCheckAt?

> `readonly` `optional` **nextCheckAt?**: `number`

Defined in: [src/core/store/types.ts:161](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L161)

***

<a id="outcome"></a>

### outcome?

> `readonly` `optional` **outcome?**: `"executed"` \| `"cancelled"`

Defined in: [src/core/store/types.ts:153](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L153)

***

<a id="partialsignatures"></a>

### partialSignatures?

> `readonly` `optional` **partialSignatures?**: readonly [`SignatureBundle`](SignatureBundle.md)[]

Defined in: [src/core/store/types.ts:157](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L157)

***

<a id="reservation"></a>

### reservation?

> `readonly` `optional` **reservation?**: [`OrderingData`](../type-aliases/OrderingData.md)

Defined in: [src/core/store/types.ts:155](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L155)

***

<a id="signertickets"></a>

### signerTickets?

> `readonly` `optional` **signerTickets?**: readonly [`SignerTicket`](SignerTicket.md)[]

Defined in: [src/core/store/types.ts:156](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L156)

***

<a id="state"></a>

### state?

> `readonly` `optional` **state?**: [`OperationState`](../type-aliases/OperationState.md)

Defined in: [src/core/store/types.ts:152](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L152)

***

<a id="unsigned"></a>

### unsigned?

> `readonly` `optional` **unsigned?**: [`UnsignedTx`](UnsignedTx.md)

Defined in: [src/core/store/types.ts:154](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L154)
