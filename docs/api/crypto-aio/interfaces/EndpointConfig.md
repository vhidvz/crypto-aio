[crypto-aio](../../index.md) / [crypto-aio](../index.md) / EndpointConfig

# Interface: EndpointConfig

Defined in: [src/core/transport/types.ts:6](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L6)

## Properties

<a id="headers"></a>

### headers?

> `readonly` `optional` **headers?**: `Readonly`\<`Record`\<`string`, `string` \| [`Secret`](../classes/Secret.md)\<`string`\>\>\>

Defined in: [src/core/transport/types.ts:10](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L10)

***

<a id="kind"></a>

### kind?

> `readonly` `optional` **kind?**: `"rpc"` \| `"indexer"`

Defined in: [src/core/transport/types.ts:9](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L9)

***

<a id="name"></a>

### name?

> `readonly` `optional` **name?**: `string`

Defined in: [src/core/transport/types.ts:7](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L7)

***

<a id="priority"></a>

### priority?

> `readonly` `optional` **priority?**: `number`

Defined in: [src/core/transport/types.ts:11](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L11)

***

<a id="ratelimit"></a>

### rateLimit?

> `readonly` `optional` **rateLimit?**: `object`

Defined in: [src/core/transport/types.ts:12](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L12)

#### burst?

> `readonly` `optional` **burst?**: `number`

#### rps

> `readonly` **rps**: `number`

***

<a id="timeoutms"></a>

### timeoutMs?

> `readonly` `optional` **timeoutMs?**: `number`

Defined in: [src/core/transport/types.ts:13](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L13)

***

<a id="url"></a>

### url

> `readonly` **url**: `string` \| [`Secret`](../classes/Secret.md)\<`string`\>

Defined in: [src/core/transport/types.ts:8](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L8)
