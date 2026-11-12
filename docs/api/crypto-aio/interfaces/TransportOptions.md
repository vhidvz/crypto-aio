[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TransportOptions

# Interface: TransportOptions

Defined in: [src/core/transport/types.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L34)

The root container's transport settings, shared by every scope and handle.

## Properties

<a id="basedelayms"></a>

### baseDelayMs?

> `readonly` `optional` **baseDelayMs?**: `number`

Defined in: [src/core/transport/types.ts:40](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L40)

Exponential backoff between attempts: its first and largest delay (default 200 and 5 000 ms).

***

<a id="degradedproofs"></a>

### degradedProofs?

> `readonly` `optional` **degradedProofs?**: `boolean`

Defined in: [src/core/transport/types.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L56)

Whether proofs go on, from fewer endpoints, once endpoints drop out of the proof
quorum's count (their probes or requests failing for three health refreshes in a
row). By default (`false`) a proof still needs `proofQuorum` endpoints, capped only by
the endpoints configured, so it waits for the dropped ones and one endpoint left can
never prove alone. `true` caps it by the endpoints still counted, down to one: proofs
keep going through an outage, but the one endpoint left decides alone.

***

<a id="failurethreshold"></a>

### failureThreshold?

> `readonly` `optional` **failureThreshold?**: `number`

Defined in: [src/core/transport/types.ts:58](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L58)

Failures in a row before an endpoint's circuit breaker opens (default 5).

***

<a id="fetch"></a>

### fetch?

> `readonly` `optional` **fetch?**: (`input`, `init?`) => `Promise`\<`Response`\>

Defined in: [src/core/transport/types.ts:36](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L36)

The `fetch` to call (default: the global one); `FakeFetch` in tests.

#### Parameters

##### input

`string` \| `URL` \| `Request`

##### init?

`RequestInit`

#### Returns

`Promise`\<`Response`\>

***

<a id="healthintervalms"></a>

### healthIntervalMs?

> `readonly` `optional` **healthIntervalMs?**: `number`

Defined in: [src/core/transport/types.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L62)

How often endpoints' identity and height are probed (default 15 000 ms).

***

<a id="maxattempts"></a>

### maxAttempts?

> `readonly` `optional` **maxAttempts?**: `number`

Defined in: [src/core/transport/types.ts:38](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L38)

Attempts per request, across endpoints (default 3).

***

<a id="maxdelayms"></a>

### maxDelayMs?

> `readonly` `optional` **maxDelayMs?**: `number`

Defined in: [src/core/transport/types.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L41)

***

<a id="maxlagblocks"></a>

### maxLagBlocks?

> `readonly` `optional` **maxLagBlocks?**: `number`

Defined in: [src/core/transport/types.ts:45](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L45)

How far behind the best known height an endpoint may be before it is lagging (default 5).

***

<a id="maxresponsebytes"></a>

### maxResponseBytes?

> `readonly` `optional` **maxResponseBytes?**: `number`

Defined in: [src/core/transport/types.ts:68](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L68)

The most bytes one answer may carry (default 64 MiB). A longer answer, by its declared
length or as it arrives, is cancelled and fails as a retryable `PROVIDER_UNAVAILABLE`,
so one endpoint can never make a call hold unbounded memory.

***

<a id="openms"></a>

### openMs?

> `readonly` `optional` **openMs?**: `number`

Defined in: [src/core/transport/types.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L60)

How long an open breaker rests its endpoint (default 30 000 ms).

***

<a id="proofquorum"></a>

### proofQuorum?

> `readonly` `optional` **proofQuorum?**: `number`

Defined in: [src/core/transport/types.ts:47](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L47)

Endpoints that must agree on a proof read (default 2), capped by the endpoints configured.

***

<a id="timeoutms"></a>

### timeoutMs?

> `readonly` `optional` **timeoutMs?**: `number`

Defined in: [src/core/transport/types.ts:43](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L43)

One request's timeout (default 15 000 ms).
