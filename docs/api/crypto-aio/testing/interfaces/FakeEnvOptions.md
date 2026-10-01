[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeEnvOptions

# Interface: FakeEnvOptions

Defined in: [src/testing/env.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L29)

## Properties

<a id="aio"></a>

### aio?

> `readonly` `optional` **aio?**: `Omit`\<[`AioOptions`](../../interfaces/AioOptions.md), `"clock"` \| `"transport"` \| `"stores"`\>

Defined in: [src/testing/env.ts:47](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L47)

Extra container options merged last. Never `clock`, `stores` or `transport` — those are
always the generation-fenced values (N3), so this type excludes them; passing any of them
would either fail to type-check or (if forced through) be silently overridden. Its
`signers` are merged by name over the default signer, and every entry is fenced (N-B).

***

<a id="chain"></a>

### chain?

> `readonly` `optional` **chain?**: `Omit`\<[`FakeChainOptions`](FakeChainOptions.md), `"ordering"` \| `"clock"`\>

Defined in: [src/testing/env.ts:36](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L36)

***

<a id="endpoints"></a>

### endpoints?

> `readonly` `optional` **endpoints?**: readonly (`string` \| `object` & [`FakeEndpointOptions`](FakeEndpointOptions.md))[]

Defined in: [src/testing/env.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L31)

***

<a id="fund"></a>

### fund?

> `readonly` `optional` **fund?**: `bigint`

Defined in: [src/testing/env.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L35)

Funds the wallet with this many base units (default 1_000_000). Use 0n for none.

***

<a id="hooks"></a>

### hooks?

> `readonly` `optional` **hooks?**: [`Hooks`](../../interfaces/Hooks.md)

Defined in: [src/testing/env.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L42)

***

<a id="lifecycle"></a>

### lifecycle?

> `readonly` `optional` **lifecycle?**: [`LifecycleOptions`](../../interfaces/LifecycleOptions.md)

Defined in: [src/testing/env.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L41)

***

<a id="ordering"></a>

### ordering?

> `readonly` `optional` **ordering?**: [`FakeOrdering`](../type-aliases/FakeOrdering.md)

Defined in: [src/testing/env.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L30)

***

<a id="signer"></a>

### signer?

> `readonly` `optional` **signer?**: [`Signer`](../../interfaces/Signer.md)

Defined in: [src/testing/env.ts:38](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L38)

***

<a id="stores"></a>

### stores?

> `readonly` `optional` **stores?**: `Partial`\<[`Stores`](../../interfaces/Stores.md)\>

Defined in: [src/testing/env.ts:39](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L39)

***

<a id="transport"></a>

### transport?

> `readonly` `optional` **transport?**: `Omit`\<[`TransportOptions`](../../interfaces/TransportOptions.md), `"fetch"`\>

Defined in: [src/testing/env.ts:40](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L40)

***

<a id="wallets"></a>

### wallets?

> `readonly` `optional` **wallets?**: `Readonly`\<`Record`\<`string`, [`WalletConfig`](../../interfaces/WalletConfig.md)\>\>

Defined in: [src/testing/env.ts:37](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L37)
