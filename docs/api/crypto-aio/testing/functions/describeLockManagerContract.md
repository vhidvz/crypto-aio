[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / describeLockManagerContract

# Function: describeLockManagerContract()

> **describeLockManagerContract**(`api`, `create`, `options?`): `void`

Defined in: [src/testing/contracts/locks.ts:17](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/locks.ts#L17)

The `LockManager` contract suite: run it against your lock manager, with `create`
returning a fresh one for each test, and `ttlMs` the lease length to test with (default
1 000 ms).

## Parameters

### api

[`ContractTestApi`](../interfaces/ContractTestApi.md)

### create

() => [`LockHarness`](../interfaces/LockHarness.md) \| `Promise`\<[`LockHarness`](../interfaces/LockHarness.md)\>

### options?

#### ttlMs?

`number`

## Returns

`void`
