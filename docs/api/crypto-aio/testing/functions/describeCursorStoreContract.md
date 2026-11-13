[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / describeCursorStoreContract

# Function: describeCursorStoreContract()

> **describeCursorStoreContract**(`api`, `create`): `void`

Defined in: [src/testing/contracts/cursors.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/cursors.ts#L14)

The `CursorStore` contract suite: run it against your store, with `create` returning a
fresh, empty store for each test.

## Parameters

### api

[`ContractTestApi`](../interfaces/ContractTestApi.md)

### create

() => [`CursorHarness`](../interfaces/CursorHarness.md) \| `Promise`\<[`CursorHarness`](../interfaces/CursorHarness.md)\>

## Returns

`void`
