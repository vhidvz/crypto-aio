[crypto-aio](../../index.md) / [crypto-aio](../index.md) / EndpointCall

# Interface: EndpointCall

Defined in: [src/core/transport/types.ts:100](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L100)

Single-attempt calls against one specific endpoint (used by health probes).

## Methods

<a id="http"></a>

### http()

> **http**\<`T`\>(`request`): `Promise`\<`T`\>

Defined in: [src/core/transport/types.ts:102](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L102)

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

Defined in: [src/core/transport/types.ts:101](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L101)

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
