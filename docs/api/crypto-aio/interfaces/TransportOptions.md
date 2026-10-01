[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TransportOptions

# Interface: TransportOptions

Defined in: [src/core/transport/types.ts:16](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L16)

## Properties

<a id="basedelayms"></a>

### baseDelayMs?

> `readonly` `optional` **baseDelayMs?**: `number`

Defined in: [src/core/transport/types.ts:19](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L19)

***

<a id="failurethreshold"></a>

### failureThreshold?

> `readonly` `optional` **failureThreshold?**: `number`

Defined in: [src/core/transport/types.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L24)

***

<a id="fetch"></a>

### fetch?

> `readonly` `optional` **fetch?**: (`input`, `init?`) => `Promise`\<`Response`\>

Defined in: [src/core/transport/types.ts:17](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L17)

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

Defined in: [src/core/transport/types.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L26)

***

<a id="maxattempts"></a>

### maxAttempts?

> `readonly` `optional` **maxAttempts?**: `number`

Defined in: [src/core/transport/types.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L18)

***

<a id="maxdelayms"></a>

### maxDelayMs?

> `readonly` `optional` **maxDelayMs?**: `number`

Defined in: [src/core/transport/types.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L20)

***

<a id="maxlagblocks"></a>

### maxLagBlocks?

> `readonly` `optional` **maxLagBlocks?**: `number`

Defined in: [src/core/transport/types.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L22)

***

<a id="maxresponsebytes"></a>

### maxResponseBytes?

> `readonly` `optional` **maxResponseBytes?**: `number`

Defined in: [src/core/transport/types.ts:32](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L32)

The most bytes one answer may carry (default 64 MiB). A longer answer, by its declared
length or as it arrives, is cancelled and fails as a retryable `PROVIDER_UNAVAILABLE`,
so one endpoint can never make a call hold unbounded memory (lesson 20).

***

<a id="openms"></a>

### openMs?

> `readonly` `optional` **openMs?**: `number`

Defined in: [src/core/transport/types.ts:25](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L25)

***

<a id="proofquorum"></a>

### proofQuorum?

> `readonly` `optional` **proofQuorum?**: `number`

Defined in: [src/core/transport/types.ts:23](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L23)

***

<a id="timeoutms"></a>

### timeoutMs?

> `readonly` `optional` **timeoutMs?**: `number`

Defined in: [src/core/transport/types.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L21)
