[crypto-aio](../../../index.md) / [crypto-aio/native](../index.md) / native

# Function: native()

> **native**\<`L`, `C`\>(`handle`, `library`): `Promise`\<[`NativeClientMap`](../../interfaces/NativeClientMap.md)\[`L`\]\>

Defined in: [src/native.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/native.ts#L24)

Escape hatch to the underlying SDK client. OUTSIDE the semver guarantees of crypto-aio.

The client belongs to this handle only: the driver builds it for the handle on the first
call, and later calls on the same handle return that same client. It is never the pooled
instance the drivers use, so mutating it cannot affect other handles or tenants, and it is
reachable only through this function (not through the handle, `JSON` or `inspect`). The
library name must match the handle's (`INCOMPATIBLE_SELECTION` otherwise).

The root container's `close()` releases every client handed out here; after it,
`native()` fails with `INVALID_TRANSITION`, as the handle's own methods do.

## Type Parameters

### L

`L` *extends* keyof [`NativeClientMap`](../../interfaces/NativeClientMap.md)

### C

`C` *extends* [`ChainId`](../../type-aliases/ChainId.md) = [`ChainId`](../../type-aliases/ChainId.md)

## Parameters

### handle

[`Blockchain`](../../classes/Blockchain.md)\<`C`\>

### library

`L`

## Returns

`Promise`\<[`NativeClientMap`](../../interfaces/NativeClientMap.md)\[`L`\]\>
