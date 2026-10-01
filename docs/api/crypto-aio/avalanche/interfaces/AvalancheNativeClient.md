[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / AvalancheNativeClient

# Interface: AvalancheNativeClient

Defined in: [src/adapters/avalanche/driver.ts:19](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/driver.ts#L19)

## Properties

<a id="avalanche"></a>

### avalanche

> `readonly` **avalanche**: [`AvalancheSdk`](AvalancheSdk.md)

Defined in: [src/adapters/avalanche/driver.ts:24](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/driver.ts#L24)

The `@avalabs/avalanchejs` module. Its type names the members this library uses; cast
it to reach the rest of the SDK.

***

<a id="context"></a>

### context

> `readonly` **context**: [`SdkContext`](SdkContext.md)

Defined in: [src/adapters/avalanche/driver.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/driver.ts#L29)

avalanchejs's `Context` for this network and chain (network id, HRP, AVAX asset id,
this chain's id). Its fee fields are zero: read the fees from the chain.

## Methods

<a id="rpc"></a>

### rpc()

> **rpc**\<`T`\>(`method`, `params?`): `Promise`\<`T`\>

Defined in: [src/adapters/avalanche/driver.ts:31](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/driver.ts#L31)

A JSON-RPC call (e.g. `avm.getTxFee`) to the handle's node endpoints, through the transport.

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
