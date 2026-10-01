[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / drive

# Function: drive()

> **drive**\<`T`\>(`clock`, `promise`, `stepMs?`, `maxSteps?`): `Promise`\<`T`\>

Defined in: [src/testing/fake-clock.ts:75](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-clock.ts#L75)

Advances `clock` in steps until `promise` settles, then returns its value or rethrows.

## Type Parameters

### T

`T`

## Parameters

### clock

[`FakeClock`](../classes/FakeClock.md)

### promise

`Promise`\<`T`\>

### stepMs?

`number` = `10`

### maxSteps?

`number` = `10_000`

## Returns

`Promise`\<`T`\>
