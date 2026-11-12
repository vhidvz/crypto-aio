[crypto-aio](../../../index.md) / [crypto-aio/testing](../index.md) / FakeEnvOptions

# Interface: FakeEnvOptions

Defined in: [src/testing/env.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L31)

How `createFakeEnv` sets up its chain, container and stores.

## Properties

<a id="aio"></a>

### aio?

> `readonly` `optional` **aio?**: `Omit`\<[`AioOptions`](../../interfaces/AioOptions.md), `"clock"` \| `"transport"` \| `"stores"`\>

Defined in: [src/testing/env.ts:59](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L59)

Extra container options merged last. Never `clock`, `stores` or `transport` — those are
always the generation-fenced values, so this type excludes them; passing any of them
would either fail to type-check or (if forced through) be silently overridden. Its
`signers` are merged by name over the default signer, and every entry is fenced.

***

<a id="chain"></a>

### chain?

> `readonly` `optional` **chain?**: `Omit`\<[`FakeChainOptions`](FakeChainOptions.md), `"ordering"` \| `"clock"`\>

Defined in: [src/testing/env.ts:40](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L40)

***

<a id="clock"></a>

### clock?

> `readonly` `optional` **clock?**: [`FakeClock`](../classes/FakeClock.md)

Defined in: [src/testing/env.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L51)

The clock of the chain, the container and its memory stores (default: a new one). Pass
it to give stores you build beforehand the same clock.

***

<a id="endpoints"></a>

### endpoints?

> `readonly` `optional` **endpoints?**: readonly (`string` \| `object` & [`FakeEndpointOptions`](FakeEndpointOptions.md))[]

Defined in: [src/testing/env.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L35)

The fake endpoints, by name, with how each misbehaves (default one endpoint).

***

<a id="fund"></a>

### fund?

> `readonly` `optional` **fund?**: `bigint`

Defined in: [src/testing/env.ts:39](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L39)

Funds the wallet with this many base units (default 1_000_000). Use 0n for none.

***

<a id="hooks"></a>

### hooks?

> `readonly` `optional` **hooks?**: [`Hooks`](../../interfaces/Hooks.md)

Defined in: [src/testing/env.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L54)

***

<a id="lifecycle"></a>

### lifecycle?

> `readonly` `optional` **lifecycle?**: [`LifecycleOptions`](../../interfaces/LifecycleOptions.md)

Defined in: [src/testing/env.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L53)

***

<a id="ordering"></a>

### ordering?

> `readonly` `optional` **ordering?**: [`FakeOrdering`](../type-aliases/FakeOrdering.md)

Defined in: [src/testing/env.ts:33](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L33)

Which fake chain to use (default `nonce`: `fakechain`).

***

<a id="signer"></a>

### signer?

> `readonly` `optional` **signer?**: [`Signer`](../../interfaces/Signer.md)

Defined in: [src/testing/env.ts:44](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L44)

The default wallet's signer (default: a fresh local signer).

***

<a id="stores"></a>

### stores?

> `readonly` `optional` **stores?**: `Partial`\<[`Stores`](../../interfaces/Stores.md)\>

Defined in: [src/testing/env.ts:46](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L46)

Stores to use instead of fresh memory stores, such as your own under test.

***

<a id="transport"></a>

### transport?

> `readonly` `optional` **transport?**: `Omit`\<[`TransportOptions`](../../interfaces/TransportOptions.md), `"fetch"`\>

Defined in: [src/testing/env.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L52)

***

<a id="wallets"></a>

### wallets?

> `readonly` `optional` **wallets?**: `Readonly`\<`Record`\<`string`, [`WalletConfig`](../../interfaces/WalletConfig.md)\>\>

Defined in: [src/testing/env.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/env.ts#L42)

Further wallets, beside the funded default one.
