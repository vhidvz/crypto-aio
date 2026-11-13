[crypto-aio](../../index.md) / [crypto-aio](../index.md) / HandleOptions

# Interface: HandleOptions

Defined in: [src/core/config/types.ts:195](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L195)

What a handle is for (`aio.blockchain(options)`, `bc.with(overrides)`): a chain and, over
its `chains.<id>` defaults, the same fields as `ChainDefaults` but `maxLagBlocks`.
`options` stays a plain record through 1.x; each family's options are listed on its
network page.

## Properties

<a id="chain"></a>

### chain

> `readonly` **chain**: `string`

Defined in: [src/core/config/types.ts:196](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L196)

***

<a id="confirmations"></a>

### confirmations?

> `readonly` `optional` **confirmations?**: `number`

Defined in: [src/core/config/types.ts:204](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L204)

***

<a id="indexer"></a>

### indexer?

> `readonly` `optional` **indexer?**: [`ProviderRef`](../type-aliases/ProviderRef.md) \| readonly [`ProviderRef`](../type-aliases/ProviderRef.md)[]

Defined in: [src/core/config/types.ts:200](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L200)

***

<a id="library"></a>

### library?

> `readonly` `optional` **library?**: `string`

Defined in: [src/core/config/types.ts:198](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L198)

***

<a id="network"></a>

### network?

> `readonly` `optional` **network?**: `string`

Defined in: [src/core/config/types.ts:197](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L197)

***

<a id="options"></a>

### options?

> `readonly` `optional` **options?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/config/types.ts:203](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L203)

***

<a id="provider"></a>

### provider?

> `readonly` `optional` **provider?**: [`ProviderRef`](../type-aliases/ProviderRef.md) \| readonly [`ProviderRef`](../type-aliases/ProviderRef.md)[]

Defined in: [src/core/config/types.ts:199](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L199)

***

<a id="signer"></a>

### signer?

> `readonly` `optional` **signer?**: `string`

Defined in: [src/core/config/types.ts:202](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L202)

***

<a id="wallet"></a>

### wallet?

> `readonly` `optional` **wallet?**: `string`

Defined in: [src/core/config/types.ts:201](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L201)
