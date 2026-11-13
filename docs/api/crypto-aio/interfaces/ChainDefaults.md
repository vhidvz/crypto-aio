[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ChainDefaults

# Interface: ChainDefaults

Defined in: [src/core/config/types.ts:70](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L70)

Per-chain defaults (`chains.<id>`); a handle can set the same fields but `maxLagBlocks`.

## Properties

<a id="confirmations"></a>

### confirmations?

> `readonly` `optional` **confirmations?**: `number`

Defined in: [src/core/config/types.ts:86](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L86)

The default target of `waitForConfirmation`.

***

<a id="indexer"></a>

### indexer?

> `readonly` `optional` **indexer?**: [`ProviderRef`](../type-aliases/ProviderRef.md) \| readonly [`ProviderRef`](../type-aliases/ProviderRef.md)[]

Defined in: [src/core/config/types.ts:78](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L78)

The indexer providers, for the families that read one.

***

<a id="library"></a>

### library?

> `readonly` `optional` **library?**: `string`

Defined in: [src/core/config/types.ts:74](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L74)

The SDK library, such as `ethers`; defaults to the chain's first.

***

<a id="maxlagblocks"></a>

### maxLagBlocks?

> `readonly` `optional` **maxLagBlocks?**: `number`

Defined in: [src/core/config/types.ts:93](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L93)

This chain's lag tolerance, in blocks. It wins over the root
`transport.maxLagBlocks`, which wins over the plugin network's own, which wins over
the transport's built-in default. An endpoint further behind the best known height is
lagging, and a monitor or scanner view further behind is stale.

***

<a id="network"></a>

### network?

> `readonly` `optional` **network?**: `string`

Defined in: [src/core/config/types.ts:72](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L72)

Defaults to the chain's default network.

***

<a id="options"></a>

### options?

> `readonly` `optional` **options?**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/config/types.ts:84](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L84)

The family's own options; a family refuses keys it does not know (`CONFIG_INVALID`).

***

<a id="provider"></a>

### provider?

> `readonly` `optional` **provider?**: [`ProviderRef`](../type-aliases/ProviderRef.md) \| readonly [`ProviderRef`](../type-aliases/ProviderRef.md)[]

Defined in: [src/core/config/types.ts:76](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L76)

Several providers fail over and cross-check proofs.

***

<a id="signer"></a>

### signer?

> `readonly` `optional` **signer?**: `string`

Defined in: [src/core/config/types.ts:82](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L82)

Overrides the wallet's signer.

***

<a id="wallet"></a>

### wallet?

> `readonly` `optional` **wallet?**: `string`

Defined in: [src/core/config/types.ts:80](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L80)

The wallet that sends.
