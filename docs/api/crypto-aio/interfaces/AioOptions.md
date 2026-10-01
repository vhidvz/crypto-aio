[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AioOptions

# Interface: AioOptions

Defined in: [src/core/config/types.ts:103](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L103)

## Extends

- [`ScopeOptions`](ScopeOptions.md)

## Properties

<a id="chains"></a>

### chains?

> `readonly` `optional` **chains?**: `Readonly`\<`Record`\<`string`, [`ChainDefaults`](ChainDefaults.md)\>\>

Defined in: [src/core/config/types.ts:95](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L95)

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`chains`](ScopeOptions.md#chains)

***

<a id="clock"></a>

### clock?

> `readonly` `optional` **clock?**: [`Clock`](Clock.md)

Defined in: [src/core/config/types.ts:113](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L113)

***

<a id="env"></a>

### env?

> `readonly` `optional` **env?**: `false` \| `Readonly`\<`Record`\<`string`, `string` \| `undefined`\>\>

Defined in: [src/core/config/types.ts:109](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L109)

Environment source for routing config; `false` disables it. Default: `process.env`.

***

<a id="hooks"></a>

### hooks?

> `readonly` `optional` **hooks?**: [`Hooks`](Hooks.md)

Defined in: [src/core/config/types.ts:99](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L99)

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`hooks`](ScopeOptions.md#hooks)

***

<a id="lifecycle"></a>

### lifecycle?

> `readonly` `optional` **lifecycle?**: [`LifecycleOptions`](LifecycleOptions.md)

Defined in: [src/core/config/types.ts:100](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L100)

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`lifecycle`](ScopeOptions.md#lifecycle)

***

<a id="logger"></a>

### logger?

> `readonly` `optional` **logger?**: [`Logger`](Logger.md)

Defined in: [src/core/config/types.ts:112](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L112)

***

<a id="namespace"></a>

### namespace?

> `readonly` `optional` **namespace?**: `string`

Defined in: [src/core/config/types.ts:107](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L107)

Prefixes every store key; tenants sharing a database must use distinct namespaces.

***

<a id="plugins"></a>

### plugins?

> `readonly` `optional` **plugins?**: readonly [`Plugin`](Plugin.md)[]

Defined in: [src/core/config/types.ts:114](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L114)

***

<a id="profile"></a>

### profile?

> `readonly` `optional` **profile?**: `string`

Defined in: [src/core/config/types.ts:110](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L110)

***

<a id="providers"></a>

### providers?

> `readonly` `optional` **providers?**: `Readonly`\<`Record`\<`string`, [`ProviderConfig`](../type-aliases/ProviderConfig.md)\>\>

Defined in: [src/core/config/types.ts:96](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L96)

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`providers`](ScopeOptions.md#providers)

***

<a id="signers"></a>

### signers?

> `readonly` `optional` **signers?**: `Readonly`\<`Record`\<`string`, [`Signer`](Signer.md)\>\>

Defined in: [src/core/config/types.ts:97](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L97)

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`signers`](ScopeOptions.md#signers)

***

<a id="stores"></a>

### stores?

> `readonly` `optional` **stores?**: `Partial`\<[`Stores`](Stores.md)\>

Defined in: [src/core/config/types.ts:111](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L111)

***

<a id="transport"></a>

### transport?

> `readonly` `optional` **transport?**: [`TransportOptions`](TransportOptions.md)

Defined in: [src/core/config/types.ts:105](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L105)

Root-only: drivers and transports are shared by all scopes of a root container.

***

<a id="wallets"></a>

### wallets?

> `readonly` `optional` **wallets?**: `Readonly`\<`Record`\<`string`, [`WalletConfig`](WalletConfig.md)\>\>

Defined in: [src/core/config/types.ts:98](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L98)

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`wallets`](ScopeOptions.md#wallets)
