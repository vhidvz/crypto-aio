[crypto-aio](../../index.md) / [crypto-aio](../index.md) / OperationClaim

# Interface: OperationClaim

Defined in: [src/core/store/types.ts:142](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L142)

A worker's claim on an Operation, held until `until` (the store's clock).

## Properties

<a id="token"></a>

### token

> `readonly` **token**: `string`

Defined in: [src/core/store/types.ts:145](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L145)

Strictly increasing per store (decimal string of a bigint).

***

<a id="until"></a>

### until

> `readonly` **until**: `number`

Defined in: [src/core/store/types.ts:146](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L146)

***

<a id="workerid"></a>

### workerId

> `readonly` **workerId**: `string`

Defined in: [src/core/store/types.ts:143](https://github.com/vhidvz/crypto-aio/blob/main/src/core/store/types.ts#L143)
