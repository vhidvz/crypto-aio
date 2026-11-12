[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ScopeOptions

# Interface: ScopeOptions

Defined in: [src/core/config/types.ts:146](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L146)

What `aio.scope(overrides)` can override, over its parent's options.

## Extended by

- [`AioOptions`](AioOptions.md)

## Properties

<a id="chains"></a>

### chains?

> `readonly` `optional` **chains?**: `Readonly`\<`Record`\<`string`, [`ChainDefaults`](ChainDefaults.md)\>\>

Defined in: [src/core/config/types.ts:148](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L148)

Per-chain defaults, by chain id.

***

<a id="hooks"></a>

### hooks?

> `readonly` `optional` **hooks?**: [`Hooks`](Hooks.md)

Defined in: [src/core/config/types.ts:155](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L155)

***

<a id="lifecycle"></a>

### lifecycle?

> `readonly` `optional` **lifecycle?**: [`LifecycleOptions`](LifecycleOptions.md)

Defined in: [src/core/config/types.ts:156](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L156)

***

<a id="providers"></a>

### providers?

> `readonly` `optional` **providers?**: `Readonly`\<`Record`\<`string`, [`ProviderConfig`](../type-aliases/ProviderConfig.md)\>\>

Defined in: [src/core/config/types.ts:150](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L150)

Named providers.

***

<a id="signers"></a>

### signers?

> `readonly` `optional` **signers?**: `Readonly`\<`Record`\<`string`, [`Signer`](Signer.md)\>\>

Defined in: [src/core/config/types.ts:152](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L152)

Named signers, from `localSigner` or `callbackSigner`.

***

<a id="wallets"></a>

### wallets?

> `readonly` `optional` **wallets?**: `Readonly`\<`Record`\<`string`, [`WalletConfig`](WalletConfig.md)\>\>

Defined in: [src/core/config/types.ts:154](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L154)

Named wallets.
