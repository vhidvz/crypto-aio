[crypto-aio](../../index.md) / [crypto-aio](../index.md) / HealthProbes

# Interface: HealthProbes

Defined in: [src/core/transport/types.ts:96](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L96)

## Properties

<a id="expectedidentity"></a>

### expectedIdentity?

> `readonly` `optional` **expectedIdentity?**: `string`

Defined in: [src/core/transport/types.ts:98](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L98)

***

<a id="height"></a>

### height?

> `readonly` `optional` **height?**: (`call`) => `Promise`\<`bigint`\>

Defined in: [src/core/transport/types.ts:99](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L99)

#### Parameters

##### call

[`EndpointCall`](EndpointCall.md)

#### Returns

`Promise`\<`bigint`\>

***

<a id="identity"></a>

### identity?

> `readonly` `optional` **identity?**: (`call`) => `Promise`\<`string`\>

Defined in: [src/core/transport/types.ts:97](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L97)

#### Parameters

##### call

[`EndpointCall`](EndpointCall.md)

#### Returns

`Promise`\<`string`\>
