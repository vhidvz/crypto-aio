[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AssetRegistration

# Interface: AssetRegistration

Defined in: [src/core/registry/assets.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/assets.ts#L18)

A token to register (`AioOptions.assets`, `Plugin.assets`): its metadata, which scales
its amounts instead of what the chain says, and aliases such as `USDC` (1 to 32 of
`A-Z`, `0-9`, `.`, `_` and `-`).

## Properties

<a id="aliases"></a>

### aliases?

> `readonly` `optional` **aliases?**: readonly `string`[]

Defined in: [src/core/registry/assets.ts:23](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/assets.ts#L23)

***

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/registry/assets.ts:19](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/assets.ts#L19)

***

<a id="metadata"></a>

### metadata

> `readonly` **metadata**: [`AssetMetadata`](AssetMetadata.md)

Defined in: [src/core/registry/assets.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/assets.ts#L22)

***

<a id="network"></a>

### network

> `readonly` **network**: `string`

Defined in: [src/core/registry/assets.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/assets.ts#L20)

***

<a id="ref"></a>

### ref

> `readonly` **ref**: [`AssetRef`](../type-aliases/AssetRef.md)

Defined in: [src/core/registry/assets.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/assets.ts#L21)
