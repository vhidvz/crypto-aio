[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / OperationHarness

# Interface: OperationHarness

Defined in: [src/testing/contracts/operations.ts:157](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/operations.ts#L157)

## Properties

<a id="operations"></a>

### operations

> `readonly` **operations**: [`OperationStore`](../../interfaces/OperationStore.md)

Defined in: [src/testing/contracts/operations.ts:158](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/operations.ts#L158)

## Methods

<a id="advance"></a>

### advance()

> **advance**(`ms`): `Promise`\<`void`\>

Defined in: [src/testing/contracts/operations.ts:160](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/operations.ts#L160)

Moves the store's notion of time forward (a fake clock, or a real sleep).

#### Parameters

##### ms

`number`

#### Returns

`Promise`\<`void`\>
