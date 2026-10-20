[crypto-aio](../../index.md) / [crypto-aio](../index.md) / HealthProbes

# Interface: HealthProbes

Defined in: [src/core/transport/types.ts:105](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L105)

## Properties

<a id="expectedidentity"></a>

### expectedIdentity?

> `readonly` `optional` **expectedIdentity?**: `string`

Defined in: [src/core/transport/types.ts:107](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L107)

***

<a id="height"></a>

### height?

> `readonly` `optional` **height?**: (`call`) => `Promise`\<`bigint`\>

Defined in: [src/core/transport/types.ts:108](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L108)

#### Parameters

##### call

[`EndpointCall`](EndpointCall.md)

#### Returns

`Promise`\<`bigint`\>

***

<a id="identity"></a>

### identity?

> `readonly` `optional` **identity?**: (`call`) => `Promise`\<`string`\>

Defined in: [src/core/transport/types.ts:106](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L106)

#### Parameters

##### call

[`EndpointCall`](EndpointCall.md)

#### Returns

`Promise`\<`string`\>
