[crypto-aio](../../index.md) / [crypto-aio](../index.md) / EndpointCall

# Interface: EndpointCall

Defined in: [src/core/transport/types.ts:91](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L91)

Single-attempt calls against one specific endpoint (used by health probes).

## Methods

<a id="http"></a>

### http()

> **http**\<`T`\>(`request`): `Promise`\<`T`\>

Defined in: [src/core/transport/types.ts:93](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L93)

#### Type Parameters

##### T

`T` = `unknown`

#### Parameters

##### request

[`HttpRequest`](HttpRequest.md)

#### Returns

`Promise`\<`T`\>

***

<a id="rpc"></a>

### rpc()

> **rpc**\<`T`\>(`method`, `params?`): `Promise`\<`T`\>

Defined in: [src/core/transport/types.ts:92](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L92)

#### Type Parameters

##### T

`T` = `unknown`

#### Parameters

##### method

`string`

##### params?

`unknown`

#### Returns

`Promise`\<`T`\>
