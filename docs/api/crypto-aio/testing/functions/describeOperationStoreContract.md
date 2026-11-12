[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / describeOperationStoreContract

# Function: describeOperationStoreContract()

> **describeOperationStoreContract**(`api`, `create`): `void`

Defined in: [src/testing/contracts/operations.ts:177](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/operations.ts#L177)

The `OperationStore` contract suite: run it against your store, with `create` returning
a fresh, empty store for each test. A store that passes keeps every guarantee the
`OperationStore` documentation states.

## Parameters

### api

[`ContractTestApi`](../interfaces/ContractTestApi.md)

### create

() => [`OperationHarness`](../interfaces/OperationHarness.md) \| `Promise`\<[`OperationHarness`](../interfaces/OperationHarness.md)\>

## Returns

`void`
