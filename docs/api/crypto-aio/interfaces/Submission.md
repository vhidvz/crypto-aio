[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Submission

# Interface: Submission

Defined in: [src/core/lifecycle/views.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L50)

Result of transfer/submitSignatures/rebroadcast: the Operation view plus its active Attempt.

## Extends

- [`OperationView`](OperationView.md)

## Properties

<a id="activeattempt"></a>

### activeAttempt?

> `readonly` `optional` **activeAttempt?**: [`AttemptRef`](AttemptRef.md)

Defined in: [src/core/lifecycle/views.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L32)

#### Inherited from

[`OperationView`](OperationView.md).[`activeAttempt`](OperationView.md#activeattempt)

***

<a id="ambiguous"></a>

### ambiguous

> `readonly` **ambiguous**: `boolean`

Defined in: [src/core/lifecycle/views.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L30)

#### Inherited from

[`OperationView`](OperationView.md).[`ambiguous`](OperationView.md#ambiguous)

***

<a id="attempt"></a>

### attempt?

> `readonly` `optional` **attempt?**: [`AttemptRef`](AttemptRef.md)

Defined in: [src/core/lifecycle/views.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L52)

***

<a id="attempts"></a>

### attempts

> `readonly` **attempts**: readonly [`AttemptView`](AttemptView.md)[]

Defined in: [src/core/lifecycle/views.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L31)

#### Inherited from

[`OperationView`](OperationView.md).[`attempts`](OperationView.md#attempts)

***

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/lifecycle/views.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L26)

#### Inherited from

[`OperationView`](OperationView.md).[`chain`](OperationView.md#chain)

***

<a id="createdat"></a>

### createdAt

> `readonly` **createdAt**: `number`

Defined in: [src/core/lifecycle/views.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L34)

#### Inherited from

[`OperationView`](OperationView.md).[`createdAt`](OperationView.md#createdat)

***

<a id="error"></a>

### error?

> `readonly` `optional` **error?**: [`SerializedError`](SerializedError.md)

Defined in: [src/core/lifecycle/views.ts:33](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L33)

#### Inherited from

[`OperationView`](OperationView.md).[`error`](OperationView.md#error)

***

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/lifecycle/views.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L24)

#### Inherited from

[`OperationView`](OperationView.md).[`id`](OperationView.md#id)

***

<a id="idempotencykey"></a>

### idempotencyKey

> `readonly` **idempotencyKey**: `string`

Defined in: [src/core/lifecycle/views.ts:25](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L25)

#### Inherited from

[`OperationView`](OperationView.md).[`idempotencyKey`](OperationView.md#idempotencykey)

***

<a id="network"></a>

### network

> `readonly` **network**: `string`

Defined in: [src/core/lifecycle/views.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L27)

#### Inherited from

[`OperationView`](OperationView.md).[`network`](OperationView.md#network)

***

<a id="operationid"></a>

### operationId

> `readonly` **operationId**: `string`

Defined in: [src/core/lifecycle/views.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L51)

***

<a id="outcome"></a>

### outcome?

> `readonly` `optional` **outcome?**: `"executed"` \| `"cancelled"`

Defined in: [src/core/lifecycle/views.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L29)

#### Inherited from

[`OperationView`](OperationView.md).[`outcome`](OperationView.md#outcome)

***

<a id="state"></a>

### state

> `readonly` **state**: [`OperationState`](../type-aliases/OperationState.md)

Defined in: [src/core/lifecycle/views.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L28)

#### Inherited from

[`OperationView`](OperationView.md).[`state`](OperationView.md#state)

***

<a id="updatedat"></a>

### updatedAt

> `readonly` **updatedAt**: `number`

Defined in: [src/core/lifecycle/views.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L35)

#### Inherited from

[`OperationView`](OperationView.md).[`updatedAt`](OperationView.md#updatedat)

## Methods

<a id="wait"></a>

### wait()

> **wait**(`options?`): `Promise`\<[`ConfirmationResult`](ConfirmationResult.md)\>

Defined in: [src/core/lifecycle/views.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/views.ts#L54)

Shorthand for `bc.waitForConfirmation(operationId, options)`.

#### Parameters

##### options?

[`WaitOptions`](WaitOptions.md)

#### Returns

`Promise`\<[`ConfirmationResult`](ConfirmationResult.md)\>
