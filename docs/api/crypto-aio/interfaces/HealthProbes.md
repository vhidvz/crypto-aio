[crypto-aio](../../index.md) / [crypto-aio](../index.md) / HealthProbes

# Interface: HealthProbes

Defined in: [src/core/transport/types.ts:155](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L155)

How a transport checks each endpoint: which network it serves, and its height.

## Properties

<a id="expectedidentity"></a>

### expectedIdentity?

> `readonly` `optional` **expectedIdentity?**: `string`

Defined in: [src/core/transport/types.ts:159](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L159)

The identity the network must have; an endpoint that answers another is disabled.

***

<a id="height"></a>

### height?

> `readonly` `optional` **height?**: (`call`) => `Promise`\<`bigint`\>

Defined in: [src/core/transport/types.ts:161](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L161)

Reads the endpoint's head height.

#### Parameters

##### call

[`EndpointCall`](EndpointCall.md)

#### Returns

`Promise`\<`bigint`\>

***

<a id="identity"></a>

### identity?

> `readonly` `optional` **identity?**: (`call`) => `Promise`\<`string`\>

Defined in: [src/core/transport/types.ts:157](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L157)

Reads what identifies the endpoint's network, such as its genesis hash or chain id.

#### Parameters

##### call

[`EndpointCall`](EndpointCall.md)

#### Returns

`Promise`\<`string`\>
