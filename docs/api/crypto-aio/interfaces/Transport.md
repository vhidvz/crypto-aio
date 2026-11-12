[crypto-aio](../../index.md) / [crypto-aio](../index.md) / Transport

# Interface: Transport

Defined in: [src/core/transport/types.ts:194](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L194)

The endpoints of one provider set, with failover, retries, rate limits, circuit
breakers, health probes and quorum reads. A driver gets one per provider set
(`DriverContext.transport` and `indexer`) and makes every network call through it.

## Properties

<a id="id"></a>

### id

> `readonly` **id**: `string`

Defined in: [src/core/transport/types.ts:196](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L196)

An id for events and logs, independent of the endpoints' URLs.

***

<a id="maxlagblocks"></a>

### maxLagBlocks

> `readonly` **maxLagBlocks**: `number`

Defined in: [src/core/transport/types.ts:236](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L236)

The lag tolerance in effect (`TransportOptions.maxLagBlocks`). The driver pool
resolves it in this order: the chain's `maxLagBlocks` config, else the root
`transport.maxLagBlocks`, else the plugin network's own, else the built-in default.
An endpoint further behind is lagging, and a view further behind `highestHeight()` is
stale.

## Methods

<a id="createfetch"></a>

### createFetch()

> **createFetch**(`classify?`): (`input`, `init?`) => `Promise`\<`Response`\>

Defined in: [src/core/transport/types.ts:204](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L204)

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

Defined in: [src/core/transport/types.ts:217](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L217)

Probes the endpoints unless a refresh ran within `healthIntervalMs`.

#### Parameters

##### signal?

`AbortSignal`

#### Returns

`Promise`\<`void`\>

***

<a id="hasprobes"></a>

### hasProbes()

> **hasProbes**(): `boolean`

Defined in: [src/core/transport/types.ts:213](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L213)

Whether any health probe (`identity` and/or `height`) has ever been configured via
`setProbes`. A transport with none configured can never mark an endpoint 'healthy' or
'lagging' — its endpoints stay 'unknown' forever, which callers like `Blockchain.ready()`
treat as acceptable only in that case.

#### Returns

`boolean`

***

<a id="highestheight"></a>

### highestHeight()

> **highestHeight**(): `bigint` \| `undefined`

Defined in: [src/core/transport/types.ts:228](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L228)

Highest verified block height: a high-water mark (the stale-view guard of monitors
and scanners). It drops in two cases only: a height taken before an identity probe
existed stops counting once its endpoint turns out to serve another network, and a
peak that no verified endpoint comes within `maxLagBlocks` of for three health
refreshes in a row falls back to the verified best, so one forged far-future head
cannot keep every view stale until restart.

#### Returns

`bigint` \| `undefined`

***

<a id="http"></a>

### http()

> **http**\<`T`\>(`request`, `options?`): `Promise`\<`T`\>

Defined in: [src/core/transport/types.ts:202](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L202)

One REST request.

#### Type Parameters

<a id="t"></a>

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

Defined in: [src/core/transport/types.ts:215](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L215)

Probes every endpoint now.

#### Parameters

##### signal?

`AbortSignal`

#### Returns

`Promise`\<`void`\>

***

<a id="rpc"></a>

### rpc()

> **rpc**\<`T`\>(`method`, `params?`, `options?`): `Promise`\<`T`\>

Defined in: [src/core/transport/types.ts:198](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L198)

One JSON-RPC call.

#### Type Parameters

<a id="t-1"></a>

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

Defined in: [src/core/transport/types.ts:200](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L200)

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

Defined in: [src/core/transport/types.ts:208](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L208)

Sets the health probes; a driver factory calls it once, before any other traffic.

#### Parameters

##### probes

[`HealthProbes`](HealthProbes.md)

#### Returns

`void`

***

<a id="status"></a>

### status()

> **status**(): [`EndpointStatus`](EndpointStatus.md)[]

Defined in: [src/core/transport/types.ts:219](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L219)

Every endpoint's current state.

#### Returns

[`EndpointStatus`](EndpointStatus.md)[]
