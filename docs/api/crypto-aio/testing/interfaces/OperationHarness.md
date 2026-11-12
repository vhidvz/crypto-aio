[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / OperationHarness

# Interface: OperationHarness

Defined in: [src/testing/contracts/operations.ts:166](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/operations.ts#L166)

What `describeOperationStoreContract` tests: a fresh store and its clock.

## Properties

<a id="operations"></a>

### operations

> `readonly` **operations**: [`OperationStore`](../../interfaces/OperationStore.md)

Defined in: [src/testing/contracts/operations.ts:167](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/operations.ts#L167)

## Methods

<a id="advance"></a>

### advance()

> **advance**(`ms`): `Promise`\<`void`\>

Defined in: [src/testing/contracts/operations.ts:169](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/operations.ts#L169)

Moves the store's notion of time forward (a fake clock, or a real sleep).

#### Parameters

##### ms

`number`

#### Returns

`Promise`\<`void`\>
