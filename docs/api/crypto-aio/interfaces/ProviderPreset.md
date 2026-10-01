[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ProviderPreset

# Interface: ProviderPreset

Defined in: [src/core/registry/providers.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L14)

Provider preset contributed by a family plugin. Endpoint URLs holding keys must be `Secret`s.

## Properties

<a id="kind"></a>

### kind

> `readonly` **kind**: `"rpc"` \| `"indexer"`

Defined in: [src/core/registry/providers.ts:16](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L16)

***

<a id="name"></a>

### name

> `readonly` **name**: `string`

Defined in: [src/core/registry/providers.ts:15](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L15)

***

<a id="production"></a>

### production?

> `readonly` `optional` **production?**: `boolean`

Defined in: [src/core/registry/providers.ts:19](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L19)

`false` for free public endpoints (logged as not for production).

***

<a id="requiresapikey"></a>

### requiresApiKey?

> `readonly` `optional` **requiresApiKey?**: `boolean`

Defined in: [src/core/registry/providers.ts:17](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L17)

## Methods

<a id="endpoints"></a>

### endpoints()

> **endpoints**(`input`): readonly [`EndpointConfig`](EndpointConfig.md)[]

Defined in: [src/core/registry/providers.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L21)

#### Parameters

##### input

[`PresetInput`](PresetInput.md)

#### Returns

readonly [`EndpointConfig`](EndpointConfig.md)[]

***

<a id="supports"></a>

### supports()

> **supports**(`chain`, `network`): `boolean`

Defined in: [src/core/registry/providers.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/registry/providers.ts#L20)

#### Parameters

##### chain

`string`

##### network

`string`

#### Returns

`boolean`
