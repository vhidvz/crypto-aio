[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OperationPatch

# Interface: OperationPatch

Defined in: [src/core/store/types.ts:226](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L226)

A change to an Operation: each field given replaces the stored one (an explicit
`undefined` changes nothing), then `clear` removes fields. Only `OPERATION_PATCH_KEYS`
and `clear` may appear.

## Properties

<a id="activeattemptid"></a>

### activeAttemptId?

> `readonly` `optional` **activeAttemptId?**: `string`

Defined in: [src/core/store/types.ts:233](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L233)

***

<a id="ambiguous"></a>

### ambiguous?

> `readonly` `optional` **ambiguous?**: `boolean`

Defined in: [src/core/store/types.ts:234](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L234)

***

<a id="clear"></a>

### clear?

> `readonly` `optional` **clear?**: readonly (`"error"` \| `"ambiguous"` \| `"outcome"` \| `"unsigned"` \| `"reservation"` \| `"signerTickets"` \| `"partialSignatures"` \| `"activeAttemptId"` \| `"nextCheckAt"`)[]

Defined in: [src/core/store/types.ts:238](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L238)

Fields to delete; applied after the values above.

***

<a id="error"></a>

### error?

> `readonly` `optional` **error?**: [`SerializedError`](SerializedError.md)

Defined in: [src/core/store/types.ts:235](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L235)

***

<a id="nextcheckat"></a>

### nextCheckAt?

> `readonly` `optional` **nextCheckAt?**: `number`

Defined in: [src/core/store/types.ts:236](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L236)

***

<a id="outcome"></a>

### outcome?

> `readonly` `optional` **outcome?**: `"executed"` \| `"cancelled"`

Defined in: [src/core/store/types.ts:228](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L228)

***

<a id="partialsignatures"></a>

### partialSignatures?

> `readonly` `optional` **partialSignatures?**: readonly [`SignatureBundle`](SignatureBundle.md)[]

Defined in: [src/core/store/types.ts:232](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L232)

***

<a id="reservation"></a>

### reservation?

> `readonly` `optional` **reservation?**: [`OrderingData`](../type-aliases/OrderingData.md)

Defined in: [src/core/store/types.ts:230](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L230)

***

<a id="signertickets"></a>

### signerTickets?

> `readonly` `optional` **signerTickets?**: readonly [`SignerTicket`](SignerTicket.md)[]

Defined in: [src/core/store/types.ts:231](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L231)

***

<a id="state"></a>

### state?

> `readonly` `optional` **state?**: [`OperationState`](../type-aliases/OperationState.md)

Defined in: [src/core/store/types.ts:227](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L227)

***

<a id="unsigned"></a>

### unsigned?

> `readonly` `optional` **unsigned?**: [`UnsignedTx`](UnsignedTx.md)

Defined in: [src/core/store/types.ts:229](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L229)
