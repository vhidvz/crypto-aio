[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OperationView

# Interface: OperationView

Defined in: [src/core/lifecycle/views.ts:23](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L23)

Public view of an Operation: ids and states only (no payloads, raw transactions or intents).

## Extended by

- [`Submission`](Submission.md)

## Properties

<a id="activeattempt"></a>

### activeAttempt?

> `readonly` `optional` **activeAttempt?**: [`AttemptRef`](AttemptRef.md)

Defined in: [src/core/lifecycle/views.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L32)

***

<a id="ambiguous"></a>

### ambiguous

> `readonly` **ambiguous**: `boolean`

Defined in: [src/core/lifecycle/views.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L30)

***

<a id="attempts"></a>

### attempts

> `readonly` **attempts**: readonly [`AttemptView`](AttemptView.md)[]

Defined in: [src/core/lifecycle/views.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L31)

***

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/lifecycle/views.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L26)

***

<a id="createdat"></a>

### createdAt

> `readonly` **createdAt**: `number`

Defined in: [src/core/lifecycle/views.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L34)

***

<a id="error"></a>

### error?

> `readonly` `optional` **error?**: [`SerializedError`](SerializedError.md)

Defined in: [src/core/lifecycle/views.ts:33](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L33)

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/lifecycle/views.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L24)

***

<a id="idempotencykey"></a>

### idempotencyKey

> `readonly` **idempotencyKey**: `string`

Defined in: [src/core/lifecycle/views.ts:25](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L25)

***

<a id="network"></a>

### network

> `readonly` **network**: `string`

Defined in: [src/core/lifecycle/views.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L27)

***

<a id="outcome"></a>

### outcome?

> `readonly` `optional` **outcome?**: `"executed"` \| `"cancelled"`

Defined in: [src/core/lifecycle/views.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L29)

***

<a id="state"></a>

### state

> `readonly` **state**: [`OperationState`](../type-aliases/OperationState.md)

Defined in: [src/core/lifecycle/views.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L28)

***

<a id="updatedat"></a>

### updatedAt

> `readonly` **updatedAt**: `number`

Defined in: [src/core/lifecycle/views.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L35)
