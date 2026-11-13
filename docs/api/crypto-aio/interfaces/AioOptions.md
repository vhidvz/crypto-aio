[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AioOptions

# Interface: AioOptions

Defined in: [src/core/config/types.ts:160](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L160)

The options of `new CryptoAio(options)` and `configure(options)`.

## Extends

- [`ScopeOptions`](ScopeOptions.md)

## Properties

<a id="assets"></a>

### assets?

> `readonly` `optional` **assets?**: readonly [`AssetRegistration`](AssetRegistration.md)[]

Defined in: [src/core/config/types.ts:186](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L186)

Tokens to register on this root container, as a plugin's `assets` would: their decimals
and symbol, and aliases such as `USDC`. A registered token's decimals scale its amounts
instead of what the chain says, so give each only from a source you trust; a token
whose chain gives no decimals can be sent only once they are registered.

***

<a id="chains"></a>

### chains?

> `readonly` `optional` **chains?**: `Readonly`\<`Record`\<`string`, [`ChainDefaults`](ChainDefaults.md)\>\>

Defined in: [src/core/config/types.ts:148](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L148)

Per-chain defaults, by chain id.

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`chains`](ScopeOptions.md#chains)

***

<a id="clock"></a>

### clock?

> `readonly` `optional` **clock?**: [`Clock`](Clock.md)

Defined in: [src/core/config/types.ts:177](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L177)

The time source (default: the system clock); `FakeClock` in tests.

***

<a id="env"></a>

### env?

> `readonly` `optional` **env?**: `false` \| `Readonly`\<`Record`\<`string`, `string` \| `undefined`\>\>

Defined in: [src/core/config/types.ts:166](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L166)

Environment source for routing config; `false` disables it. Default: `process.env`.

***

<a id="hooks"></a>

### hooks?

> `readonly` `optional` **hooks?**: [`Hooks`](Hooks.md)

Defined in: [src/core/config/types.ts:155](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L155)

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`hooks`](ScopeOptions.md#hooks)

***

<a id="lifecycle"></a>

### lifecycle?

> `readonly` `optional` **lifecycle?**: [`LifecycleOptions`](LifecycleOptions.md)

Defined in: [src/core/config/types.ts:156](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L156)

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`lifecycle`](ScopeOptions.md#lifecycle)

***

<a id="logger"></a>

### logger?

> `readonly` `optional` **logger?**: [`Logger`](Logger.md)

Defined in: [src/core/config/types.ts:175](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L175)

Where logs go (default: a `debug`-based logger).

***

<a id="namespace"></a>

### namespace?

> `readonly` `optional` **namespace?**: `string`

Defined in: [src/core/config/types.ts:164](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L164)

Prefixes every store key; tenants sharing a database must use distinct namespaces.

***

<a id="plugins"></a>

### plugins?

> `readonly` `optional` **plugins?**: readonly [`Plugin`](Plugin.md)[]

Defined in: [src/core/config/types.ts:179](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L179)

Root-only: extra chain families, networks, presets and tokens.

***

<a id="profile"></a>

### profile?

> `readonly` `optional` **profile?**: `string`

Defined in: [src/core/config/types.ts:168](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L168)

The environment profile to read (default: `CRYPTO_AIO_ENV`).

***

<a id="providers"></a>

### providers?

> `readonly` `optional` **providers?**: `Readonly`\<`Record`\<`string`, [`ProviderConfig`](../type-aliases/ProviderConfig.md)\>\>

Defined in: [src/core/config/types.ts:150](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L150)

Named providers.

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`providers`](ScopeOptions.md#providers)

***

<a id="signers"></a>

### signers?

> `readonly` `optional` **signers?**: `Readonly`\<`Record`\<`string`, [`Signer`](Signer.md)\>\>

Defined in: [src/core/config/types.ts:152](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L152)

Named signers, from `localSigner` or `callbackSigner`.

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`signers`](ScopeOptions.md#signers)

***

<a id="stores"></a>

### stores?

> `readonly` `optional` **stores?**: `Partial`\<[`Stores`](Stores.md)\>

Defined in: [src/core/config/types.ts:173](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L173)

The stores; each one left out is an in-memory store, which loses everything when the
process ends. Production needs all four durable, shared by every process.

***

<a id="transport"></a>

### transport?

> `readonly` `optional` **transport?**: [`TransportOptions`](TransportOptions.md)

Defined in: [src/core/config/types.ts:162](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L162)

Root-only: drivers and transports are shared by all scopes of a root container.

***

<a id="wallets"></a>

### wallets?

> `readonly` `optional` **wallets?**: `Readonly`\<`Record`\<`string`, [`WalletConfig`](WalletConfig.md)\>\>

Defined in: [src/core/config/types.ts:154](https://github.com/vhidvz/crypto-aio/blob/main/src/core/config/types.ts#L154)

Named wallets.

#### Inherited from

[`ScopeOptions`](ScopeOptions.md).[`wallets`](ScopeOptions.md#wallets)
