[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AioOptions

# Interface: AioOptions

Defined in: [src/core/config/types.ts:111](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L111)

## Extends

- [`ScopeOptions`](ScopeOptions.md)

## Properties

<a id="assets"></a>

### assets?

> `readonly` `optional` **assets?**: readonly [`AssetRegistration`](AssetRegistration.md)[]

Defined in: [src/core/config/types.ts:129](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L129)

Tokens to register on this root container, as a plugin's `assets` would: their decimals
and symbol, and aliases such as `USDC`. A registered token's decimals scale its amounts
instead of what the chain says, so give each only from a source you trust; a token
whose chain gives no decimals can be sent only once they are registered.

***

<a id="chains"></a>

### chains?

> `readonly` `optional` **chains?**: `Readonly`\<`Record`\<`string`, [`ChainDefaults`](ChainDefaults.md)\>\>

Defined in: [src/core/config/types.ts:103](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L103)

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`chains`](ScopeOptions.md#chains)

***

<a id="clock"></a>

### clock?

> `readonly` `optional` **clock?**: [`Clock`](Clock.md)

Defined in: [src/core/config/types.ts:121](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L121)

***

<a id="env"></a>

### env?

> `readonly` `optional` **env?**: `false` \| `Readonly`\<`Record`\<`string`, `string` \| `undefined`\>\>

Defined in: [src/core/config/types.ts:117](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L117)

Environment source for routing config; `false` disables it. Default: `process.env`.

***

<a id="hooks"></a>

### hooks?

> `readonly` `optional` **hooks?**: [`Hooks`](Hooks.md)

Defined in: [src/core/config/types.ts:107](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L107)

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`hooks`](ScopeOptions.md#hooks)

***

<a id="lifecycle"></a>

### lifecycle?

> `readonly` `optional` **lifecycle?**: [`LifecycleOptions`](LifecycleOptions.md)

Defined in: [src/core/config/types.ts:108](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L108)

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`lifecycle`](ScopeOptions.md#lifecycle)

***

<a id="logger"></a>

### logger?

> `readonly` `optional` **logger?**: [`Logger`](Logger.md)

Defined in: [src/core/config/types.ts:120](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L120)

***

<a id="namespace"></a>

### namespace?

> `readonly` `optional` **namespace?**: `string`

Defined in: [src/core/config/types.ts:115](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L115)

Prefixes every store key; tenants sharing a database must use distinct namespaces.

***

<a id="plugins"></a>

### plugins?

> `readonly` `optional` **plugins?**: readonly [`Plugin`](Plugin.md)[]

Defined in: [src/core/config/types.ts:122](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L122)

***

<a id="profile"></a>

### profile?

> `readonly` `optional` **profile?**: `string`

Defined in: [src/core/config/types.ts:118](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L118)

***

<a id="providers"></a>

### providers?

> `readonly` `optional` **providers?**: `Readonly`\<`Record`\<`string`, [`ProviderConfig`](../type-aliases/ProviderConfig.md)\>\>

Defined in: [src/core/config/types.ts:104](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L104)

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`providers`](ScopeOptions.md#providers)

***

<a id="signers"></a>

### signers?

> `readonly` `optional` **signers?**: `Readonly`\<`Record`\<`string`, [`Signer`](Signer.md)\>\>

Defined in: [src/core/config/types.ts:105](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L105)

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`signers`](ScopeOptions.md#signers)

***

<a id="stores"></a>

### stores?

> `readonly` `optional` **stores?**: `Partial`\<[`Stores`](Stores.md)\>

Defined in: [src/core/config/types.ts:119](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L119)

***

<a id="transport"></a>

### transport?

> `readonly` `optional` **transport?**: [`TransportOptions`](TransportOptions.md)

Defined in: [src/core/config/types.ts:113](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L113)

Root-only: drivers and transports are shared by all scopes of a root container.

***

<a id="wallets"></a>

### wallets?

> `readonly` `optional` **wallets?**: `Readonly`\<`Record`\<`string`, [`WalletConfig`](WalletConfig.md)\>\>

Defined in: [src/core/config/types.ts:106](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L106)

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`wallets`](ScopeOptions.md#wallets)
