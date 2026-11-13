[crypto-aio](../../index.md) / [crypto-aio](../index.md) / EndpointConfig

# Interface: EndpointConfig

Defined in: [src/core/transport/types.ts:17](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L17)

One endpoint of a provider.

## Properties

<a id="headers"></a>

### headers?

> `readonly` `optional` **headers?**: `Readonly`\<`Record`\<`string`, `string` \| [`Secret`](../classes/Secret.md)\<`string`\>\>\>

Defined in: [src/core/transport/types.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L24)

Header values that carry keys go in `secret()`.

***

<a id="kind"></a>

### kind?

> `readonly` `optional` **kind?**: `"rpc"` \| `"indexer"`

Defined in: [src/core/transport/types.ts:22](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L22)

***

<a id="name"></a>

### name?

> `readonly` `optional` **name?**: `string`

Defined in: [src/core/transport/types.ts:19](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L19)

The label errors and events use instead of the URL.

***

<a id="priority"></a>

### priority?

> `readonly` `optional` **priority?**: `number`

Defined in: [src/core/transport/types.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L26)

Order among healthy endpoints: lower first (default 0).

***

<a id="ratelimit"></a>

### rateLimit?

> `readonly` `optional` **rateLimit?**: `object`

Defined in: [src/core/transport/types.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L28)

A client-side rate limit for this endpoint, shared by its health probes.

#### burst?

> `readonly` `optional` **burst?**: `number`

#### rps

> `readonly` **rps**: `number`

***

<a id="timeoutms"></a>

### timeoutMs?

> `readonly` `optional` **timeoutMs?**: `number`

Defined in: [src/core/transport/types.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L30)

Overrides `TransportOptions.timeoutMs` for this endpoint.

***

<a id="url"></a>

### url

> `readonly` **url**: `string` \| [`Secret`](../classes/Secret.md)\<`string`\>

Defined in: [src/core/transport/types.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L21)

Wrap a URL that carries a key in `secret()`.
