[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / sampleOperation

# Function: sampleOperation()

> **sampleOperation**(`overrides?`): [`NewOperation`](../../type-aliases/NewOperation.md)

Defined in: [src/testing/contracts/operations.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/contracts/operations.ts#L28)

A new Operation for store tests, in namespace `ns` with a fresh id and idempotency key on
every call, and `overrides` over it.

## Parameters

### overrides?

`Partial`\<[`NewOperation`](../../type-aliases/NewOperation.md)\> = `{}`

## Returns

[`NewOperation`](../../type-aliases/NewOperation.md)
