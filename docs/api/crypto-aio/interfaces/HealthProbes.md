[crypto-aio](../../index.md) / [crypto-aio](../index.md) / HealthProbes

# Interface: HealthProbes

Defined in: [src/core/transport/types.ts:111](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L111)

## Properties

<a id="expectedidentity"></a>

### expectedIdentity?

> `readonly` `optional` **expectedIdentity?**: `string`

Defined in: [src/core/transport/types.ts:113](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L113)

***

<a id="height"></a>

### height?

> `readonly` `optional` **height?**: (`call`) => `Promise`\<`bigint`\>

Defined in: [src/core/transport/types.ts:114](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L114)

#### Parameters

##### call

[`EndpointCall`](EndpointCall.md)

#### Returns

`Promise`\<`bigint`\>

***

<a id="identity"></a>

### identity?

> `readonly` `optional` **identity?**: (`call`) => `Promise`\<`string`\>

Defined in: [src/core/transport/types.ts:112](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L112)

#### Parameters

##### call

[`EndpointCall`](EndpointCall.md)

#### Returns

`Promise`\<`string`\>
