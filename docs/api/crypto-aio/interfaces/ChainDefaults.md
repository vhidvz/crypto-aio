[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ChainDefaults

# Interface: ChainDefaults

Defined in: [src/core/config/types.ts:44](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L44)

## Properties

<a id="confirmations"></a>

### confirmations?

> `readonly` `optional` **confirmations?**: `number`

Defined in: [src/core/config/types.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L52)

***

<a id="indexer"></a>

### indexer?

> `readonly` `optional` **indexer?**: [`ProviderRef`](../type-aliases/ProviderRef.md) \| readonly [`ProviderRef`](../type-aliases/ProviderRef.md)[]

Defined in: [src/core/config/types.ts:48](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L48)

***

<a id="library"></a>

### library?

> `readonly` `optional` **library?**: `string`

Defined in: [src/core/config/types.ts:46](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L46)

***

<a id="maxlagblocks"></a>

### maxLagBlocks?

> `readonly` `optional` **maxLagBlocks?**: `number`

Defined in: [src/core/config/types.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L59)

R36: this chain's lag tolerance, in blocks. It wins over the root
`transport.maxLagBlocks`, which wins over the plugin network's own, which wins over
the transport's built-in default. An endpoint further behind the best known height is
lagging, and a monitor or scanner view further behind is stale.

***

<a id="network"></a>

### network?

> `readonly` `optional` **network?**: `string`

Defined in: [src/core/config/types.ts:45](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L45)

***

<a id="options"></a>

### options?

> `readonly` `optional` **options?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/config/types.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L51)

***

<a id="provider"></a>

### provider?

> `readonly` `optional` **provider?**: [`ProviderRef`](../type-aliases/ProviderRef.md) \| readonly [`ProviderRef`](../type-aliases/ProviderRef.md)[]

Defined in: [src/core/config/types.ts:47](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L47)

***

<a id="signer"></a>

### signer?

> `readonly` `optional` **signer?**: `string`

Defined in: [src/core/config/types.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L50)

***

<a id="wallet"></a>

### wallet?

> `readonly` `optional` **wallet?**: `string`

Defined in: [src/core/config/types.ts:49](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L49)
