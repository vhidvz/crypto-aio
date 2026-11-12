[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverContext

# Interface: DriverContext

Defined in: [src/core/driver/types.ts:505](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L505)

A factory's `create()` must call `transport.setProbes(...)` exactly once, before any
other traffic, on every `Transport` it receives here — including `indexer`, when present.
`setProbes` resets health/identity state, so calling it again later, or skipping it on one
of the two transports, leaves that transport's health checks silently unconfigured.

There is no asset resolver here, and `DriverIntent` carries no decimals: drivers work
in base units only (`BuildContext.decimals` says how the core scaled them).

## Properties

<a id="chain"></a>

### chain

> `readonly` **chain**: [`ChainInfo`](ChainInfo.md)

Defined in: [src/core/driver/types.ts:506](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L506)

***

<a id="clock"></a>

### clock

> `readonly` **clock**: [`Clock`](Clock.md)

Defined in: [src/core/driver/types.ts:514](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L514)

***

<a id="indexer"></a>

### indexer?

> `readonly` `optional` **indexer?**: [`Transport`](Transport.md)

Defined in: [src/core/driver/types.ts:513](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L513)

The `indexer` endpoints, when the handle has any.

***

<a id="library"></a>

### library

> `readonly` **library**: `string`

Defined in: [src/core/driver/types.ts:509](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L509)

The SDK library the handle selected, such as `ethers`.

***

<a id="log"></a>

### log

> `readonly` **log**: [`Logger`](Logger.md)

Defined in: [src/core/driver/types.ts:515](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L515)

***

<a id="network"></a>

### network

> `readonly` **network**: [`NetworkInfo`](NetworkInfo.md)

Defined in: [src/core/driver/types.ts:507](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L507)

***

<a id="options"></a>

### options

> `readonly` **options**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/driver/types.ts:517](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L517)

The driver options: the chain config's `options` with the handle's over them.

***

<a id="transport"></a>

### transport

> `readonly` **transport**: [`Transport`](Transport.md)

Defined in: [src/core/driver/types.ts:511](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L511)

The `provider` endpoints.
