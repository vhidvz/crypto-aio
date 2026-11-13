[crypto-aio](../../../index.md) / [crypto-aio/avalanche](../index.md) / AvalancheNativeClient

# Interface: AvalancheNativeClient

Defined in: [src/adapters/avalanche/driver.ts:23](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/driver.ts#L23)

What `native(bc, '@avalabs/avalanchejs')` hands out. It mirrors the SDK, so it is outside
semver: a new avalanchejs line may change it in a minor release.

## Properties

<a id="avalanche"></a>

### avalanche

> `readonly` **avalanche**: [`AvalancheSdk`](AvalancheSdk.md)

Defined in: [src/adapters/avalanche/driver.ts:28](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/driver.ts#L28)

The `@avalabs/avalanchejs` module. Its type names the members this library uses; cast
it to reach the rest of the SDK.

***

<a id="context"></a>

### context

> `readonly` **context**: [`SdkContext`](SdkContext.md)

Defined in: [src/adapters/avalanche/driver.ts:33](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/driver.ts#L33)

avalanchejs's `Context` for this network and chain (network id, HRP, AVAX asset id,
this chain's id). Its fee fields are zero: read the fees from the chain.

## Methods

<a id="rpc"></a>

### rpc()

> **rpc**\<`T`\>(`method`, `params?`): `Promise`\<`T`\>

Defined in: [src/adapters/avalanche/driver.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/driver.ts#L35)

A JSON-RPC call (e.g. `avm.getTxFee`) to the handle's node endpoints, through the transport.

#### Type Parameters

<a id="t"></a>

##### T

`T` = `unknown`

#### Parameters

##### method

`string`

##### params?

`unknown`

#### Returns

`Promise`\<`T`\>
