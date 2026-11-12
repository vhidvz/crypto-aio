[crypto-aio](../../index.md) / [crypto-aio](../index.md) / EndpointCall

# Interface: EndpointCall

Defined in: [src/core/transport/types.ts:149](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L149)

Single-attempt calls against one specific endpoint (used by health probes).

## Methods

<a id="http"></a>

### http()

> **http**\<`T`\>(`request`): `Promise`\<`T`\>

Defined in: [src/core/transport/types.ts:151](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L151)

#### Type Parameters

<a id="t"></a>

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

Defined in: [src/core/transport/types.ts:150](https://github.com/vhidvz/crypto-aio/blob/main/src/core/transport/types.ts#L150)

#### Type Parameters

<a id="t-1"></a>

##### T

`T` = `unknown`

#### Parameters

##### method

`string`

##### params?

`unknown`

#### Returns

`Promise`\<`T`\>
