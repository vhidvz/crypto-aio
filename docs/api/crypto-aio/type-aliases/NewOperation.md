[crypto-aio](../../index.md) / [crypto-aio](../index.md) / NewOperation

# Type Alias: NewOperation

> **NewOperation** = `Omit`\<[`OperationRecord`](../interfaces/OperationRecord.md), `"version"` \| `"createdAt"` \| `"updatedAt"` \| `"claim"`\>

Defined in: [src/core/store/types.ts:200](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L200)

What `create` takes: a record without the store-owned fields, which the store sets
(`version` 1, `createdAt` and `updatedAt`) or leaves unset (`claim`).
