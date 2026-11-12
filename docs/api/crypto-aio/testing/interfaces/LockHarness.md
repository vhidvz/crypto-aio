[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / LockHarness

# Interface: LockHarness

Defined in: [src/testing/contracts/locks.ts:6](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/locks.ts#L6)

What `describeLockManagerContract` tests: a fresh lock manager and its clock.

## Properties

<a id="locks"></a>

### locks

> `readonly` **locks**: [`LockManager`](../../interfaces/LockManager.md)

Defined in: [src/testing/contracts/locks.ts:7](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/locks.ts#L7)

## Methods

<a id="advance"></a>

### advance()

> **advance**(`ms`): `Promise`\<`void`\>

Defined in: [src/testing/contracts/locks.ts:9](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/locks.ts#L9)

Moves the store's notion of time forward (a fake clock, or a real sleep).

#### Parameters

##### ms

`number`

#### Returns

`Promise`\<`void`\>
