[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / describeSequenceStoreContract

# Function: describeSequenceStoreContract()

> **describeSequenceStoreContract**(`api`, `create`): `void`

Defined in: [src/testing/contracts/sequences.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/sequences.ts#L14)

The `SequenceStore` contract suite: run it against your store, with `create` returning a
fresh, empty store for each test.

## Parameters

### api

[`ContractTestApi`](../interfaces/ContractTestApi.md)

### create

() => [`SequenceHarness`](../interfaces/SequenceHarness.md) \| `Promise`\<[`SequenceHarness`](../interfaces/SequenceHarness.md)\>

## Returns

`void`
