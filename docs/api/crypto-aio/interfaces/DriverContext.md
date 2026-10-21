[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverContext

# Interface: DriverContext

Defined in: [src/core/driver/types.ts:408](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L408)

A factory's `create()` must call `transport.setProbes(...)` exactly once, before any
other traffic, on every `Transport` it receives here — including `indexer`, when present.
`setProbes` resets health/identity state, so calling it again later, or skipping it on one
of the two transports, leaves that transport's health checks silently unconfigured.

There is no asset resolver here, and `DriverIntent` carries no decimals: drivers work
in base units only.

## Properties

<a id="chain"></a>

### chain

> `readonly` **chain**: [`ChainInfo`](ChainInfo.md)

Defined in: [src/core/driver/types.ts:409](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L409)

***

<a id="clock"></a>

### clock

> `readonly` **clock**: [`Clock`](Clock.md)

Defined in: [src/core/driver/types.ts:414](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L414)

***

<a id="indexer"></a>

### indexer?

> `readonly` `optional` **indexer?**: [`Transport`](Transport.md)

Defined in: [src/core/driver/types.ts:413](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L413)

***

<a id="library"></a>

### library

> `readonly` **library**: `string`

Defined in: [src/core/driver/types.ts:411](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L411)

***

<a id="log"></a>

### log

> `readonly` **log**: [`Logger`](Logger.md)

Defined in: [src/core/driver/types.ts:415](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L415)

***

<a id="network"></a>

### network

> `readonly` **network**: [`NetworkInfo`](NetworkInfo.md)

Defined in: [src/core/driver/types.ts:410](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L410)

***

<a id="options"></a>

### options

> `readonly` **options**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/driver/types.ts:416](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L416)

***

<a id="transport"></a>

### transport

> `readonly` **transport**: [`Transport`](Transport.md)

Defined in: [src/core/driver/types.ts:412](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L412)
