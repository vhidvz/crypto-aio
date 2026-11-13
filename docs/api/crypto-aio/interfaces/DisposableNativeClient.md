[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DisposableNativeClient

# Interface: DisposableNativeClient

Defined in: [src/core/driver/types.ts:391](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L391)

A native SDK client for `crypto-aio/native` and how to release it. `close` frees
what the client holds (sockets, timers, workers); the root container's `close()` runs it
once, before closing its pooled drivers.

## Properties

<a id="client"></a>

### client

> `readonly` **client**: `unknown`

Defined in: [src/core/driver/types.ts:392](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L392)

## Methods

<a id="close"></a>

### close()?

> `optional` **close**(): `void` \| `Promise`\<`void`\>

Defined in: [src/core/driver/types.ts:393](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L393)

#### Returns

`void` \| `Promise`\<`void`\>
