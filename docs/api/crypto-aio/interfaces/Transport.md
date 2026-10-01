[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Transport

# Interface: Transport

Defined in: [src/core/transport/types.ts:116](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L116)

## Properties

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/transport/types.ts:117](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L117)

***

<a id="maxlagblocks"></a>

### maxLagBlocks

> `readonly` **maxLagBlocks**: `number`

Defined in: [src/core/transport/types.ts:149](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L149)

I2: the lag tolerance in effect (`TransportOptions.maxLagBlocks`). The driver pool
resolves it per R36: the chain's `maxLagBlocks` config, else the root
`transport.maxLagBlocks`, else the plugin network's own, else the built-in default.
An endpoint further behind is lagging, and a view further behind `highestHeight()` is
stale.

## Methods

<a id="createfetch"></a>

### createFetch()

> **createFetch**(`classify?`): (`input`, `init?`) => `Promise`\<`Response`\>

Defined in: [src/core/transport/types.ts:123](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L123)

fetch-compatible function for SDKs; only `PLACEHOLDER_ORIGIN` URLs are accepted.

#### Parameters

##### classify?

(`url`, `init`) => [`CallOptions`](CallOptions.md)

#### Returns

(`input`, `init?`) => `Promise`\<`Response`\>

***

<a id="ensurefreshhealth"></a>

### ensureFreshHealth()

> **ensureFreshHealth**(`signal?`): `Promise`\<`void`\>

Defined in: [src/core/transport/types.ts:133](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L133)

#### Parameters

##### signal?

`AbortSignal`

#### Returns

`Promise`\<`void`\>

***

<a id="hasprobes"></a>

### hasProbes()

> **hasProbes**(): `boolean`

Defined in: [src/core/transport/types.ts:131](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L131)

N6: whether any health probe (`identity` and/or `height`) has ever been configured via
`setProbes`. A transport with none configured can never mark an endpoint 'healthy' or
'lagging' — its endpoints stay 'unknown' forever, which callers like `Blockchain.ready()`
treat as acceptable only in that case.

#### Returns

`boolean`

***

<a id="highestheight"></a>

### highestHeight()

> **highestHeight**(): `bigint` \| `undefined`

Defined in: [src/core/transport/types.ts:141](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L141)

Highest verified block height: a monotonic high-water mark (the stale-view guard of
monitors and scanners). It never drops below a peak an identity-verified endpoint
reported; only a height taken before an identity probe existed stops counting once its
endpoint turns out to serve another network (R19).

#### Returns

`bigint` \| `undefined`

***

<a id="http"></a>

### http()

> **http**\<`T`\>(`request`, `options?`): `Promise`\<`T`\>

Defined in: [src/core/transport/types.ts:121](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L121)

#### Type Parameters

##### T

`T` = `unknown`

#### Parameters

##### request

[`HttpRequest`](HttpRequest.md)

##### options?

[`CallOptions`](CallOptions.md)

#### Returns

`Promise`\<`T`\>

***

<a id="refreshhealth"></a>

### refreshHealth()

> **refreshHealth**(`signal?`): `Promise`\<`void`\>

Defined in: [src/core/transport/types.ts:132](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L132)

#### Parameters

##### signal?

`AbortSignal`

#### Returns

`Promise`\<`void`\>

***

<a id="rpc"></a>

### rpc()

> **rpc**\<`T`\>(`method`, `params?`, `options?`): `Promise`\<`T`\>

Defined in: [src/core/transport/types.ts:118](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L118)

#### Type Parameters

##### T

`T` = `unknown`

#### Parameters

##### method

`string`

##### params?

`unknown`

##### options?

[`CallOptions`](CallOptions.md)

#### Returns

`Promise`\<`T`\>

***

<a id="rpcraw"></a>

### rpcRaw()

> **rpcRaw**(`payload`, `options?`): `Promise`\<`unknown`\>

Defined in: [src/core/transport/types.ts:120](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L120)

Posts an arbitrary JSON-RPC payload (single or batch) and returns the parsed body.

#### Parameters

##### payload

`unknown`

##### options?

[`CallOptions`](CallOptions.md)

#### Returns

`Promise`\<`unknown`\>

***

<a id="setprobes"></a>

### setProbes()

> **setProbes**(`probes`): `void`

Defined in: [src/core/transport/types.ts:126](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L126)

#### Parameters

##### probes

[`HealthProbes`](HealthProbes.md)

#### Returns

`void`

***

<a id="status"></a>

### status()

> **status**(): [`EndpointStatus`](EndpointStatus.md)[]

Defined in: [src/core/transport/types.ts:134](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L134)

#### Returns

[`EndpointStatus`](EndpointStatus.md)[]
