[crypto-aio](../../index.md) / [crypto-aio](../index.md) / DriverContext

# Interface: DriverContext

Defined in: [src/core/driver/types.ts:368](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L368)

M12: a factory's `create()` must call `transport.setProbes(...)` exactly once, before any
other traffic, on every `Transport` it receives here — including `indexer`, when present.
`setProbes` resets health/identity state, so calling it again later, or skipping it on one
of the two transports, leaves that transport's health checks silently unconfigured.

M10 (open; Plan 4 decides): there is no asset resolver here, and `DriverIntent` carries no
decimals.

## Properties

<a id="chain"></a>

### chain

> `readonly` **chain**: [`ChainInfo`](ChainInfo.md)

Defined in: [src/core/driver/types.ts:369](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L369)

***

<a id="clock"></a>

### clock

> `readonly` **clock**: [`Clock`](Clock.md)

Defined in: [src/core/driver/types.ts:374](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L374)

***

<a id="indexer"></a>

### indexer?

> `readonly` `optional` **indexer?**: [`Transport`](Transport.md)

Defined in: [src/core/driver/types.ts:373](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L373)

***

<a id="library"></a>

### library

> `readonly` **library**: `string`

Defined in: [src/core/driver/types.ts:371](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L371)

***

<a id="log"></a>

### log

> `readonly` **log**: [`Logger`](Logger.md)

Defined in: [src/core/driver/types.ts:375](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L375)

***

<a id="network"></a>

### network

> `readonly` **network**: [`NetworkInfo`](NetworkInfo.md)

Defined in: [src/core/driver/types.ts:370](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L370)

***

<a id="options"></a>

### options

> `readonly` **options**: `Readonly`\<`Record`\<`string`, `unknown`\>\>

Defined in: [src/core/driver/types.ts:376](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L376)

***

<a id="transport"></a>

### transport

> `readonly` **transport**: [`Transport`](Transport.md)

Defined in: [src/core/driver/types.ts:372](https://github.com/vhidvz/crypto-aio/blob/main/src/core/driver/types.ts#L372)
